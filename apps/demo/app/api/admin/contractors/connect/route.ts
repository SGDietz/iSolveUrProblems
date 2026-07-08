import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_SECRET } from "../../../secrets";
import {
  isStripeConfigured,
  retrieveAccount,
  setContractorStripeConnect,
} from "../../../../../src/lib/payments";
import { verifyAdminBearer } from "../../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../../src/lib/rateLimit";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/admin/contractors/connect
 *
 * Manually attach an existing Stripe Connect account to a contractor.
 * Useful for v1 testing when SG Dietz hands over Stripe keys — Bert
 * can spin up a Connect test account in the Stripe dashboard, take
 * its acct_... id, and wire it to any contractor row to test the
 * homeowner-side hire + pay flow end-to-end.
 *
 * Auth: bearer ADMIN_SECRET (constant-time compare) + rate limit.
 *
 * DELIBERATELY no assertAllowedOrigin (audited 2026-07-02): admin routes
 * are machine-called (curl/scripts) with an explicit secret header. A
 * browser CSRF attack cannot attach an Authorization header, so the
 * bearer check already blocks everything the origin guard would — while
 * the origin guard would 403 legitimate originless curl calls in prod.
 * Same posture as /api/contractors/[id]/onboard and the cron route.
 *
 * Body:
 *   {
 *     contractor_id: uuid,
 *     stripe_connect_account_id: "acct_..."
 *   }
 *
 * Verifies the account is live on Stripe, then writes the id +
 * payouts_enabled flag onto the contractor row.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(request: NextRequest) {
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  if (!ADMIN_SECRET) return bad("ADMIN_SECRET not configured", 503);
  if (!verifyAdminBearer(request.headers.get("authorization"), ADMIN_SECRET).ok) {
    return bad("unauthorized", 401);
  }
  if (!isStripeConfigured()) return bad("Payments not yet configured", 503);

  let body: { contractor_id?: unknown; stripe_connect_account_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad("invalid JSON");
  }
  if (
    typeof body.contractor_id !== "string" ||
    !UUID_RE.test(body.contractor_id)
  ) {
    return bad("contractor_id is required (uuid)");
  }
  if (
    typeof body.stripe_connect_account_id !== "string" ||
    !body.stripe_connect_account_id.startsWith("acct_")
  ) {
    return bad("stripe_connect_account_id must look like 'acct_...'");
  }

  const acct = await retrieveAccount(body.stripe_connect_account_id);
  if (!acct.ok) return bad(`stripe retrieve failed: ${acct.error}`, 502);

  try {
    await setContractorStripeConnect({
      contractor_id: body.contractor_id,
      stripe_connect_account_id: acct.data.id,
      charges_enabled: acct.data.charges_enabled,
      payouts_enabled: acct.data.payouts_enabled,
      onboarded_at: acct.data.details_submitted ? new Date().toISOString() : null,
    });
  } catch (e) {
    return bad(
      e instanceof Error ? e.message : "persist stripe id failed",
      500,
    );
  }

  return NextResponse.json({
    contractor_id: body.contractor_id,
    stripe_connect_account_id: acct.data.id,
    charges_enabled: acct.data.charges_enabled,
    payouts_enabled: acct.data.payouts_enabled,
    details_submitted: acct.data.details_submitted,
  });
}
