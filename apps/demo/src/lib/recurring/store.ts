import { getSupabaseAdminConfig } from "../supabaseAdmin";
import type { RecurringSchedule } from "./rrule";

/**
 * M4.7 — recurring_jobs persistence.
 */

export type RecurringJobStatus =
  | "active"
  | "paused"
  | "ended"
  | "cancelled";

export type RecurringJobRow = {
  id: string;
  user_id: string;
  contractor_id: string | null;
  contract_id: string | null;
  title: string;
  agenda: string;
  duration_minutes: number;
  timezone: string;
  schedule: RecurringSchedule;
  status: RecurringJobStatus;
  active_from: string;
  active_until: string | null;
  last_materialized_at: string | null;
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type CreateRecurringJobInput = {
  user_id: string;
  contractor_id: string | null;
  contract_id?: string | null;
  title: string;
  agenda?: string;
  duration_minutes?: number;
  timezone: string;
  schedule: RecurringSchedule;
  active_from?: string;
  active_until?: string | null;
  context?: Record<string, unknown>;
};

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

export async function createRecurringJob(
  input: CreateRecurringJobInput,
): Promise<RecurringJobRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const row = {
    user_id: input.user_id,
    contractor_id: input.contractor_id,
    contract_id: input.contract_id ?? null,
    title: input.title,
    agenda: input.agenda ?? "",
    duration_minutes: input.duration_minutes ?? 60,
    timezone: input.timezone,
    schedule: input.schedule,
    active_from: input.active_from ?? new Date().toISOString(),
    active_until: input.active_until ?? null,
    context: input.context ?? {},
  };
  const res = await fetch(`${url}/rest/v1/recurring_jobs`, {
    method: "POST",
    headers: { ...adminHeaders(serviceRoleKey), Prefer: "return=representation" },
    body: JSON.stringify([row]),
  });
  if (!res.ok) {
    console.error(
      "[recurring/store] insert failed:",
      res.status,
      await res.text().catch(() => ""),
    );
    return null;
  }
  const rows = (await res.json()) as RecurringJobRow[];
  return rows[0] ?? null;
}

export async function listActiveRecurringJobs(args?: {
  limit?: number;
}): Promise<RecurringJobRow[]> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const qs = new URLSearchParams();
  qs.set("status", "eq.active");
  qs.set("order", "active_from.asc");
  qs.set("limit", String(args?.limit ?? 500));
  const res = await fetch(`${url}/rest/v1/recurring_jobs?${qs.toString()}`, {
    headers: adminHeaders(serviceRoleKey),
    cache: "no-store",
  });
  if (!res.ok) return [];
  return (await res.json()) as RecurringJobRow[];
}

export async function listUserRecurringJobs(args: {
  user_id: string;
  status?: RecurringJobStatus | "any";
  limit?: number;
}): Promise<RecurringJobRow[]> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const qs = new URLSearchParams();
  qs.set("user_id", `eq.${args.user_id}`);
  if (args.status && args.status !== "any") {
    qs.set("status", `eq.${args.status}`);
  }
  qs.set("order", "created_at.desc");
  qs.set("limit", String(args.limit ?? 20));
  const res = await fetch(`${url}/rest/v1/recurring_jobs?${qs.toString()}`, {
    headers: adminHeaders(serviceRoleKey),
    cache: "no-store",
  });
  if (!res.ok) return [];
  return (await res.json()) as RecurringJobRow[];
}

export async function patchRecurringJob(
  id: string,
  patch: Partial<
    Pick<
      RecurringJobRow,
      | "status"
      | "active_until"
      | "last_materialized_at"
      | "context"
    >
  >,
): Promise<RecurringJobRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/recurring_jobs?id=eq.${encodeURIComponent(id)}`,
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
  const rows = (await res.json()) as RecurringJobRow[];
  return rows[0] ?? null;
}

export async function insertMaterializedAppointment(args: {
  user_id: string;
  contractor_id: string | null;
  contract_id: string | null;
  recurring_job_id: string;
  scheduled_at: string;
  duration_minutes: number;
  agenda: string;
}): Promise<{ id: string } | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const row = {
    user_id: args.user_id,
    contractor_id: args.contractor_id,
    contract_id: args.contract_id,
    recurring_job_id: args.recurring_job_id,
    scheduled_at: args.scheduled_at,
    duration_minutes: args.duration_minutes,
    agenda: args.agenda,
    context: {
      materialized_by: "recurring_jobs_cron",
      recurring_job_id: args.recurring_job_id,
    },
  };
  const res = await fetch(
    `${url}/rest/v1/appointments?on_conflict=recurring_job_id,scheduled_at`,
    {
      method: "POST",
      headers: {
        ...adminHeaders(serviceRoleKey),
        // The unique index covers (recurring_job_id, scheduled_at). On
        // conflict we explicitly DO NOTHING — duplicate materialization
        // is a no-op rather than an overwrite.
        Prefer: "resolution=ignore-duplicates,return=representation",
      },
      body: JSON.stringify([row]),
    },
  );
  if (!res.ok) {
    console.error(
      "[recurring/store] materialize failed:",
      res.status,
      await res.text().catch(() => ""),
    );
    return null;
  }
  const rows = (await res.json()) as Array<{ id: string }>;
  return rows[0] ?? null;
}
