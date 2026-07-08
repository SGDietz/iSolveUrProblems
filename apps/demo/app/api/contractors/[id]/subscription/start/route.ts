import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../../../src/lib/rateLimit";
import { getUserId } from "../../../../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../../../../src/lib/supabaseAdmin";
import {
  createBillingCustomer,
  createSubscriptionCheckout,
  isBillingConfigured,
  priceIdForTier,
  setContractorBillingCustomerId,
  type Tier,
} from "../../../../../../src/lib/billing";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * POST /api/contractors/[id]/subscription/start (M4.1)
 *
 * Creates a Stripe Checkout Session in subscription mode. Returns the
 * URL the contractor must visit to enter payment + confirm. On success
 * Stripe redirects them to /contractor/dashboard?subscribed=1.
 *
 * Auth: the signed-in user must be the claimer of the contractor row.
 *
 * Body: { tier: "bronze" | "silver" | "gold" }
 *
 * Free tier does NOT use this endpoint — it's the default with no
 * subscription row at all.
 *
 * If the contractor doesn't have a Stripe Billing Customer yet, this
 * route creates one on first call (idempotent via Stripe's
 * Idempotency-Key on customer creation).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

type ContractorClaimRow = {
  id: string;
  name: string;
  email: string | null;
  claimed_by_user_id: string | null;
  stripe_billing_customer_id: string | null;
};

async function fetchContractor(
  id: string,
): Promise<ContractorClaimRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(id)}&select=id,name,email,claimed_by_user_id,stripe_billing_customer_id&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as ContractorClaimRow[];
  return rows[0] ?? null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  if (!isBillingConfigured()) {
    return bad("billing not configured (STRIPE_SECRET_KEY missing)", 503);
  }

  const userId = await getUserId();
  if (!userId) return bad("sign-in required", 401);

  const { id: contractorId } = await params;
  if (!UUID_RE.test(contractorId)) return bad("invalid contractor id");

  let body: { tier?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad("invalid JSON");
  }
  const tier = body.tier as Tier | undefined;
  if (tier !== "bronze" && tier !== "silver" && tier !== "gold") {
    return bad("tier must be 'bronze', 'silver', or 'gold'");
  }
  const priceId = priceIdForTier(tier);
  if (!priceId) {
    return bad(
      `STRIPE_PRICE_${tier.toUpperCase()} env var not set — admin must create the Price in Stripe + drop the ID in env`,
      503,
    );
  }

  const contractor = await fetchContractor(contractorId);
  if (!contractor) return bad("contractor not found", 404);
  if (contractor.claimed_by_user_id !== userId) {
    return bad("forbidden — only the claimer can manage this subscription", 403);
  }

  // Ensure Stripe Billing Customer exists.
  let customerId = contractor.stripe_billing_customer_id;
  if (!customerId) {
    const created = await createBillingCustomer({
      contractor_id: contractor.id,
      email: contractor.email,
      name: contractor.name,
    });
    if (!created.ok) {
      return bad(`stripe customer create failed: ${created.error}`, 502);
    }
    customerId = created.data.id;
    await setContractorBillingCustomerId({
      contractor_id: contractor.id,
      stripe_billing_customer_id: customerId,
    });
  }

  const origin = new URL(request.url).origin;
  const checkout = await createSubscriptionCheckout({
    contractor_id: contractor.id,
    customer_id: customerId,
    price_id: priceId,
    success_url: `${origin}/en/contractor/dashboard?subscribed=1`,
    cancel_url: `${origin}/en/contractor/dashboard?subscribed=0`,
    customer_email: contractor.email,
  });
  if (!checkout.ok) {
    return bad(`stripe checkout failed: ${checkout.error}`, 502);
  }

  return NextResponse.json({
    ok: true,
    checkout_url: checkout.data.url,
    session_id: checkout.data.id,
  });
}
