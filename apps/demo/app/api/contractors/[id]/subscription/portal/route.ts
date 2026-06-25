import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../../../src/lib/rateLimit";
import { getUserId } from "../../../../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../../../../src/lib/supabaseAdmin";
import {
  createBillingPortalSession,
  isBillingConfigured,
} from "../../../../../../src/lib/billing";

export const dynamic = "force-dynamic";

/**
 * POST /api/contractors/[id]/subscription/portal (M4.1)
 *
 * Returns a Stripe Customer Portal URL the contractor can use to
 * change tier, update payment method, view invoices, or cancel —
 * Stripe-hosted, no UI of ours required for these flows.
 *
 * Requires that the Portal is enabled in the Stripe dashboard:
 *   https://dashboard.stripe.com/settings/billing/portal
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

type ContractorPortalRow = {
  id: string;
  claimed_by_user_id: string | null;
  stripe_billing_customer_id: string | null;
};

async function fetchContractor(
  id: string,
): Promise<ContractorPortalRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(id)}&select=id,claimed_by_user_id,stripe_billing_customer_id&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as ContractorPortalRow[];
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

  if (!isBillingConfigured()) return bad("billing not configured", 503);

  const userId = await getUserId();
  if (!userId) return bad("sign-in required", 401);

  const { id: contractorId } = await params;
  if (!UUID_RE.test(contractorId)) return bad("invalid contractor id");

  const contractor = await fetchContractor(contractorId);
  if (!contractor) return bad("contractor not found", 404);
  if (contractor.claimed_by_user_id !== userId) return bad("forbidden", 403);
  if (!contractor.stripe_billing_customer_id) {
    return bad(
      "no Stripe billing customer yet — subscribe first before opening the portal",
      409,
    );
  }

  const origin = new URL(request.url).origin;
  const session = await createBillingPortalSession({
    customer_id: contractor.stripe_billing_customer_id,
    return_url: `${origin}/en/contractor/dashboard`,
  });
  if (!session.ok) {
    return bad(`stripe portal failed: ${session.error}`, 502);
  }

  return NextResponse.json({ ok: true, portal_url: session.data.url });
}
