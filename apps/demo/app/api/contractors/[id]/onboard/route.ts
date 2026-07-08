import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_SECRET, STRIPE_CONNECT_REFRESH_URL, STRIPE_CONNECT_RETURN_URL } from "../../../secrets";
import {
  isStripeConfigured,
  createConnectExpressAccount,
  createAccountLink,
  getContractorStripeRow,
  setContractorStripeConnect,
} from "../../../../../src/lib/payments";
import { verifyAdminBearer } from "../../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../../src/lib/rateLimit";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/contractors/[id]/onboard
 *
 * Vision ¶21 contractor side of M2.5 — produces a Stripe Express
 * onboarding Account Link the contractor follows to enter their
 * banking + identity info.
 *
 * Today this is an admin-only endpoint (Bearer ADMIN_SECRET) because
 * we don't yet have contractor-side auth (M3+ work). When contractor
 * onboarding emails ship, the same handler can be flipped to a magic-
 * link gated public route.
 *
 * Flow:
 *   1. Ensure stripe is configured (else 503)
 *   2. Look up the contractor row
 *   3. If no stripe_connect_account_id, create an Express account and
 *      persist the id
 *   4. Create an Account Link and return its URL
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  // Admin-bearer route: rate-limit only (an Origin check would break G's
  // curl-driven admin use; the bearer is the auth).
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;
  if (!ADMIN_SECRET) {
    return bad("ADMIN_SECRET not configured", 503);
  }
  if (!verifyAdminBearer(request.headers.get("authorization"), ADMIN_SECRET).ok) {
    return bad("unauthorized", 401);
  }
  if (!isStripeConfigured()) {
    return bad("Payments not yet configured", 503);
  }
  if (!STRIPE_CONNECT_RETURN_URL || !STRIPE_CONNECT_REFRESH_URL) {
    return bad(
      "STRIPE_CONNECT_RETURN_URL and STRIPE_CONNECT_REFRESH_URL must be configured",
      503,
    );
  }

  const { id } = await context.params;
  if (!UUID_RE.test(id)) return bad("invalid contractor id");

  const row = await getContractorStripeRow(id);
  if (!row) return bad("contractor not found", 404);

  let accountId = row.stripe_connect_account_id;
  if (!accountId) {
    const acct = await createConnectExpressAccount({
      email: row.email,
      metadata: { contractor_id: row.id, source: "iSolveUrProblems" },
    });
    if (!acct.ok) {
      return bad(`stripe account create failed: ${acct.error}`, 502);
    }
    accountId = acct.data.id;
    try {
      await setContractorStripeConnect({
        contractor_id: row.id,
        stripe_connect_account_id: accountId,
        charges_enabled: false,
        payouts_enabled: false,
      });
    } catch (e) {
      return bad(
        e instanceof Error ? e.message : "persist stripe id failed",
        500,
      );
    }
  }

  const link = await createAccountLink({
    account: accountId,
    refreshUrl: STRIPE_CONNECT_REFRESH_URL,
    returnUrl: STRIPE_CONNECT_RETURN_URL,
  });
  if (!link.ok) {
    return bad(`stripe account link failed: ${link.error}`, 502);
  }

  return NextResponse.json({
    contractor_id: row.id,
    stripe_connect_account_id: accountId,
    onboarding_url: link.data.url,
    expires_at: link.data.expires_at,
  });
}
