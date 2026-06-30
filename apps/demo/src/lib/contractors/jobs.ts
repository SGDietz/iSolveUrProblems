import { getSupabaseAdminConfig } from "../supabaseAdmin";

/**
 * M4.0d — Contractor-side job views.
 *
 * Reads from existing tables (contracts, appointments) filtered to a
 * specific contractor. Adapts the shapes to a contractor-facing view
 * (status names like "pending invitation", "active", "completed").
 */

export type ContractorJobView = {
  contract_id: string;
  contract_status:
    | "pending"
    | "paid"
    | "failed"
    | "refunded"
    | "canceled";
  user_id: string;
  category: string;
  amount_cents: number;
  platform_fee_cents: number;
  currency: string;
  scope: string | null;
  esign_envelope_status: string | null;
  paid_at: string | null;
  created_at: string;
  /** Most-recent upcoming appointment tied to this contract, if any. */
  next_appointment_at: string | null;
  /** Id of that next appointment (for M4.3 checklist tile, etc.) */
  next_appointment_id: string | null;
  /** Agenda of that appointment, surfaced so the dashboard tile can describe it. */
  next_appointment_agenda: string | null;
};

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

export async function listContractorJobs(args: {
  contractor_id: string;
  limit?: number;
}): Promise<ContractorJobView[]> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const qs = new URLSearchParams();
  qs.set("contractor_id", `eq.${args.contractor_id}`);
  qs.set(
    "select",
    "id,status,user_id,category,amount_cents,platform_fee_cents,currency,scope,esign_envelope_status,paid_at,created_at",
  );
  qs.set("order", "created_at.desc");
  qs.set("limit", String(Math.min(args.limit ?? 30, 100)));
  const res = await fetch(`${url}/rest/v1/contracts?${qs.toString()}`, {
    headers: adminHeaders(serviceRoleKey),
    cache: "no-store",
  });
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<{
    id: string;
    status: ContractorJobView["contract_status"];
    user_id: string;
    category: string;
    amount_cents: number;
    platform_fee_cents: number;
    currency: string;
    scope: string | null;
    esign_envelope_status: string | null;
    paid_at: string | null;
    created_at: string;
  }>;

  // Fetch next-appointment per contract in one call (small N — fine).
  if (rows.length === 0) return [];
  const contractIds = rows.map((r) => r.id);
  const apptUrl = new URL(`${url}/rest/v1/appointments`);
  apptUrl.searchParams.set("contract_id", `in.(${contractIds.join(",")})`);
  apptUrl.searchParams.set("status", "eq.scheduled");
  apptUrl.searchParams.set("scheduled_at", `gt.${new Date().toISOString()}`);
  apptUrl.searchParams.set("select", "id,contract_id,scheduled_at,agenda");
  apptUrl.searchParams.set("order", "scheduled_at.asc");
  const apptRes = await fetch(apptUrl.toString(), {
    headers: adminHeaders(serviceRoleKey),
    cache: "no-store",
  });
  const apptRows = apptRes.ok
    ? ((await apptRes.json()) as Array<{
        id: string;
        contract_id: string;
        scheduled_at: string;
        agenda: string;
      }>)
    : [];
  type NextAppt = { id: string; scheduled_at: string; agenda: string };
  const nextByContract = new Map<string, NextAppt>();
  for (const a of apptRows) {
    if (!nextByContract.has(a.contract_id)) {
      nextByContract.set(a.contract_id, {
        id: a.id,
        scheduled_at: a.scheduled_at,
        agenda: a.agenda,
      });
    }
  }

  return rows.map((r) => {
    const next = nextByContract.get(r.id) ?? null;
    return {
      contract_id: r.id,
      contract_status: r.status,
      user_id: r.user_id,
      category: r.category,
      amount_cents: r.amount_cents,
      platform_fee_cents: r.platform_fee_cents,
      currency: r.currency,
      scope: r.scope,
      esign_envelope_status: r.esign_envelope_status,
      paid_at: r.paid_at,
      created_at: r.created_at,
      next_appointment_at: next?.scheduled_at ?? null,
      next_appointment_id: next?.id ?? null,
      next_appointment_agenda: next?.agenda ?? null,
    };
  });
}

export async function getContractorById(id: string): Promise<{
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  city: string | null;
  state: string | null;
  license_number: string | null;
  license_issuing_state: string | null;
  license_status: string | null;
  stripe_connect_account_id: string | null;
  stripe_charges_enabled: boolean | null;
} | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(id)}&select=id,name,email,phone,city,state,license_number,license_issuing_state,license_status,stripe_connect_account_id,stripe_charges_enabled&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{
    id: string;
    name: string;
    email: string | null;
    phone: string | null;
    city: string | null;
    state: string | null;
    license_number: string | null;
    license_issuing_state: string | null;
    license_status: string | null;
    stripe_connect_account_id: string | null;
    stripe_charges_enabled: boolean | null;
  }>;
  return rows[0] ?? null;
}
