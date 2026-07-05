import { getSupabaseAdminConfig } from "../supabaseAdmin";
import type {
  CallRow,
  CallStatus,
  CreateCallInput,
  CreateEstimateInput,
  EstimateRow,
  EstimateStatus,
} from "./types";

/**
 * M3.1 / M3.6 — Calls + estimates persistence. Service-role only.
 */

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

export async function createCall(
  input: CreateCallInput,
): Promise<CallRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const row = {
    user_id: input.user_id,
    contractor_id: input.contractor_id,
    contract_id: input.contract_id ?? null,
    to_user_phone: input.to_user_phone,
    to_contractor_phone: input.to_contractor_phone,
    from_phone: input.from_phone,
    context: input.context ?? {},
  };
  const res = await fetch(`${url}/rest/v1/calls`, {
    method: "POST",
    headers: {
      ...adminHeaders(serviceRoleKey),
      Prefer: "return=representation",
    },
    body: JSON.stringify([row]),
  });
  if (!res.ok) {
    console.error("calls insert failed:", res.status, await res.text());
    return null;
  }
  const rows = (await res.json()) as CallRow[];
  return rows[0] ?? null;
}

export async function getCallById(id: string): Promise<CallRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/calls?id=eq.${encodeURIComponent(id)}&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as CallRow[];
  return rows[0] ?? null;
}

export async function getCallByTwilioSid(args: {
  participant: "user" | "contractor" | "six";
  sid: string;
}): Promise<CallRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const col =
    args.participant === "user"
      ? "twilio_call_sid_user"
      : args.participant === "contractor"
        ? "twilio_call_sid_contractor"
        : "twilio_call_sid_six";
  const res = await fetch(
    `${url}/rest/v1/calls?${col}=eq.${encodeURIComponent(args.sid)}&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as CallRow[];
  return rows[0] ?? null;
}

// ─── Call consent ledger (MD §10-402 all-party consent — CRIMINAL statute;
// recording/transcription may only run when EVERY party's row says yes).
// G order 2026-07-02 night; Herm TASK_088/092 legal gates. ──────────────

export type CallConsentParty = "user" | "contractor";
export type CallConsentMethod = "app_sheet" | "dtmf" | "speech" | "timeout";

export type CallConsentRow = {
  id: string;
  call_id: string;
  party: CallConsentParty;
  consented: boolean;
  method: CallConsentMethod;
  consent_version: string;
  created_at: string;
};

export async function recordCallConsent(args: {
  call_id: string;
  party: CallConsentParty;
  consented: boolean;
  method: CallConsentMethod;
  consent_version?: string;
}): Promise<CallConsentRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(`${url}/rest/v1/call_consents`, {
    method: "POST",
    headers: {
      ...adminHeaders(serviceRoleKey),
      Prefer: "return=representation",
    },
    body: JSON.stringify([
      {
        call_id: args.call_id,
        party: args.party,
        consented: args.consented,
        method: args.method,
        consent_version: args.consent_version ?? "v1",
      },
    ]),
  });
  if (!res.ok) {
    console.error("call_consents insert failed:", res.status, await res.text());
    return null;
  }
  const rows = (await res.json()) as CallConsentRow[];
  return rows[0] ?? null;
}

/**
 * Latest consent per party for a call. FAIL-CLOSED: any fetch error reads
 * as "no consent" — recording/transcription must never start on a doubt.
 */
export async function getCallConsents(
  call_id: string,
): Promise<{ user: boolean; contractor: boolean }> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const res = await fetch(
      `${url}/rest/v1/call_consents?call_id=eq.${encodeURIComponent(
        call_id,
      )}&order=created_at.desc,id.desc`,
      { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
    );
    if (!res.ok) return { user: false, contractor: false };
    const rows = (await res.json()) as CallConsentRow[];
    const latest = (party: CallConsentParty) =>
      rows.find((r) => r.party === party)?.consented === true;
    return { user: latest("user"), contractor: latest("contractor") };
  } catch {
    return { user: false, contractor: false };
  }
}

export async function patchCall(
  id: string,
  patch: Partial<
    Pick<
      CallRow,
      | "status"
      | "twilio_conference_sid"
      | "twilio_call_sid_user"
      | "twilio_call_sid_contractor"
      | "twilio_call_sid_six"
      | "six_speaking"
      | "twilio_recording_sid"
      | "twilio_recording_url"
      | "storage_recording_path"
      | "recording_duration_s"
      | "started_at"
      | "ended_at"
      | "context"
    >
  >,
): Promise<CallRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/calls?id=eq.${encodeURIComponent(id)}`,
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
    console.error("calls patch failed:", res.status, await res.text());
    return null;
  }
  const rows = (await res.json()) as CallRow[];
  return rows[0] ?? null;
}

export async function setCallStatus(
  id: string,
  status: CallStatus,
): Promise<CallRow | null> {
  const patch: Parameters<typeof patchCall>[1] = { status };
  if (status === "in_progress") patch.started_at = new Date().toISOString();
  if (
    status === "completed" ||
    status === "failed" ||
    status === "no_answer" ||
    status === "busy" ||
    status === "cancelled"
  ) {
    patch.ended_at = new Date().toISOString();
  }
  return patchCall(id, patch);
}

export async function listRecentCalls(args: {
  user_id: string;
  limit?: number;
}): Promise<CallRow[]> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const qs = new URLSearchParams();
  qs.set("user_id", `eq.${args.user_id}`);
  qs.set("order", "created_at.desc");
  qs.set("limit", String(args.limit ?? 20));
  const res = await fetch(`${url}/rest/v1/calls?${qs.toString()}`, {
    headers: adminHeaders(serviceRoleKey),
    cache: "no-store",
  });
  if (!res.ok) return [];
  return (await res.json()) as CallRow[];
}

// ─── Estimates (M3.6) ───────────────────────────────────────────────

function recomputeEstimateTotals(input: CreateEstimateInput): {
  subtotal_cents: number;
  total_cents: number;
} {
  const subtotal = input.line_items.reduce(
    (acc, li) => acc + (li.total_cents || 0),
    0,
  );
  const total = subtotal + (input.tax_cents ?? 0);
  return { subtotal_cents: subtotal, total_cents: total };
}

export async function createEstimate(
  input: CreateEstimateInput,
): Promise<EstimateRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const totals = recomputeEstimateTotals(input);
  const row = {
    user_id: input.user_id,
    contractor_id: input.contractor_id,
    call_id: input.call_id,
    scope_summary: input.scope_summary,
    line_items: input.line_items,
    subtotal_cents: totals.subtotal_cents,
    tax_cents: input.tax_cents ?? 0,
    total_cents: totals.total_cents,
    currency: (input.currency ?? "USD").toUpperCase(),
    source: "call",
    context: input.context ?? {},
  };
  const res = await fetch(`${url}/rest/v1/estimates`, {
    method: "POST",
    headers: {
      ...adminHeaders(serviceRoleKey),
      Prefer: "return=representation",
    },
    body: JSON.stringify([row]),
  });
  if (!res.ok) {
    console.error("estimates insert failed:", res.status, await res.text());
    return null;
  }
  const rows = (await res.json()) as EstimateRow[];
  return rows[0] ?? null;
}

export async function getEstimateById(
  id: string,
): Promise<EstimateRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/estimates?id=eq.${encodeURIComponent(id)}&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as EstimateRow[];
  return rows[0] ?? null;
}

export async function setEstimateStatus(
  id: string,
  status: EstimateStatus,
): Promise<EstimateRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/estimates?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify({ status }),
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as EstimateRow[];
  return rows[0] ?? null;
}
