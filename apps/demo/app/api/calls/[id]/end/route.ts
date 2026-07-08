import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../../src/lib/apiRouteSecurity";
import { getUserId } from "../../../../../src/lib/auth/getUser";
import {
  endConference,
  getCallById,
  setCallStatus,
} from "../../../../../src/lib/calls";
import { checkRateLimit } from "../../../../../src/lib/rateLimit";

export const dynamic = "force-dynamic";

/**
 * POST /api/calls/[id]/end  (M3.1)
 *
 * User-driven hang-up. Tells Twilio to end the conference, which
 * disconnects all three legs. The status webhook will then transition
 * the row to "completed".
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "sign-in required" }, { status: 401 });
  }

  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const call = await getCallById(id);
  if (!call) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (call.user_id !== userId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  if (call.twilio_conference_sid) {
    await endConference({ conferenceSid: call.twilio_conference_sid }).catch(
      () => null,
    );
  }
  await setCallStatus(id, "cancelled");

  return NextResponse.json({ status: "cancelled" });
}
