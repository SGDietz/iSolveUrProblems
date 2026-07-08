import { NextResponse, type NextRequest } from "next/server";
import { ADMIN_SECRET } from "../../../secrets";
import { verifyAdminBearer } from "../../../../../src/lib/apiRouteSecurity";
import { syncLicenseBoardBatch } from "../../../../../src/lib/contractors/licenseSync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/admin/contractors/sync (M4.0a)
 *
 * Triggers a license-board pull for a state. Runs ONE batch per call;
 * if the response includes a `next_cursor`, call again with that
 * cursor to continue. (Designed for cron / orchestrated runs — one
 * batch fits cleanly inside Vercel's 60s function limit.)
 *
 * Body:
 *   {
 *     state: "CA",                    // required
 *     cursor?: string | null,         // continuation cursor
 *     limit?: number,                 // rows per batch (default 500)
 *     since?: string | null           // only rows updated >= this date (board permitting)
 *   }
 *
 * Auth: bearer token must match ADMIN_SECRET. Without it, 503.
 *
 * Response (success):
 *   {
 *     ok: true,
 *     progress: {
 *       state,
 *       source_display_name,
 *       fetched,
 *       upserted,
 *       skipped,
 *       next_cursor,
 *       duration_ms
 *     }
 *   }
 */

export async function POST(request: NextRequest) {
  if (!ADMIN_SECRET) {
    return NextResponse.json(
      { error: "ADMIN_SECRET not configured" },
      { status: 503 },
    );
  }
  if (!verifyAdminBearer(request.headers.get("authorization"), ADMIN_SECRET).ok) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: {
    state?: unknown;
    cursor?: unknown;
    limit?: unknown;
    since?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }

  if (typeof body.state !== "string" || body.state.length < 2) {
    return NextResponse.json(
      { error: "state is required (2-letter code, e.g. 'CA')" },
      { status: 400 },
    );
  }
  const state = body.state.toUpperCase();

  const cursor =
    typeof body.cursor === "string" && body.cursor.length > 0
      ? body.cursor
      : null;

  const limit =
    typeof body.limit === "number" && body.limit > 0
      ? Math.min(Math.floor(body.limit), 5000)
      : 500;

  const since =
    typeof body.since === "string" && body.since.length > 0
      ? body.since
      : null;

  const result = await syncLicenseBoardBatch({ state, cursor, limit, since });
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 503 });
  }
  return NextResponse.json({ ok: true, progress: result });
}
