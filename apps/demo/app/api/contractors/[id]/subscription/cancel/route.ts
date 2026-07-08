import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../../../src/lib/rateLimit";
import { getUserId } from "../../../../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../../../../src/lib/supabaseAdmin";
import {
  cancelSubscriptionAtPeriodEnd,
  getActiveSubscriptionForContractor,
  isBillingConfigured,
} from "../../../../../../src/lib/billing";

export const dynamic = "force-dynamic";

/**
 * POST /api/contractors/[id]/subscription/cancel (M4.1)
 *
 * Cancels-at-period-end. The contractor keeps tier access until their
 * current paid period ends (better UX than yanking features mid-month).
 * Status row is updated reactively by the webhook on
 * `customer.subscription.updated`.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function isClaimerOf(args: {
  contractor_id: string;
  user_id: string;
}): Promise<boolean> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(args.contractor_id)}&claimed_by_user_id=eq.${encodeURIComponent(args.user_id)}&select=id&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    },
  );
  if (!res.ok) return false;
  const rows = (await res.json()) as Array<{ id: string }>;
  return rows.length === 1;
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
    return bad("billing not configured", 503);
  }

  const userId = await getUserId();
  if (!userId) return bad("sign-in required", 401);

  const { id: contractorId } = await params;
  if (!UUID_RE.test(contractorId)) return bad("invalid contractor id");

  if (!(await isClaimerOf({ contractor_id: contractorId, user_id: userId }))) {
    return bad("forbidden", 403);
  }

  const sub = await getActiveSubscriptionForContractor(contractorId);
  if (!sub) return bad("no active subscription to cancel", 404);

  const result = await cancelSubscriptionAtPeriodEnd(sub.stripe_subscription_id);
  if (!result.ok) {
    return bad(`stripe cancel failed: ${result.error}`, 502);
  }

  return NextResponse.json({
    ok: true,
    status: "cancel_scheduled",
    period_ends_at: sub.current_period_end,
  });
}
