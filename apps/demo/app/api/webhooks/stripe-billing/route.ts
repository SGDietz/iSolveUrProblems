import { NextResponse, type NextRequest } from "next/server";
import { STRIPE_BILLING_WEBHOOK_SECRET } from "../../../api/secrets";
import { verifyStripeSignature } from "../../../../src/lib/payments/webhookSig";
import {
  getContractorByStripeBillingCustomer,
  retrieveSubscription,
  upsertSubscription,
  type SubscriptionStatus,
} from "../../../../src/lib/billing";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/webhooks/stripe-billing (M4.1)
 *
 * Stripe Billing webhook sink. Separate endpoint from the M2.5
 * Connect webhook because:
 *   - Billing events and Connect events use different webhook secrets
 *     (Stripe issues one per endpoint)
 *   - Different event vocabularies — Billing has subscription.* /
 *     invoice.*; Connect has account.updated / payout.paid
 *   - Easier to grant Stripe support read access to one without the other
 *
 * Events handled here:
 *   customer.subscription.created   — new sub, persist + set tier
 *   customer.subscription.updated   — status/tier/period change
 *   customer.subscription.deleted   — sub ended, mark canceled
 *   invoice.paid                    — period renewed, refresh
 *   invoice.payment_failed          — past_due (mirror via the sub.updated
 *                                     event Stripe also emits, but log it)
 *
 * Returns 200 quickly so Stripe doesn't retry unnecessarily. Any
 * internal error after signature verification is logged but still
 * returns 2xx unless the event was structurally invalid.
 */

type StripeEvent = {
  id: string;
  type: string;
  data: {
    object: {
      id?: string;
      customer?: string;
      status?: string;
      cancel_at_period_end?: boolean;
      canceled_at?: number | null;
      current_period_start?: number;
      current_period_end?: number;
      trial_end?: number | null;
      items?: { data: Array<{ price?: { id?: string } }> };
      metadata?: Record<string, string>;
      subscription?: string; // present on invoice.* events
    };
  };
};

function unixToIso(n: number | null | undefined): string | null {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return new Date(n * 1000).toISOString();
}

async function handleSubscriptionEvent(args: {
  subscription: NonNullable<StripeEvent["data"]>["object"];
  deletedEvent: boolean;
}): Promise<{ ok: boolean; reason?: string }> {
  const sub = args.subscription;
  if (!sub.id || !sub.customer) {
    return { ok: false, reason: "subscription event missing id/customer" };
  }

  // Resolve contractor_id — try metadata first (set during checkout
  // create), fall back to looking up by Stripe customer id.
  let contractorId =
    typeof sub.metadata?.contractor_id === "string"
      ? sub.metadata.contractor_id
      : null;
  if (!contractorId) {
    const matched = await getContractorByStripeBillingCustomer(sub.customer);
    contractorId = matched?.id ?? null;
  }
  if (!contractorId) {
    return {
      ok: false,
      reason: `no contractor mapped to customer ${sub.customer}`,
    };
  }

  const priceId = sub.items?.data?.[0]?.price?.id ?? "";
  const status = (args.deletedEvent ? "canceled" : sub.status) as SubscriptionStatus | undefined;
  if (!status) return { ok: false, reason: "subscription has no status" };

  await upsertSubscription({
    contractor_id: contractorId,
    stripe_subscription_id: sub.id,
    stripe_customer_id: sub.customer,
    stripe_price_id: priceId,
    status,
    current_period_start: unixToIso(sub.current_period_start),
    current_period_end: unixToIso(sub.current_period_end),
    cancel_at_period_end: !!sub.cancel_at_period_end,
    canceled_at: unixToIso(sub.canceled_at),
    trial_end: unixToIso(sub.trial_end),
  });
  return { ok: true };
}

async function handleInvoicePaid(args: {
  invoice: StripeEvent["data"]["object"];
}): Promise<{ ok: boolean; reason?: string }> {
  // An invoice.paid event signals the subscription's period rolled
  // over. We pull the subscription back from Stripe to get fresh
  // period boundaries + status.
  const subscriptionId =
    typeof args.invoice.subscription === "string"
      ? args.invoice.subscription
      : null;
  if (!subscriptionId) return { ok: true }; // one-off invoice, not ours

  const fresh = await retrieveSubscription(subscriptionId);
  if (!fresh.ok) {
    return { ok: false, reason: `retrieveSubscription: ${fresh.error}` };
  }
  return handleSubscriptionEvent({
    subscription: fresh.data as unknown as StripeEvent["data"]["object"],
    deletedEvent: false,
  });
}

export async function POST(request: NextRequest) {
  if (!STRIPE_BILLING_WEBHOOK_SECRET) {
    console.warn(
      "[stripe-billing] STRIPE_BILLING_WEBHOOK_SECRET not set — refusing webhook",
    );
    return NextResponse.json(
      { error: "billing webhook secret not configured" },
      { status: 503 },
    );
  }

  const rawBody = await request.text();
  const sig = request.headers.get("stripe-signature");
  const verified = verifyStripeSignature({
    rawBody,
    header: sig,
    secret: STRIPE_BILLING_WEBHOOK_SECRET,
  });
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const r = await handleSubscriptionEvent({
        subscription: event.data.object,
        deletedEvent: false,
      });
      if (!r.ok) console.warn("[stripe-billing] sub upsert:", r.reason);
      break;
    }
    case "customer.subscription.deleted": {
      const r = await handleSubscriptionEvent({
        subscription: event.data.object,
        deletedEvent: true,
      });
      if (!r.ok) console.warn("[stripe-billing] sub delete:", r.reason);
      break;
    }
    case "invoice.paid": {
      const r = await handleInvoicePaid({ invoice: event.data.object });
      if (!r.ok) console.warn("[stripe-billing] invoice.paid:", r.reason);
      break;
    }
    case "invoice.payment_failed": {
      // Stripe also emits subscription.updated with status=past_due —
      // we log here for audit but rely on the subscription event for
      // the state change.
      console.warn(
        "[stripe-billing] invoice.payment_failed",
        event.data.object.id,
      );
      break;
    }
    default:
      // Unknown event type — 200 it so Stripe doesn't retry.
      break;
  }

  return NextResponse.json({ ok: true });
}
