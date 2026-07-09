import { getSupabaseAdminConfig } from "../supabaseAdmin";

/**
 * 30-day account-deletion grace schedule, stored in the Supabase auth
 * user's `app_metadata.account_deletion` (jsonb — zero schema
 * migration).
 *
 * app_metadata, NOT user_metadata — this is load-bearing: GoTrue lets a
 * signed-in user (or anyone holding their session token) rewrite their
 * OWN user_metadata via the self-service PUT /auth/v1/user. A hijacker
 * could plant a past-dated purge_at there and the next cron run would
 * purge immediately — defeating the exact "hacked account has 30 days
 * to recover" rationale G locked 2026-07-08. app_metadata is writable
 * only through the admin API with the service-role key.
 *
 * Lifecycle: voice confirm writes the schedule → the daily
 * finalize-account-deletions cron sends the week/day reminders and, once
 * purge_at passes, purges for real. Cancel (voice or the email button)
 * removes the key. There is NO path that finalizes early — see tokens.ts.
 */

export type DeletionSchedule = {
  scheduled_at: string; // ISO — when the user confirmed
  purge_at: string; // ISO — scheduled_at + grace
  status: "pending";
  reminder_week_sent?: boolean;
  reminder_day_sent?: boolean;
};

export const DELETION_GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// Same project guard as auth/callback + start-session: admin writes must
// never land on the aiASAP Supabase project, even with a misconfigured env.
const ISOLVE_SUPABASE_REF = "dphxcqjkzhvsdejtxdcj";
const AIASAP_SUPABASE_REF = "wqszxsqzkaatghyrqviv";

export function computePurgeAt(scheduledAtIso: string, graceDays: number): string {
  return new Date(Date.parse(scheduledAtIso) + graceDays * DAY_MS).toISOString();
}

/**
 * Pure decision for one schedule at one moment — what the cron should do.
 * Kept side-effect-free so the release tests can walk the whole 30-day
 * window offline.
 *
 * FAIL SAFE: an unparseable purge_at means corrupt data, and corrupt
 * data must never reach the destructive arm — it waits (forever, until a
 * human looks) rather than purging early. "No early delete ever correct."
 */
export function decideDeletionAction(
  schedule: DeletionSchedule,
  nowMs: number,
): "purge" | "remind_day" | "remind_week" | "wait" {
  const purgeAtMs = Date.parse(schedule.purge_at);
  if (Number.isNaN(purgeAtMs)) return "wait";
  const msLeft = purgeAtMs - nowMs;
  if (msLeft <= 0) return "purge";
  if (msLeft <= 1 * DAY_MS) {
    // Inside the final day only the "last chance" note makes sense — a
    // missed week reminder must never fire mislabeled hours before the
    // purge (it would read "one week left" when there isn't).
    return schedule.reminder_day_sent ? "wait" : "remind_day";
  }
  if (msLeft <= 7 * DAY_MS && !schedule.reminder_week_sent) return "remind_week";
  return "wait";
}

/** Friendly date for emails + 6's spoken confirmation ("August 7, 2026"). */
export function purgeDateText(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
}

type AdminConfig = { url: string; serviceRoleKey: string };

/**
 * Service-role config with the iSolve project guard applied — the ONLY
 * config the account-deletion modules may use (purge.ts imports this
 * too, so no destructive call can ever hit the wrong Supabase project).
 */
export function guardedAdminConfig(): AdminConfig | null {
  let cfg: AdminConfig;
  try {
    cfg = getSupabaseAdminConfig();
  } catch {
    return null;
  }
  if (cfg.url.includes(AIASAP_SUPABASE_REF) || !cfg.url.includes(ISOLVE_SUPABASE_REF)) {
    return null;
  }
  return cfg;
}

function adminHeaders(serviceRoleKey: string): Record<string, string> {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

export type AuthUserLite = {
  id: string;
  email: string | null;
  app_metadata: Record<string, unknown>;
};

export async function getAuthUser(userId: string): Promise<AuthUserLite | null> {
  const cfg = guardedAdminConfig();
  if (!cfg) return null;
  try {
    const res = await fetch(
      `${cfg.url}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      { headers: adminHeaders(cfg.serviceRoleKey) },
    );
    if (!res.ok) return null;
    const u = (await res.json()) as {
      id?: string;
      email?: string | null;
      app_metadata?: Record<string, unknown>;
    };
    if (!u?.id) return null;
    return {
      id: u.id,
      email: u.email ?? null,
      app_metadata: u.app_metadata ?? {},
    };
  } catch {
    return null;
  }
}

/**
 * Write ONE key of app_metadata. GoTrue admin metadata updates MERGE
 * key-by-key — they do not replace the map — so deleting a key requires
 * sending it explicitly as null (omitting it would silently keep it;
 * a "cancel" built that way would be a no-op and the account would
 * still purge — caught in the 2026-07-09 pre-commit review).
 */
async function writeAccountDeletionKey(
  userId: string,
  value: DeletionSchedule | null,
): Promise<boolean> {
  const cfg = guardedAdminConfig();
  if (!cfg) return false;
  try {
    const res = await fetch(
      `${cfg.url}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      {
        method: "PUT",
        headers: adminHeaders(cfg.serviceRoleKey),
        body: JSON.stringify({ app_metadata: { account_deletion: value } }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Only well-formed pending schedules count: both dates must parse and
 * purge_at must sit at/after scheduled_at. Anything else reads as "no
 * schedule" — malformed data can then never reach the cron's purge arm.
 */
export function readScheduleFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): DeletionSchedule | null {
  const raw = metadata?.account_deletion as DeletionSchedule | undefined;
  if (!raw || raw.status !== "pending") return null;
  if (typeof raw.scheduled_at !== "string" || typeof raw.purge_at !== "string") {
    return null;
  }
  const scheduledMs = Date.parse(raw.scheduled_at);
  const purgeMs = Date.parse(raw.purge_at);
  if (Number.isNaN(scheduledMs) || Number.isNaN(purgeMs) || purgeMs < scheduledMs) {
    return null;
  }
  return raw;
}

export async function getAccountDeletion(
  userId: string,
): Promise<DeletionSchedule | null> {
  const user = await getAuthUser(userId);
  if (!user) return null;
  return readScheduleFromMetadata(user.app_metadata);
}

/**
 * Idempotent: if a schedule is already pending, returns it unchanged —
 * confirming twice never restarts the 30-day clock.
 */
export async function scheduleAccountDeletion(
  userId: string,
  graceDays: number = DELETION_GRACE_DAYS,
): Promise<
  | { ok: true; schedule: DeletionSchedule; alreadyScheduled: boolean }
  | { ok: false; error: string }
> {
  const user = await getAuthUser(userId);
  if (!user) return { ok: false, error: "user not found" };
  const existing = readScheduleFromMetadata(user.app_metadata);
  if (existing) return { ok: true, schedule: existing, alreadyScheduled: true };

  const scheduledAt = new Date().toISOString();
  const schedule: DeletionSchedule = {
    scheduled_at: scheduledAt,
    purge_at: computePurgeAt(scheduledAt, graceDays),
    status: "pending",
  };
  const written = await writeAccountDeletionKey(userId, schedule);
  if (!written) return { ok: false, error: "metadata write failed" };
  return { ok: true, schedule, alreadyScheduled: false };
}

export async function cancelAccountDeletion(
  userId: string,
): Promise<
  | { ok: true; hadSchedule: boolean }
  | { ok: false; error: string }
> {
  const user = await getAuthUser(userId);
  if (!user) return { ok: false, error: "user not found" };
  if (!readScheduleFromMetadata(user.app_metadata)) {
    return { ok: true, hadSchedule: false };
  }
  // Explicit null — GoTrue merges metadata updates, so this is the only
  // way the key actually goes away.
  const written = await writeAccountDeletionKey(userId, null);
  if (!written) return { ok: false, error: "metadata write failed" };
  return { ok: true, hadSchedule: true };
}

export async function markReminderSent(
  userId: string,
  which: "week" | "day",
): Promise<boolean> {
  const user = await getAuthUser(userId);
  if (!user) return false;
  const schedule = readScheduleFromMetadata(user.app_metadata);
  if (!schedule) return false;
  const next: DeletionSchedule = {
    ...schedule,
    ...(which === "week" ? { reminder_week_sent: true } : { reminder_day_sent: true }),
  };
  return writeAccountDeletionKey(userId, next);
}

export type PendingDeletion = {
  userId: string;
  email: string | null;
  schedule: DeletionSchedule;
};

/**
 * Pages the GoTrue admin user list collecting pending schedules. Linear
 * scan is fine at beta scale (page cap keeps a runaway list bounded); a
 * real table + index is the upgrade path if the user base outgrows it.
 */
export async function listPendingDeletions(): Promise<PendingDeletion[]> {
  const cfg = guardedAdminConfig();
  if (!cfg) return [];
  const out: PendingDeletion[] = [];
  for (let page = 1; page <= 25; page++) {
    let users: Array<{
      id?: string;
      email?: string | null;
      app_metadata?: Record<string, unknown>;
    }>;
    try {
      const res = await fetch(
        `${cfg.url}/auth/v1/admin/users?per_page=200&page=${page}`,
        { headers: adminHeaders(cfg.serviceRoleKey) },
      );
      if (!res.ok) break;
      const body = (await res.json()) as { users?: typeof users };
      users = body.users ?? [];
    } catch {
      break;
    }
    for (const u of users) {
      if (!u.id) continue;
      const schedule = readScheduleFromMetadata(u.app_metadata);
      if (schedule) {
        out.push({ userId: u.id, email: u.email ?? null, schedule });
      }
    }
    if (users.length < 200) break;
  }
  return out;
}
