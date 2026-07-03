import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../../src/lib/rateLimit";
import { getUserId } from "../../../../../src/lib/auth/getUser";
import {
  declareNoShowAndDispatch,
  getAppointmentById,
} from "../../../../../src/lib/appointments";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/appointments/[id]/no-show (M4.4)
 *
 * Vision ¶33: "If contractors don't show, 6 will get contractors that do."
 *
 * Homeowner-driven trigger. The report_no_show intent (or a dashboard
 * button) hits this route; we verify the caller owns the appointment,
 * then hand off to the same dispatcher the cron uses.
 *
 * Body: { reason?: string, note?: string }
 *
 * Returns the DispatchResult verbatim so the client can render the
 * "invited N substitute contractors" message.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  const userId = await getUserId();
  if (!userId) return bad("sign-in required", 401);

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return bad("invalid appointment id");

  // Ownership check — we don't want a random signed-in user to trigger
  // a dispatch on someone else's appointment.
  const appt = await getAppointmentById(id, userId);
  if (!appt) return bad("appointment not found or not yours", 404);

  let body: { reason?: unknown; note?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // empty body is fine
  }

  const result = await declareNoShowAndDispatch({
    appointment_id: id,
    trigger: "homeowner_report",
    reasonContext: {
      reported_by_user_id: userId,
      reason: typeof body.reason === "string" ? body.reason : null,
      note: typeof body.note === "string" ? body.note : null,
      reported_at: new Date().toISOString(),
    },
  });

  return NextResponse.json(result);
}
