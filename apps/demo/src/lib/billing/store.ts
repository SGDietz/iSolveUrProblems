import { getSupabaseAdminConfig } from "../supabaseAdmin";
import { isActiveStatus, tierFromPriceId, type Tier } from "./tiers";

/**
 * M4.1 — contractor_billing_subscriptions persistence.
 *
 * Mirror of Stripe Billing's source of truth, kept in sync via webhook.
 * The DB row gives us:
 *   - tier-gate lookups without an API call per request
 *   - a queryable view of who's on what tier
 *   - graceful degrade if Stripe is briefly unavailable
 */

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "incomplete"
  | "incomplete_expired"
  | "unpaid"
  | "paused";

export type SubscriptionRow = {
  id: string;
  contractor_id: string;
  stripe_subscription_id: string;
  stripe_customer_id: string;
  stripe_price_id: string;
  tier: Tier;
  status: SubscriptionStatus;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  trial_end: string | null;
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

export async function getContractorByStripeBillingCustomer(
  customer_id: string,
): Promise<{ id: string; stripe_billing_customer_id: string | null } | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/contractors?stripe_billing_customer_id=eq.${encodeURIComponent(customer_id)}&select=id,stripe_billing_customer_id&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{
    id: string;
    stripe_billing_customer_id: string | null;
  }>;
  return rows[0] ?? null;
}

export async function setContractorBillingCustomerId(args: {
  contractor_id: string;
  stripe_billing_customer_id: string;
}): Promise<boolean> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(args.contractor_id)}`,
    {
      method: "PATCH",
      headers: { ...adminHeaders(serviceRoleKey), Prefer: "return=minimal" },
      body: JSON.stringify({
        stripe_billing_customer_id: args.stripe_billing_customer_id,
      }),
    },
  );
  return res.ok;
}

export async function getActiveSubscriptionForContractor(
  contractor_id: string,
): Promise<SubscriptionRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const qs = new URLSearchParams();
  qs.set("contractor_id", `eq.${contractor_id}`);
  qs.set("status", "in.(trialing,active,past_due)");
  qs.set("order", "updated_at.desc");
  qs.set("limit", "1");
  const res = await fetch(
    `${url}/rest/v1/contractor_billing_subscriptions?${qs.toString()}`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as SubscriptionRow[];
  return rows[0] ?? null;
}

/**
 * Top-level tier lookup. Used by every gated feature in M4.2-M4.9.
 * Returns "free" when there's no active subscription, regardless of
 * past subscriptions.
 */
export async function getActiveTierForContractor(
  contractor_id: string,
): Promise<Tier> {
  const sub = await getActiveSubscriptionForContractor(contractor_id);
  if (!sub) return "free";
  if (!isActiveStatus(sub.status)) return "free";
  return sub.tier;
}

export type UpsertSubscriptionInput = {
  contractor_id: string;
  stripe_subscription_id: string;
  stripe_customer_id: string;
  stripe_price_id: string;
  status: SubscriptionStatus;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  canceled_at: string | null;
  trial_end: string | null;
};

/**
 * Idempotent upsert keyed by stripe_subscription_id. Called by the
 * webhook on every `customer.subscription.{created,updated,deleted}`.
 */
export async function upsertSubscription(
  input: UpsertSubscriptionInput,
): Promise<SubscriptionRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const tier = tierFromPriceId(input.stripe_price_id);
  const row = {
    contractor_id: input.contractor_id,
    stripe_subscription_id: input.stripe_subscription_id,
    stripe_customer_id: input.stripe_customer_id,
    stripe_price_id: input.stripe_price_id,
    tier,
    status: input.status,
    current_period_start: input.current_period_start,
    current_period_end: input.current_period_end,
    cancel_at_period_end: input.cancel_at_period_end,
    canceled_at: input.canceled_at,
    trial_end: input.trial_end,
  };
  const res = await fetch(
    `${url}/rest/v1/contractor_billing_subscriptions?on_conflict=stripe_subscription_id`,
    {
      method: "POST",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify([row]),
    },
  );
  if (!res.ok) {
    console.error(
      "[billing/store] upsertSubscription failed:",
      res.status,
      await res.text().catch(() => ""),
    );
    return null;
  }
  const rows = (await res.json()) as SubscriptionRow[];
  return rows[0] ?? null;
}
