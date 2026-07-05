import {
  STRIPE_SECRET_KEY,
  STRIPE_TRIAL_DAYS,
} from "../../../app/api/secrets";

/**
 * M4.1 — Stripe Billing (subscriptions) thin client.
 *
 * Separate file from `payments/stripe.ts` even though both hit the
 * same Stripe API. Reason: M2.5 Connect (payouts TO contractors) and
 * M4.1 Billing (subscriptions FROM contractors) are different product
 * lines in Stripe with different webhook secrets and different event
 * shapes. Keeping the modules separate makes the two-sided money flow
 * easier to reason about + easier to switch one provider without
 * touching the other.
 *
 * Same `sk_*` Stripe Secret Key authenticates both — that's why we
 * don't need a separate STRIPE_BILLING_SECRET_KEY env var.
 */

const STRIPE_API_BASE = "https://api.stripe.com/v1";
const STRIPE_API_VERSION = "2024-06-20";

export function isBillingConfigured(): boolean {
  return STRIPE_SECRET_KEY.length > 0;
}

export type BillingResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string };

function flattenForStripe(
  obj: Record<string, unknown>,
  prefix = "",
): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      pairs.push([key, String(v)]);
    } else if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (item && typeof item === "object") {
          pairs.push(
            ...flattenForStripe(item as Record<string, unknown>, `${key}[${i}]`),
          );
        } else if (item !== undefined && item !== null) {
          pairs.push([`${key}[${i}]`, String(item)]);
        }
      });
    } else if (typeof v === "object") {
      pairs.push(...flattenForStripe(v as Record<string, unknown>, key));
    }
  }
  return pairs;
}

async function billingCall<T>(
  path: string,
  init: {
    method?: "GET" | "POST" | "DELETE";
    body?: Record<string, unknown>;
    idempotencyKey?: string;
  } = {},
): Promise<BillingResult<T>> {
  if (!isBillingConfigured()) {
    return { ok: false, status: 0, error: "stripe billing not configured" };
  }
  const method = init.method ?? "POST";
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
    "Stripe-Version": STRIPE_API_VERSION,
  };
  if (init.idempotencyKey) {
    headers["Idempotency-Key"] = init.idempotencyKey;
  }
  let body: string | undefined;
  if ((method === "POST" || method === "DELETE") && init.body) {
    const params = new URLSearchParams();
    for (const [k, v] of flattenForStripe(init.body)) params.append(k, v);
    body = params.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }
  let res: Response;
  try {
    res = await fetch(`${STRIPE_API_BASE}${path}`, { method, headers, body });
  } catch (e) {
    return {
      ok: false,
      status: 0,
      error: e instanceof Error ? e.message : "stripe fetch threw",
    };
  }
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const errObj = data.error as { message?: string } | undefined;
    return {
      ok: false,
      status: res.status,
      error: errObj?.message ?? `stripe ${res.status}`,
    };
  }
  return { ok: true, data: data as T };
}

export type BillingCustomer = {
  id: string;
  email: string | null;
  name: string | null;
};

export async function createBillingCustomer(args: {
  contractor_id: string;
  email: string | null;
  name: string;
}): Promise<BillingResult<BillingCustomer>> {
  return billingCall<BillingCustomer>("/customers", {
    idempotencyKey: `billing-customer-${args.contractor_id}`,
    body: {
      email: args.email ?? undefined,
      name: args.name,
      metadata: {
        contractor_id: args.contractor_id,
      },
    },
  });
}

export type BillingCheckoutSession = {
  id: string;
  url: string;
  customer: string | null;
  subscription: string | null;
};

/**
 * Create a Checkout Session in subscription mode. The contractor lands
 * on this URL, completes payment, and Stripe redirects them to
 * success_url. The subscription is created server-side via webhook
 * (`customer.subscription.created`), not synchronously from this call.
 */
export async function createSubscriptionCheckout(args: {
  contractor_id: string;
  customer_id: string;
  price_id: string;
  success_url: string;
  cancel_url: string;
  customer_email?: string | null;
}): Promise<BillingResult<BillingCheckoutSession>> {
  const body: Record<string, unknown> = {
    mode: "subscription",
    success_url: args.success_url,
    cancel_url: args.cancel_url,
    customer: args.customer_id,
    line_items: [{ price: args.price_id, quantity: 1 }],
    subscription_data: {
      trial_period_days: STRIPE_TRIAL_DAYS,
      metadata: {
        contractor_id: args.contractor_id,
      },
    },
    metadata: {
      contractor_id: args.contractor_id,
    },
    // Lets the contractor cancel/upgrade themselves later in the
    // Stripe Customer Portal.
    allow_promotion_codes: true,
  };
  return billingCall<BillingCheckoutSession>("/checkout/sessions", {
    idempotencyKey: `billing-checkout-${args.contractor_id}-${args.price_id}`,
    body,
  });
}

export type BillingPortalSession = { id: string; url: string };

/**
 * Stripe Customer Portal — Stripe-hosted self-service page where a
 * contractor can upgrade/downgrade/cancel without touching our UI.
 * Requires that you've enabled the portal in the Stripe dashboard at
 * https://dashboard.stripe.com/settings/billing/portal
 */
export async function createBillingPortalSession(args: {
  customer_id: string;
  return_url: string;
}): Promise<BillingResult<BillingPortalSession>> {
  return billingCall<BillingPortalSession>("/billing_portal/sessions", {
    body: {
      customer: args.customer_id,
      return_url: args.return_url,
    },
  });
}

export type BillingSubscription = {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  canceled_at: number | null;
  current_period_start: number;
  current_period_end: number;
  trial_end: number | null;
  items: {
    data: Array<{
      id: string;
      price: { id: string };
    }>;
  };
  metadata?: Record<string, string>;
};

export async function retrieveSubscription(
  subscription_id: string,
): Promise<BillingResult<BillingSubscription>> {
  return billingCall<BillingSubscription>(`/subscriptions/${subscription_id}`, {
    method: "GET",
  });
}

/**
 * Cancel-at-period-end — the contractor keeps access until the current
 * billing period ends, then the subscription auto-deactivates. Better
 * UX than immediate cancellation (no surprise loss of access).
 */
export async function cancelSubscriptionAtPeriodEnd(
  subscription_id: string,
): Promise<BillingResult<BillingSubscription>> {
  return billingCall<BillingSubscription>(`/subscriptions/${subscription_id}`, {
    body: { cancel_at_period_end: true },
  });
}
