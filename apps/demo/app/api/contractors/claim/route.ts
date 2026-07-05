import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../src/lib/rateLimit";
import { getUserId } from "../../../../src/lib/auth/getUser";
import { attemptClaim } from "../../../../src/lib/contractors/claim";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * POST /api/contractors/claim (M4.0c)
 *
 * The signed-in user claims a contractor profile. Either:
 *   - Provide `license_number` + `license_issuing_state` (strongest path)
 *   - OR provide `contractor_id` (when picking from a search result —
 *     match strength then depends on email/phone/owner-name overlap)
 *
 * Body:
 *   {
 *     license_number?: string,
 *     license_issuing_state?: "CA" | "TX" | "FL" | "NY" | ...,
 *     contractor_id?: uuid
 *   }
 *
 * Response:
 *   - { ok: true, contractor_id, status: "claimed" }                  // auto-approved
 *   - { ok: true, contractor_id, status: "pending_review", reasons }  // admin needs to confirm
 *   - { error: ... } on rejection / invalid input
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(request: NextRequest) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  const userId = await getUserId();
  if (!userId) return bad("sign-in required", 401);

  let body: {
    license_number?: unknown;
    license_issuing_state?: unknown;
    contractor_id?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return bad("invalid JSON");
  }

  const licenseNumber =
    typeof body.license_number === "string" && body.license_number.trim() !== ""
      ? body.license_number.trim()
      : null;
  const licenseState =
    typeof body.license_issuing_state === "string" &&
    body.license_issuing_state.trim().length >= 2
      ? body.license_issuing_state.trim().toUpperCase()
      : null;
  const contractorId =
    typeof body.contractor_id === "string" && UUID_RE.test(body.contractor_id)
      ? body.contractor_id
      : null;

  if (!licenseNumber && !contractorId) {
    return bad(
      "either license_number + license_issuing_state, or contractor_id, is required",
    );
  }
  if (licenseNumber && !licenseState) {
    return bad("license_issuing_state is required when license_number is provided");
  }

  const result = await attemptClaim({
    user_id: userId,
    contractor_id: contractorId,
    license_number: licenseNumber,
    license_issuing_state: licenseState,
  });

  if (result.kind === "invalid") {
    return bad(result.reason, 422);
  }
  if (result.kind === "rejected") {
    return bad(result.reason, 409);
  }
  if (result.kind === "auto_approved") {
    return NextResponse.json({
      ok: true,
      contractor_id: result.contractor_id,
      status: "claimed",
    });
  }
  return NextResponse.json({
    ok: true,
    contractor_id: result.contractor_id,
    status: "pending_review",
    reasons: result.reasons,
  });
}
