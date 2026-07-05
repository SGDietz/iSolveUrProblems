import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../src/lib/rateLimit";
import { getUserId } from "../../../../src/lib/auth/getUser";
import { deliberate } from "../../../../src/lib/contractors";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/contractors/deliberate (M3.8)
 *
 * Vision ¶18 — "help the user work through uncertainties and come to
 * decisions."
 *
 * Body:
 *   {
 *     category: string,                       // required
 *     near: { lat: number, lng: number },     // required (no default center)
 *     constraints?: {
 *       locally_owned?: boolean,
 *       same_day?: boolean,
 *       min_rating?: number,                  // 0..5
 *       max_price_tier?: 1|2|3|4,
 *       max_distance_km?: number,
 *       exclude_ids?: uuid[]
 *     },
 *     current_pick_ids?: uuid[]               // optional — what's on screen
 *   }
 *
 * Returns:
 *   DeliberateResult
 *
 * The orchestrator calls this in-process via the lib function; this
 * route is the standalone diagnostic surface (smoke tests, debug tools).
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

  let body: {
    category?: unknown;
    near?: unknown;
    constraints?: unknown;
    current_pick_ids?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return bad("invalid JSON");
  }

  if (typeof body.category !== "string" || body.category.trim() === "") {
    return bad("category is required");
  }

  const near =
    typeof body.near === "object" &&
    body.near !== null &&
    typeof (body.near as { lat?: unknown }).lat === "number" &&
    typeof (body.near as { lng?: unknown }).lng === "number"
      ? (body.near as { lat: number; lng: number })
      : undefined;
  // No default center — the caller must supply a real ranking center (reality
  // doctrine: never rank near Austin/default).
  if (!near) {
    return bad("near { lat, lng } is required");
  }

  const constraintsRaw =
    typeof body.constraints === "object" && body.constraints !== null
      ? (body.constraints as Record<string, unknown>)
      : {};
  const constraints: import("../../../../src/lib/contractors").DeliberateConstraints =
    {
      locally_owned:
        typeof constraintsRaw.locally_owned === "boolean"
          ? constraintsRaw.locally_owned
          : undefined,
      same_day:
        typeof constraintsRaw.same_day === "boolean"
          ? constraintsRaw.same_day
          : undefined,
      min_rating:
        typeof constraintsRaw.min_rating === "number"
          ? constraintsRaw.min_rating
          : undefined,
      max_price_tier:
        typeof constraintsRaw.max_price_tier === "number"
          ? (constraintsRaw.max_price_tier as 1 | 2 | 3 | 4)
          : undefined,
      max_distance_km:
        typeof constraintsRaw.max_distance_km === "number"
          ? constraintsRaw.max_distance_km
          : undefined,
      exclude_ids: Array.isArray(constraintsRaw.exclude_ids)
        ? constraintsRaw.exclude_ids.filter(
            (x): x is string => typeof x === "string" && UUID_RE.test(x),
          )
        : undefined,
    };

  const current_pick_ids = Array.isArray(body.current_pick_ids)
    ? body.current_pick_ids.filter(
        (x): x is string => typeof x === "string" && UUID_RE.test(x),
      )
    : undefined;

  const userId = await getUserId();
  const result = await deliberate({
    user_id: userId,
    category: body.category.trim(),
    near,
    constraints,
    current_pick_ids,
  });

  if (!result.ok) {
    return NextResponse.json(result, { status: 422 });
  }
  return NextResponse.json(result);
}
