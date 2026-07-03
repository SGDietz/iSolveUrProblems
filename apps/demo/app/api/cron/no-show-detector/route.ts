import { NextResponse, type NextRequest } from "next/server";
import { CRON_SECRET } from "../../secrets";
import { verifyAdminBearer } from "../../../../src/lib/apiRouteSecurity";
import {
  declareNoShowAndDispatch,
  findNoShowCandidates,
} from "../../../../src/lib/appointments";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron/no-show-detector (M4.4)
 *
 * Vision ¶33: "If contractors don't show, 6 will get contractors that do."
 *
 * Cadence (recommended): every 5 minutes. Each pass:
 *   1. Query appointments past scheduled_at + 30 min grace, still marked
 *      scheduled/rescheduled, with no contractor_confirmed_at.
 *   2. For each candidate, atomically flip status='no_show' (CAS on
 *      no_show_detected_at IS NULL) and — on the winning update — run
 *      the backup dispatch fan-out.
 *
 * Idempotency: appointments.no_show_detected_at is the write-once gate.
 * Once written, subsequent cron passes skip the row (partial index
 * already excludes it). Homeowner-initiated reports (/api/appointments
 * /[id]/no-show) race against this cron via the same CAS.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}.
 */

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function GET(request: NextRequest) {
  if (!CRON_SECRET) return bad("CRON_SECRET not configured", 503);
  if (!verifyAdminBearer(request.headers.get("authorization"), CRON_SECRET).ok) {
    return bad("unauthorized", 401);
  }

  const candidates = await findNoShowCandidates();
  const results = await Promise.all(
    candidates.map((appt) =>
      declareNoShowAndDispatch({
        appointment_id: appt.id,
        trigger: "cron_grace_expired",
        reasonContext: {
          grace_minutes: appt.grace_minutes,
          scheduled_at: appt.scheduled_at,
        },
      }),
    ),
  );

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    considered: candidates.length,
    results,
  });
}
