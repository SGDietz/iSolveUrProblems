import {
  EMAIL_KEYED_TABLES,
  EXPLICIT_PURGE_TABLES,
  STORAGE_SOURCES,
} from "./dataInventory";
import { guardedAdminConfig } from "./deletionSchedule";

/**
 * The real, irreversible account purge. ONLY the daily
 * finalize-account-deletions cron calls this, and only after the 30-day
 * grace window has fully run out — there is no user-reachable route,
 * link, or intent that can trigger it early (tokens.ts documents why).
 *
 * Order mirrors the proven test-account wipe script:
 *   1. un-claim contractors (the contractors DB is sacred — rows are
 *      preserved, only the claim link is cleared)
 *   2. delete the user's Storage OBJECTS (recordings, photos, report
 *      files) — paths come from the rows, so objects go before rows
 *   3. hand-delete the SET-NULL / no-FK tables that would otherwise
 *      survive with orphaned PII, plus the email-keyed sweep
 *   4. delete the auth user — the FK CASCADE takes everything else
 *   5. belt-and-suspenders delete of the public.users row
 *
 * FAIL CLOSED BEFORE THE POINT OF NO RETURN: if any storage or row
 * sweep hard-fails, the auth user is NOT deleted and the whole purge
 * returns ok:false — the cron simply retries tomorrow while every row
 * is still reachable. Deleting the auth user first would strand the
 * failed sweeps as permanently undeletable orphaned PII (2026-07-09
 * pre-commit review).
 *
 * Never throws; per-step results land in the returned map so the cron
 * can log exactly what happened.
 */

export type PurgeResult = {
  ok: boolean;
  steps: Record<string, string>; // step name -> "ok" | "ok:<n>" | "error:<detail>"
};

const STORAGE_DELETE_CHUNK = 100;
const PATH_PAGE_SIZE = 1000;
const PATH_MAX_PAGES = 20;

type Cfg = { url: string; serviceRoleKey: string };

function headers(cfg: Cfg): Record<string, string> {
  return {
    apikey: cfg.serviceRoleKey,
    Authorization: `Bearer ${cfg.serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * Paged path collection — a long-lived account can hold thousands of
 * media rows; a single capped fetch would silently strand every object
 * past the cap. Returns null on a hard failure so the caller can abort
 * instead of purging blind.
 */
async function collectStoragePaths(
  cfg: Cfg,
  userId: string,
  table: string,
  pathColumns: readonly string[],
): Promise<string[] | null> {
  const paths: string[] = [];
  for (let page = 0; page < PATH_MAX_PAGES; page++) {
    try {
      const res = await fetch(
        `${cfg.url}/rest/v1/${table}?user_id=eq.${encodeURIComponent(userId)}` +
          `&select=${pathColumns.join(",")}&order=created_at.asc` +
          `&limit=${PATH_PAGE_SIZE}&offset=${page * PATH_PAGE_SIZE}`,
        { headers: headers(cfg) },
      );
      if (res.status === 404) return paths; // table absent in this env
      if (!res.ok) return null;
      const rows = (await res.json().catch(() => null)) as Array<
        Record<string, unknown>
      > | null;
      if (!Array.isArray(rows)) return null;
      for (const row of rows) {
        for (const col of pathColumns) {
          const p = row[col];
          if (typeof p === "string" && p.trim() !== "") paths.push(p);
        }
      }
      if (rows.length < PATH_PAGE_SIZE) return paths;
    } catch {
      return null;
    }
  }
  return paths;
}

async function deleteStorageObjects(
  cfg: Cfg,
  bucket: string,
  paths: string[],
): Promise<string> {
  if (paths.length === 0) return "ok:0";
  let deleted = 0;
  let failedChunks = 0;
  for (let i = 0; i < paths.length; i += STORAGE_DELETE_CHUNK) {
    const chunk = paths.slice(i, i + STORAGE_DELETE_CHUNK);
    try {
      const res = await fetch(`${cfg.url}/storage/v1/object/${bucket}`, {
        method: "DELETE",
        headers: headers(cfg),
        body: JSON.stringify({ prefixes: chunk }),
      });
      // 400/404 covers already-gone objects — the goal is "not there".
      if (res.ok || res.status === 404 || res.status === 400) {
        deleted += chunk.length;
      } else {
        failedChunks++;
      }
    } catch {
      failedChunks++;
    }
  }
  return failedChunks === 0 ? `ok:${deleted}` : `error:${failedChunks} chunks failed`;
}

async function deleteRows(
  cfg: Cfg,
  table: string,
  filter: string,
): Promise<string> {
  try {
    const res = await fetch(`${cfg.url}/rest/v1/${table}?${filter}`, {
      method: "DELETE",
      headers: { ...headers(cfg), Prefer: "return=minimal" },
    });
    // 404 = table absent in this environment; the row goal is met either way.
    if (res.ok || res.status === 404) return "ok";
    return `error:${res.status}`;
  } catch {
    return "error:throw";
  }
}

/**
 * True when the user still has a live dispute (open / awaiting_user /
 * escalated). Privacy Policy §12 keeps records "to resolve an open
 * dispute" — the cron defers the purge until it closes, then finishes on
 * a later run. Fails CLOSED (treat a failed check as "has open dispute")
 * so a transient DB error can never let a purge jump a live dispute.
 */
export async function hasOpenDispute(userId: string): Promise<boolean> {
  const cfg = guardedAdminConfig();
  if (!cfg) return true;
  try {
    const res = await fetch(
      `${cfg.url}/rest/v1/disputes?user_id=eq.${encodeURIComponent(userId)}` +
        `&status=in.(open,awaiting_user,escalated)&select=id&limit=1`,
      { headers: headers(cfg) },
    );
    if (!res.ok) return true;
    const rows = (await res.json().catch(() => null)) as unknown[] | null;
    if (!Array.isArray(rows)) return true;
    return rows.length > 0;
  } catch {
    return true;
  }
}

export async function purgeUserAccount(userId: string): Promise<PurgeResult> {
  const steps: Record<string, string> = {};
  const cfg = guardedAdminConfig();
  if (!cfg) {
    return { ok: false, steps: { config: "error:supabase not configured or wrong project" } };
  }

  // Email comes from the auth record — needed for the email-keyed sweep.
  // 404 means the auth user is already gone (a prior partial purge):
  // finish the sweeps. Any OTHER failure aborts — purging without
  // knowing the email would silently skip the email-keyed PII.
  let email: string | null = null;
  let authUserGone = false;
  try {
    const res = await fetch(
      `${cfg.url}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
      { headers: headers(cfg) },
    );
    if (res.status === 404) {
      authUserGone = true;
    } else if (!res.ok) {
      return { ok: false, steps: { "auth.lookup": `error:${res.status}` } };
    } else {
      const u = (await res.json().catch(() => null)) as { email?: string | null } | null;
      email = u?.email ?? null;
    }
  } catch {
    return { ok: false, steps: { "auth.lookup": "error:throw" } };
  }

  // 1. Contractors stay (sacred DB) — only the claim link clears.
  steps["contractors.unclaim"] = await (async () => {
    try {
      const res = await fetch(
        `${cfg.url}/rest/v1/contractors?claimed_by_user_id=eq.${encodeURIComponent(userId)}`,
        {
          method: "PATCH",
          headers: { ...headers(cfg), Prefer: "return=minimal" },
          body: JSON.stringify({
            claimed_by_user_id: null,
            claim_status: "unclaimed",
          }),
        },
      );
      return res.ok || res.status === 404 ? "ok" : `error:${res.status}`;
    } catch {
      return "error:throw";
    }
  })();

  // 2. Storage objects (recordings, photos, report files) before rows.
  for (const src of STORAGE_SOURCES) {
    const paths = await collectStoragePaths(cfg, userId, src.table, src.pathColumns);
    steps[`storage.${src.bucket}`] =
      paths === null
        ? "error:path collection failed"
        : await deleteStorageObjects(cfg, src.bucket, paths);
  }

  // 3. Tables the auth-user CASCADE won't reach.
  for (const table of EXPLICIT_PURGE_TABLES) {
    steps[`rows.${table}`] = await deleteRows(
      cfg,
      table,
      `user_id=eq.${encodeURIComponent(userId)}`,
    );
  }
  if (email) {
    for (const table of EMAIL_KEYED_TABLES) {
      steps[`rows.${table}`] = await deleteRows(
        cfg,
        table,
        `email=eq.${encodeURIComponent(email)}`,
      );
    }
    // Session-transcript syncs + pre-link sends can leave rows carrying
    // the address with user_id still NULL — sweep those by recipient too.
    steps["rows.notifications_sent.by_email"] = await deleteRows(
      cfg,
      "notifications_sent",
      `recipient=eq.${encodeURIComponent(email)}`,
    );
  }

  // POINT OF NO RETURN — any failure above means we stop HERE with the
  // auth user intact, so tomorrow's cron can still reach every row.
  const sweepFailures = Object.entries(steps).filter(([, v]) => v.startsWith("error"));
  if (sweepFailures.length > 0) {
    return { ok: false, steps };
  }

  // 4. The auth user — FK CASCADE erases everything else.
  if (!authUserGone) {
    steps["auth.user"] = await (async () => {
      try {
        const res = await fetch(
          `${cfg.url}/auth/v1/admin/users/${encodeURIComponent(userId)}`,
          { method: "DELETE", headers: headers(cfg) },
        );
        return res.ok || res.status === 404 ? "ok" : `error:${res.status}`;
      } catch {
        return "error:throw";
      }
    })();
  } else {
    steps["auth.user"] = "ok:already-gone";
  }

  // 5. Belt-and-suspenders — CASCADE should have taken it already.
  steps["rows.users"] = await deleteRows(
    cfg,
    "users",
    `id=eq.${encodeURIComponent(userId)}`,
  );

  return { ok: steps["auth.user"].startsWith("ok"), steps };
}
