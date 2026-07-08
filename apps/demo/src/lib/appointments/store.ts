import { getSupabaseAdminConfig } from "../supabaseAdmin";
import type {
  AppointmentRow,
  CreateAppointmentInput,
  RescheduleAppointmentInput,
} from "./types";

/**
 * M3.4 + M3.5 — Appointment persistence.
 *
 * Service-role writes (so the cron + voice intake can both insert).
 * Owner-scoped reads via RLS for direct client queries; helper functions
 * below use service-role so server-side intent orchestrator can read
 * across users for the cron job.
 */

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

export async function createAppointment(
  input: CreateAppointmentInput,
): Promise<AppointmentRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const row = {
    user_id: input.user_id,
    contractor_id: input.contractor_id ?? null,
    contract_id: input.contract_id ?? null,
    scheduled_at: input.scheduled_at,
    duration_minutes: input.duration_minutes ?? 60,
    agenda: input.agenda ?? "",
    context: input.context ?? {},
  };
  const res = await fetch(`${url}/rest/v1/appointments`, {
    method: "POST",
    headers: {
      ...adminHeaders(serviceRoleKey),
      Prefer: "return=representation",
    },
    body: JSON.stringify([row]),
  });
  if (!res.ok) {
    console.error("appointments insert failed:", res.status, await res.text());
    return null;
  }
  const rows = (await res.json()) as AppointmentRow[];
  return rows[0] ?? null;
}

export async function rescheduleAppointment(
  input: RescheduleAppointmentInput,
): Promise<AppointmentRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const patch = {
    scheduled_at: input.new_scheduled_at,
    status: "rescheduled",
    // Reset reminder gates so the new appointment gets its own reminders.
    reminder_24h_sent_at: null,
    reminder_2h_sent_at: null,
    context: { reschedule_reason: input.reason ?? null },
  };
  const res = await fetch(
    `${url}/rest/v1/appointments?id=eq.${encodeURIComponent(
      input.appointment_id,
    )}&user_id=eq.${encodeURIComponent(input.user_id)}`,
    {
      method: "PATCH",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    console.error(
      "appointments reschedule failed:",
      res.status,
      await res.text(),
    );
    return null;
  }
  const rows = (await res.json()) as AppointmentRow[];
  return rows[0] ?? null;
}

export async function cancelAppointment(args: {
  appointment_id: string;
  user_id: string;
  reason?: string;
}): Promise<AppointmentRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const patch = {
    status: "cancelled",
    context: { cancel_reason: args.reason ?? null },
  };
  const res = await fetch(
    `${url}/rest/v1/appointments?id=eq.${encodeURIComponent(
      args.appointment_id,
    )}&user_id=eq.${encodeURIComponent(args.user_id)}`,
    {
      method: "PATCH",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as AppointmentRow[];
  return rows[0] ?? null;
}

export async function listUpcomingAppointments(args: {
  user_id: string;
  limit?: number;
}): Promise<AppointmentRow[]> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const limit = Math.min(Math.max(args.limit ?? 10, 1), 100);
  const qs = new URLSearchParams();
  qs.set("user_id", `eq.${args.user_id}`);
  qs.set("status", "in.(scheduled,rescheduled)");
  qs.set("scheduled_at", `gte.${new Date().toISOString()}`);
  qs.set("order", "scheduled_at.asc");
  qs.set("limit", String(limit));
  qs.set("select", "*");
  const res = await fetch(`${url}/rest/v1/appointments?${qs.toString()}`, {
    headers: adminHeaders(serviceRoleKey),
    cache: "no-store",
  });
  if (!res.ok) return [];
  return (await res.json()) as AppointmentRow[];
}

/** Shared due-window math: [now + offsetHours ± windowMinutes]. Both the
 * reminder due-query and the checklist due-query need this — pulled out
 * so the arithmetic exists in exactly one place. */
function dueWindow(offsetHours: number, windowMinutes: number): { lower: Date; upper: Date } {
  const now = new Date();
  return {
    lower: new Date(now.getTime() + offsetHours * 3_600_000 - windowMinutes * 60_000),
    upper: new Date(now.getTime() + offsetHours * 3_600_000 + windowMinutes * 60_000),
  };
}

/**
 * Cron-only: find appointments whose reminder window is open and whose
 * reminder hasn't been sent yet. The window math is done in SQL via
 * scheduled_at minus an interval; reminder_*_sent_at IS NULL ensures
 * idempotency.
 */
export async function findAppointmentsDueForReminder(args: {
  kind: "24h" | "2h";
  windowMinutes?: number;
}): Promise<AppointmentRow[]> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const windowMin = args.windowMinutes ?? 30;
  // For 24h reminders: target time = scheduled_at - 24h; fire if now is
  // within +/- windowMin of target. Equivalent: scheduled_at is between
  // (now + 24h - windowMin) and (now + 24h + windowMin), and not yet sent.
  const offsetH = args.kind === "24h" ? 24 : 2;
  const { lower, upper } = dueWindow(offsetH, windowMin);
  const sentField =
    args.kind === "24h" ? "reminder_24h_sent_at" : "reminder_2h_sent_at";

  const qs = new URLSearchParams();
  qs.set("status", "in.(scheduled,rescheduled)");
  qs.set("scheduled_at", `gte.${lower.toISOString()}`);
  qs.append("scheduled_at", `lte.${upper.toISOString()}`);
  qs.set(sentField, "is.null");
  qs.set("select", "*");
  qs.set("limit", "200");
  const res = await fetch(`${url}/rest/v1/appointments?${qs.toString()}`, {
    headers: adminHeaders(serviceRoleKey),
    cache: "no-store",
  });
  if (!res.ok) return [];
  return (await res.json()) as AppointmentRow[];
}

/**
 * M4.3 — Find appointments whose 2h checklist window is open and the
 * checklist hasn't been marked notified yet. Deliberately decoupled from
 * reminder_2h_sent_at: the reminder and the checklist are two independent
 * idempotency gates. Piggybacking the checklist on the reminder's due-list
 * meant a checklist send failure could never retry once the 2h reminder
 * itself had already sent.
 */
export async function findAppointmentsDueForChecklist(args: {
  windowMinutes?: number;
}): Promise<AppointmentRow[]> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const { lower, upper } = dueWindow(2, args.windowMinutes ?? 30);

  const qs = new URLSearchParams();
  qs.set("status", "in.(scheduled,rescheduled)");
  qs.set("scheduled_at", `gte.${lower.toISOString()}`);
  qs.append("scheduled_at", `lte.${upper.toISOString()}`);
  qs.set("checklist_notified_at", "is.null");
  qs.set("contractor_id", "not.is.null");
  qs.set("select", "*");
  qs.set("limit", "200");
  const res = await fetch(`${url}/rest/v1/appointments?${qs.toString()}`, {
    headers: adminHeaders(serviceRoleKey),
    cache: "no-store",
  });
  if (!res.ok) return [];
  return (await res.json()) as AppointmentRow[];
}

export async function markReminderSent(args: {
  appointment_id: string;
  kind: "24h" | "2h";
}): Promise<boolean> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const field =
    args.kind === "24h" ? "reminder_24h_sent_at" : "reminder_2h_sent_at";
  try {
    const res = await fetch(
      `${url}/rest/v1/appointments?id=eq.${encodeURIComponent(args.appointment_id)}`,
      {
        method: "PATCH",
        headers: {
          ...adminHeaders(serviceRoleKey),
          Prefer: "return=minimal",
        },
        body: JSON.stringify({ [field]: new Date().toISOString() }),
      },
    );
    if (!res.ok) {
      console.error(
        "markReminderSent failed:",
        res.status,
        await res.text(),
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error("markReminderSent threw:", error);
    return false;
  }
}

export async function getAppointmentById(
  id: string,
  user_id: string,
): Promise<AppointmentRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/appointments?id=eq.${encodeURIComponent(
      id,
    )}&user_id=eq.${encodeURIComponent(user_id)}&select=*&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as AppointmentRow[];
  return rows[0] ?? null;
}

/**
 * M4.4 — Find the homeowner's most likely no-show target. When the
 * homeowner says "they didn't show", the relevant appointment is one
 * that was scheduled a little while ago (past scheduled_at) but is still
 * in an actionable state — contractor hasn't confirmed on-site, we
 * haven't already flipped it to no_show, and it's within the last
 * `windowHours` hours. We look slightly into the future too (up to
 * 15 min) so a homeowner reporting the moment the contractor is late
 * still finds the appointment.
 */
export async function findRecentUnfulfilledAppointment(args: {
  user_id: string;
  windowHours?: number;
}): Promise<AppointmentRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const windowH = Math.max(1, Math.min(args.windowHours ?? 4, 24));
  const from = new Date(Date.now() - windowH * 3_600_000).toISOString();
  const to = new Date(Date.now() + 15 * 60_000).toISOString();
  const qs = new URLSearchParams();
  qs.set("user_id", `eq.${args.user_id}`);
  qs.set("status", "in.(scheduled,rescheduled)");
  qs.set("contractor_confirmed_at", "is.null");
  qs.set("no_show_detected_at", "is.null");
  qs.set("scheduled_at", `gte.${from}`);
  qs.append("scheduled_at", `lte.${to}`);
  qs.set("order", "scheduled_at.desc");
  qs.set("limit", "1");
  qs.set("select", "*");
  const res = await fetch(`${url}/rest/v1/appointments?${qs.toString()}`, {
    headers: adminHeaders(serviceRoleKey),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as AppointmentRow[];
  return rows[0] ?? null;
}
