import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../../src/lib/rateLimit";
import { getUserId } from "../../../../../src/lib/auth/getUser";

/**
 * POST /api/calls/go-between/start (M4.9 — FAIL-CLOSED, plan v2 A4)
 *
 * Bert's original implementation dialed both phone legs here. Merge
 * doctrine (Herm TASK_113 §6, G-converged): go-between mediation is
 * DORMANT until (1) FEATURE_GO_BETWEEN_CALLS is flipped, (2) an
 * all-party consent UX exists (MD §10-402 all-party state), and
 * (3) G + legal approve. Until then this route refuses every request —
 * even flag-on requests refuse, because the consent-ledger story for
 * the in-person case has not shipped. The StartButton component is
 * deliberately unmounted; this route is the defense-in-depth layer if
 * anything ever POSTs here anyway.
 */
const GO_BETWEEN_CALLS_ENABLED =
  process.env.FEATURE_GO_BETWEEN_CALLS === "1";

function bad(error: string, status = 400) {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: NextRequest) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const limitErr = await checkRateLimit(request);
  if (limitErr) return limitErr;

  const userId = await getUserId();
  if (!userId) return bad("sign-in required", 401);

  if (!GO_BETWEEN_CALLS_ENABLED) {
    return bad("go-between calls are disabled", 404);
  }
  // Flag on ≠ live: the all-party consent flow (both-party ledger rows
  // BEFORE any leg dials) is not built for the in-person case yet.
  return bad(
    "go-between calls require the all-party consent flow, which has not shipped — no dialing is possible from this route yet",
    403,
  );
}
