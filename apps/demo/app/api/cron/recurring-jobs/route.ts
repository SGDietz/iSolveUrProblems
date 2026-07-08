import { NextResponse, type NextRequest } from "next/server";
import { CRON_SECRET } from "../../secrets";
import { verifyAdminBearer } from "../../../../src/lib/apiRouteSecurity";
import { materializeRecurringJobs } from "../../../../src/lib/recurring";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron/recurring-jobs (M4.7)
 *
 * Vision ¶33: "autopilot ... grass mowed, weeds pulled, gutters cleaned"
 *
 * Cadence: nightly (once per day is fine; a missed run is recovered on
 * the next because we materialize a 7-day forward window). Configured
 * in vercel.json.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}.
 */

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function handle(request: NextRequest) {
  if (!CRON_SECRET) return bad("CRON_SECRET not configured", 503);
  if (!verifyAdminBearer(request.headers.get("authorization"), CRON_SECRET).ok) {
    return bad("unauthorized", 401);
  }
  const stats = await materializeRecurringJobs();
  return NextResponse.json({ ok: true, stats });
}

export const GET = handle;
export const POST = handle;
