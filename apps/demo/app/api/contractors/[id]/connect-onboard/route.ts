import { NextResponse, type NextRequest } from "next/server";
import {
  STRIPE_CONNECT_REFRESH_URL,
  STRIPE_CONNECT_RETURN_URL,
} from "../../../../api/secrets";
import { assertAllowedOrigin } from "../../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../../src/lib/rateLimit";
import { getUserId } from "../../../../../src/lib/auth/getUser";
import {
  createAccountLink,
  createConnectExpressAccount,
  getContractorStripeRow,
  isStripeConfigured,
  setContractorStripeConnect,
} from "../../../../../src/lib/payments";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/contractors/[id]/connect-onboard (M4.0d follow-up)
 *
 * Contractor-self-service Stripe Connect Express onboarding. Same
 * underlying flow as the admin-gated `/onboard` route — creates an
 * Express account if one doesn't exist, then returns a fresh Account
 * Link URL the contractor follows to enter banking + identity info.
 *
 * Difference vs `/onboard`: auth-gated to the *claimer* of the
 * contractor row (the signed-in user must have claimed this profile
 * via M4.0c). Admin bearer is NOT accepted here — admin onboarding
 * stays on the existing admin route.
 *
 * Flow:
 *   1. Auth: signed-in user must equal contractors.claimed_by_user_id
 *   2. Stripe configured + Connect return/refresh URLs set
 *   3. Look up contractor row
 *   4. Ensure stripe_connect_account_id exists (create if missing)
 *   5. Mint Account Link, return URL — client redirects
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
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  if (!isStripeConfigured()) {
    return bad("Payments not yet configured", 503);
  }
  if (!STRIPE_CONNECT_RETURN_URL || !STRIPE_CONNECT_REFRESH_URL) {
    return bad(
      "STRIPE_CONNECT_RETURN_URL and STRIPE_CONNECT_REFRESH_URL must be configured",
      503,
    );
  }

  const userId = await getUserId();
  if (!userId) return bad("sign-in required", 401);

  const { id } = await context.params;
  if (!UUID_RE.test(id)) return bad("invalid contractor id");

  const row = await getContractorStripeRow(id);
  if (!row) return bad("contractor not found", 404);
  if (row.claimed_by_user_id !== userId) {
    return bad("forbidden — only the claimer can onboard this profile", 403);
  }

  let accountId = row.stripe_connect_account_id;
  if (!accountId) {
    const acct = await createConnectExpressAccount({
      email: row.email,
      metadata: {
        contractor_id: row.id,
        source: "iSolveUrProblems",
        initiated_by: "self_service",
      },
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
    onboarding_url: link.data.url,
    expires_at: link.data.expires_at,
  });
}
