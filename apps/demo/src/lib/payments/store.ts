import { getSupabaseAdminConfig } from "../supabaseAdmin";
import type { ContractRow, ContractStatus } from "./types";
import type { EsignEnvelopeStatus, ProviderName } from "../esign";

/**
 * Contracts persistence (M2.5). Service-role only — RLS on `contracts`
 * lets the owning user read their own row but all writes go through
 * the server.
 */

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

export async function insertContract(args: {
  user_id: string;
  contractor_id: string;
  category: string;
  amount_cents: number;
  platform_fee_cents: number;
  currency: string;
  candidate_ids: string[];
  context?: Record<string, unknown>;
}): Promise<ContractRow> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(`${url}/rest/v1/contracts`, {
    method: "POST",
    headers: {
      ...adminHeaders(serviceRoleKey),
      Prefer: "return=representation",
    },
    body: JSON.stringify([{ ...args, status: "pending" }]),
  });
  if (!res.ok) {
    throw new Error(`contracts insert ${res.status}: ${await res.text()}`);
  }
  const rows = (await res.json()) as ContractRow[];
  return rows[0];
}

export async function patchContractById(
  id: string,
  patch: Partial<
    Pick<
      ContractRow,
      | "status"
      | "stripe_checkout_session_id"
      | "stripe_payment_intent_id"
      | "stripe_transfer_id"
      | "paid_at"
      | "context"
    >
  >,
): Promise<void> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/contracts?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=minimal",
      },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    throw new Error(`contracts patch ${res.status}: ${await res.text()}`);
  }
}

export async function getContractByCheckoutSession(
  sessionId: string,
): Promise<ContractRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/contracts?stripe_checkout_session_id=eq.${encodeURIComponent(
      sessionId,
    )}&select=*&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) {
    throw new Error(`contracts read ${res.status}`);
  }
  const rows = (await res.json()) as ContractRow[];
  return rows[0] ?? null;
}

export async function getContractByPaymentIntent(
  paymentIntentId: string,
): Promise<ContractRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/contracts?stripe_payment_intent_id=eq.${encodeURIComponent(
      paymentIntentId,
    )}&select=*&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) {
    throw new Error(`contracts read ${res.status}`);
  }
  const rows = (await res.json()) as ContractRow[];
  return rows[0] ?? null;
}

export async function getContractById(
  id: string,
  userId: string,
): Promise<ContractRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/contracts?id=eq.${encodeURIComponent(
      id,
    )}&user_id=eq.${encodeURIComponent(userId)}&select=*&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as ContractRow[];
  return rows[0] ?? null;
}

export async function setContractorStripeConnect(args: {
  contractor_id: string;
  stripe_connect_account_id: string;
  /**
   * Whether the connected account can RECEIVE platform payments
   * (destination charges). This is the gating flag.
   */
  charges_enabled: boolean;
  /**
   * Whether the connected account can PAY OUT to its bank. Informational
   * for now — Stripe verifies this asynchronously and we don't block on it.
   */
  payouts_enabled: boolean;
  onboarded_at?: string | null;
}): Promise<void> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const payload: Record<string, unknown> = {
    stripe_connect_account_id: args.stripe_connect_account_id,
    stripe_charges_enabled: args.charges_enabled,
    payouts_enabled: args.payouts_enabled,
  };
  if (args.onboarded_at !== undefined) {
    payload.stripe_onboarded_at = args.onboarded_at;
  }
  const res = await fetch(
    `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(args.contractor_id)}`,
    {
      method: "PATCH",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    throw new Error(`contractors patch ${res.status}: ${await res.text()}`);
  }
}

export async function getContractorStripeRow(
  contractor_id: string,
): Promise<{
  id: string;
  name: string;
  email: string | null;
  stripe_connect_account_id: string | null;
  stripe_charges_enabled: boolean;
  payouts_enabled: boolean;
  /** M4.0c — populated when the contractor has claimed their profile.
   *  Used by user-gated routes (e.g. /connect-onboard) to authorize
   *  the signed-in user against the row. */
  claimed_by_user_id: string | null;
} | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(
      contractor_id,
    )}&select=id,name,email,stripe_connect_account_id,stripe_charges_enabled,payouts_enabled,claimed_by_user_id&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{
    id: string;
    name: string;
    email: string | null;
    stripe_connect_account_id: string | null;
    stripe_charges_enabled: boolean;
    payouts_enabled: boolean;
    claimed_by_user_id: string | null;
  }>;
  return rows[0] ?? null;
}

export function computePlatformFeeCents(
  amountCents: number,
  feePercent: number,
): number {
  return Math.max(0, Math.floor((amountCents * feePercent) / 100));
}

/**
 * M3.7 — Update a contract with e-signature envelope details after the
 * provider returns. Called from /api/contracts/draft.
 */
export async function setContractEsign(args: {
  contract_id: string;
  user_id: string;
  esign_provider: ProviderName;
  esign_envelope_id: string;
  esign_envelope_status: EsignEnvelopeStatus;
  esign_signing_url_user: string | null;
  esign_signing_url_contractor: string | null;
  scope: string;
  // For mock: provider returns 'signed' immediately, in which case we
  // also stamp signed_at_*.
  stamp_signed_now: boolean;
}): Promise<void> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const now = new Date().toISOString();
  const payload: Record<string, unknown> = {
    scope: args.scope,
    esign_provider: args.esign_provider,
    esign_envelope_id: args.esign_envelope_id,
    esign_envelope_status: args.esign_envelope_status,
    esign_signing_url_user: args.esign_signing_url_user,
    esign_signing_url_contractor: args.esign_signing_url_contractor,
  };
  if (args.stamp_signed_now) {
    payload.signed_at_user = now;
    payload.signed_at_contractor = now;
  }
  const res = await fetch(
    `${url}/rest/v1/contracts?id=eq.${encodeURIComponent(
      args.contract_id,
    )}&user_id=eq.${encodeURIComponent(args.user_id)}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    throw new Error(
      `contracts esign patch ${res.status}: ${await res.text()}`,
    );
  }
}

/**
 * M3.7 — Look up a contract by envelope id, used by the e-sign webhook
 * handler to reconcile status updates back to the contract row.
 */
export async function getContractByEnvelopeId(
  envelope_id: string,
): Promise<ContractRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/contracts?esign_envelope_id=eq.${encodeURIComponent(
      envelope_id,
    )}&select=*&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as ContractRow[];
  return rows[0] ?? null;
}

export function statusFromStripeIntentStatus(
  intentStatus: string | null | undefined,
): ContractStatus {
  switch (intentStatus) {
    case "succeeded":
      return "paid";
    case "canceled":
      return "canceled";
    case "requires_payment_method":
    case "requires_action":
    case "requires_confirmation":
    case "processing":
    case "requires_capture":
      return "pending";
    default:
      return "failed";
  }
}
