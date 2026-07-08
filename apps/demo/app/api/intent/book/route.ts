import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../src/lib/rateLimit";

export const dynamic = "force-dynamic";

/**
 * POST /api/intent/book (M3.0d)
 *
 * REALITY DOCTRINE (G 2026-07-02: no fake data, ever): the old handler
 * returned a SYNTHETIC "booked + everyone notified" payload (delivered:true
 * on nothing sent). That mock path is gone. Until the real M2.6 win/lose
 * fan-out is wired, this endpoint fails CLOSED and honestly — 501, nothing
 * pretended. The voice flow routes users to the real actions that work
 * today: tap-to-call on the card, or 6 placing the call.
 */

export async function POST(request: NextRequest) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  return NextResponse.json(
    {
      error:
        "booking dispatch is not live yet — nothing was sent (real data only; no simulated confirmations)",
    },
    { status: 501 },
  );
}
