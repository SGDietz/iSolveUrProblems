import { getSupabaseAdminConfig } from "../supabaseAdmin";
import { searchContractors } from "../contractors/search";
import type { ContractorRow } from "../contractors/types";
import { send } from "../notifications";
import { APP_PUBLIC_BASE_URL } from "../../../app/api/secrets";
import type { AppointmentRow } from "./types";

/**
 * M4.4 — Backup / replacement dispatcher.
 *
 * Vision ¶33: "If contractors don't show, 6 will get contractors that do."
 *
 * Two entry points converge here:
 *   1. Cron `/api/cron/no-show-detector` scans for appointments past
 *      their scheduled_at + grace window with no contractor confirmation
 *      and calls declareNoShowAndDispatch({ trigger: 'cron_grace_expired' }).
 *   2. Homeowner-driven route `/api/appointments/[id]/no-show` fires
 *      from the report_no_show intent and calls the same function with
 *      trigger='homeowner_report'.
 *
 * Dispatch flow:
 *   a. Flip appointment.status -> 'no_show' and stamp no_show_detected_at.
 *      Compare-and-swap guarded by "no_show_detected_at IS NULL" so
 *      concurrent triggers coalesce to one dispatch.
 *   b. Insert an appointment_replacements audit row (invited_count=0
 *      initially; patched below).
 *   c. Re-run M2.1 search in same-day mode near the original contractor's
 *      service area. Filter to same-day-capable contractors OTHER than
 *      the no-show contractor, with a claimed portal account (they'd
 *      have no dashboard to respond in otherwise) and an email on file.
 *   d. Fan out contractor.urgent_dispatch.v1 email to the top N.
 *   e. Update the replacements row with invited_count.
 *
 * We reuse M4.2 crew_request infrastructure for the invitation ledger
 * — same first-accept-wins pattern, same accept/decline route surface,
 * same "which invitees haven't heard back" logic. The dispatch inserts
 * a crew_requests row with context.origin='no_show_dispatch' so the UI
 * can distinguish it from a peer-to-peer request.
 */

const GRACE_MINUTES_DEFAULT = 30;
const DISPATCH_FANOUT_N = 8;
const DISPATCH_RADIUS_KM = 40;

// ─── Fetch helpers ───────────────────────────────────────────────────

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

type OriginalContractor = {
  id: string;
  name: string;
  lat: number | null;
  lng: number | null;
  categories: string[] | null;
};

async function fetchOriginalContractor(
  contractorId: string,
): Promise<OriginalContractor | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(
      contractorId,
    )}&select=id,name,lat,lng,categories&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as OriginalContractor[];
  return rows[0] ?? null;
}

async function fetchHomeownerFirstName(
  userId: string,
): Promise<string | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/users?id=eq.${encodeURIComponent(
      userId,
    )}&select=full_name&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ full_name: string | null }>;
  const full = rows[0]?.full_name?.trim();
  if (!full) return null;
  return full.split(/\s+/)[0] ?? null;
}

async function filterInvitableContractors(
  candidateIds: string[],
): Promise<ContractorRow[]> {
  if (candidateIds.length === 0) return [];
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const inList = candidateIds.map((id) => `"${id}"`).join(",");
  const res = await fetch(
    `${url}/rest/v1/contractors?id=in.(${inList})&claimed_by_user_id=not.is.null&email=not.is.null&select=*`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return [];
  return (await res.json()) as ContractorRow[];
}

// ─── State transitions ──────────────────────────────────────────────

/**
 * Flip an appointment to status='no_show' and stamp the detection time.
 * Compare-and-swap on no_show_detected_at IS NULL: if two triggers race
 * (cron + homeowner report within the same 5 minutes), only one wins,
 * the other returns null and the caller skips.
 */
export async function markNoShowIfNew(args: {
  appointment_id: string;
}): Promise<AppointmentRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/appointments?id=eq.${encodeURIComponent(
      args.appointment_id,
    )}&no_show_detected_at=is.null&status=in.(scheduled,rescheduled)`,
    {
      method: "PATCH",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        status: "no_show",
        no_show_detected_at: new Date().toISOString(),
      }),
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as AppointmentRow[];
  return rows[0] ?? null;
}

/**
 * M4.5 hook / dashboard-arrival hook: record that the contractor is
 * on-site. Once set, the no-show detector ignores the appointment.
 * Idempotent — only writes if the column is still null.
 *
 * The `source` arg is intentionally NOT persisted: PostgREST PATCH
 * replaces jsonb columns whole, so merging a `confirmed_source` into
 * `context` would clobber any prior reminder / reschedule metadata.
 * Caller identity is recoverable from the caller's route logs if we
 * ever need it.
 */
export async function markContractorConfirmed(args: {
  appointment_id: string;
  contractor_id: string;
  source: "photo_log" | "dashboard_tap" | "voice";
}): Promise<AppointmentRow | null> {
  void args.source;
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/appointments?id=eq.${encodeURIComponent(
      args.appointment_id,
    )}&contractor_id=eq.${encodeURIComponent(
      args.contractor_id,
    )}&contractor_confirmed_at=is.null`,
    {
      method: "PATCH",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        contractor_confirmed_at: new Date().toISOString(),
      }),
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as AppointmentRow[];
  return rows[0] ?? null;
}

// ─── No-show detection ──────────────────────────────────────────────

export type NoShowCandidate = AppointmentRow & { grace_minutes: number };

/**
 * Cron primary query: scheduled/rescheduled appointments past their
 * scheduled_at + grace window, with contractor still not confirmed on
 * site, and no_show_detected_at not yet set. The partial index
 * idx_appointments_no_show_scan covers this exactly.
 */
export async function findNoShowCandidates(args?: {
  grace_minutes?: number;
  limit?: number;
}): Promise<NoShowCandidate[]> {
  const grace = args?.grace_minutes ?? GRACE_MINUTES_DEFAULT;
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const cutoff = new Date(Date.now() - grace * 60_000).toISOString();
  const qs = new URLSearchParams();
  qs.set("status", "in.(scheduled,rescheduled)");
  qs.set("contractor_confirmed_at", "is.null");
  qs.set("no_show_detected_at", "is.null");
  qs.set("contractor_id", "not.is.null");
  qs.set("scheduled_at", `lte.${cutoff}`);
  qs.set("order", "scheduled_at.asc");
  qs.set("limit", String(Math.min(args?.limit ?? 50, 200)));
  qs.set("select", "*");
  const res = await fetch(
    `${url}/rest/v1/appointments?${qs.toString()}`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return [];
  const rows = (await res.json()) as AppointmentRow[];
  return rows.map((r) => ({ ...r, grace_minutes: grace }));
}

// ─── Dispatch ────────────────────────────────────────────────────────

export type DispatchTrigger =
  | "cron_grace_expired"
  | "homeowner_report"
  | "admin_manual";

export type DispatchInvited = {
  contractor_id: string;
  name: string;
  email: string | null;
  distance_km: number;
  rank_score: number;
  delivered: boolean;
  error?: string;
};

export type DispatchResult = {
  appointment_id: string;
  replacement_id: string | null;
  invited: DispatchInvited[];
  total_considered: number;
  skipped_reason?:
    | "no_original_contractor"
    | "no_contractor_location"
    | "already_dispatched"
    | "status_locked"
    | "no_invitables";
};

/**
 * Insert the appointment_replacements audit row. Called eagerly so we
 * have a "we tried" ledger even when zero helpers accept.
 */
async function insertReplacementRow(args: {
  original_appointment_id: string;
  trigger: DispatchTrigger;
  context: Record<string, unknown>;
}): Promise<{ id: string } | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/appointment_replacements`,
    {
      method: "POST",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify([
        {
          original_appointment_id: args.original_appointment_id,
          trigger: args.trigger,
          invited_count: 0,
          context: args.context,
        },
      ]),
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ id: string }>;
  return rows[0] ?? null;
}

async function patchReplacementInvitedCount(args: {
  replacement_row_id: string;
  invited_count: number;
}): Promise<void> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  await fetch(
    `${url}/rest/v1/appointment_replacements?id=eq.${encodeURIComponent(
      args.replacement_row_id,
    )}`,
    {
      method: "PATCH",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=minimal",
      },
      body: JSON.stringify({ invited_count: args.invited_count }),
    },
  );
}

/**
 * Main dispatch — assumes markNoShowIfNew has already succeeded (i.e.
 * the appointment is currently in status='no_show'). Runs the fan-out
 * and writes the audit trail.
 */
export async function runBackupDispatch(args: {
  appointment: AppointmentRow;
  trigger: DispatchTrigger;
  reasonContext?: Record<string, unknown>;
}): Promise<DispatchResult> {
  const appt = args.appointment;
  const baseResult: DispatchResult = {
    appointment_id: appt.id,
    replacement_id: null,
    invited: [],
    total_considered: 0,
  };

  if (!appt.contractor_id) {
    return { ...baseResult, skipped_reason: "no_original_contractor" };
  }

  const original = await fetchOriginalContractor(appt.contractor_id);
  if (!original || original.lat == null || original.lng == null) {
    return { ...baseResult, skipped_reason: "no_contractor_location" };
  }

  const category = original.categories?.[0] ?? "general";
  const homeownerFirstName = await fetchHomeownerFirstName(appt.user_id);

  const replacementRow = await insertReplacementRow({
    original_appointment_id: appt.id,
    trigger: args.trigger,
    context: {
      ...(args.reasonContext ?? {}),
      original_contractor_id: original.id,
      original_contractor_name: original.name,
      category,
    },
  });

  const search = await searchContractors({
    category,
    near: { lat: original.lat, lng: original.lng },
    radius_km: DISPATCH_RADIUS_KM,
    same_day: true,
    limit: DISPATCH_FANOUT_N * 3,
  });

  const eligibleIds = search.hits
    .map((h) => h.id)
    .filter((id) => id !== original.id);
  const invitables = await filterInvitableContractors(eligibleIds);
  const invitableById = new Map(invitables.map((c) => [c.id, c] as const));
  const finalHits = search.hits
    .filter((h) => invitableById.has(h.id))
    .slice(0, DISPATCH_FANOUT_N);

  if (finalHits.length === 0) {
    return {
      ...baseResult,
      replacement_id: replacementRow?.id ?? null,
      total_considered: search.total_considered,
      skipped_reason: "no_invitables",
    };
  }

  const dashboardUrl = APP_PUBLIC_BASE_URL
    ? `${APP_PUBLIC_BASE_URL}/en/contractor/dashboard`
    : "/en/contractor/dashboard";
  const neededAtText = humanNeededAt(appt.scheduled_at);

  const invited: DispatchInvited[] = [];
  for (const hit of finalHits) {
    const helper = invitableById.get(hit.id)!;
    let delivered = false;
    let error: string | undefined;
    if (helper.email) {
      const result = await send({
        channel: "email",
        recipient: helper.email,
        templateId: "contractor.urgent_dispatch.v1",
        data: {
          recipientName: helper.name,
          category,
          homeownerFirstName,
          neededAtText,
          distanceKm: Math.round(hit.distance_km),
          agenda: appt.agenda || null,
          dashboardUrl,
        },
        context: {
          appointment_id: appt.id,
          replacement_row_id: replacementRow?.id ?? null,
          invitee_contractor_id: helper.id,
          origin: "no_show_dispatch",
          trigger: args.trigger,
        },
      });
      delivered = result.ok;
      if (!result.ok) error = result.error;
    } else {
      error = "no_email";
    }
    invited.push({
      contractor_id: helper.id,
      name: helper.name,
      email: helper.email,
      distance_km: hit.distance_km,
      rank_score: hit.score,
      delivered,
      ...(error ? { error } : {}),
    });
  }

  if (replacementRow) {
    await patchReplacementInvitedCount({
      replacement_row_id: replacementRow.id,
      invited_count: invited.filter((i) => i.delivered).length,
    });
  }

  return {
    appointment_id: appt.id,
    replacement_id: replacementRow?.id ?? null,
    invited,
    total_considered: search.total_considered,
  };
}

/**
 * Convenience: mark + dispatch in one call. Idempotent — if the
 * appointment already has no_show_detected_at set (race with another
 * trigger) we return status_locked and skip the dispatch entirely.
 */
export async function declareNoShowAndDispatch(args: {
  appointment_id: string;
  trigger: DispatchTrigger;
  reasonContext?: Record<string, unknown>;
}): Promise<DispatchResult> {
  const flipped = await markNoShowIfNew({ appointment_id: args.appointment_id });
  if (!flipped) {
    return {
      appointment_id: args.appointment_id,
      replacement_id: null,
      invited: [],
      total_considered: 0,
      skipped_reason: "status_locked",
    };
  }
  return runBackupDispatch({
    appointment: flipped,
    trigger: args.trigger,
    reasonContext: args.reasonContext,
  });
}

// ─── Presentation helpers ───────────────────────────────────────────

function humanNeededAt(scheduled_at: string): string {
  const now = Date.now();
  const then = new Date(scheduled_at).getTime();
  const diffMin = Math.round((then - now) / 60_000);
  if (diffMin <= 15 && diffMin >= -60) return "right now";
  if (diffMin > 15 && diffMin <= 240) {
    const h = Math.max(1, Math.round(diffMin / 60));
    return `in ~${h} ${h === 1 ? "hour" : "hours"}`;
  }
  const d = new Date(scheduled_at);
  return d.toLocaleString("en-US", {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

