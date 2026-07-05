import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../src/lib/rateLimit";
import { getUserId } from "../../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../../src/lib/supabaseAdmin";
import { getActiveTierForContractor } from "../../../../src/lib/billing/store";
import { tierUnlocks } from "../../../../src/lib/billing/tiers";
import { insertCrewRequest, runCrewFanOut } from "../../../../src/lib/crew";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/crew/requests (M4.2)
 *
 * Body:
 *   {
 *     category:       string   (required, e.g. "flooring")
 *     needed_at:      ISO string (required)
 *     radius_km?:     number   (default 40, max 200)
 *     scope?:         string   (up to 500 chars)
 *     appointment_id?: uuid    (optional link to a job appointment)
 *   }
 *
 * Caller must be a claimed contractor on the silver+ tier. On success
 * we create the request row and immediately fan out invitations.
 * Returns { request, fanout } — fanout is what the tile renders.
 */

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function fetchClaimedContractorId(
  userId: string,
): Promise<string | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/users?id=eq.${encodeURIComponent(
      userId,
    )}&select=contractor_id&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ contractor_id: string | null }>;
  return rows[0]?.contractor_id ?? null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  const userId = await getUserId();
  if (!userId) return bad("sign-in required", 401);

  const contractorId = await fetchClaimedContractorId(userId);
  if (!contractorId) return bad("no claimed contractor", 403);

  const tier = await getActiveTierForContractor(contractorId);
  if (!tierUnlocks(tier, "crew_marketplace")) {
    return NextResponse.json(
      { error: "tier_gate", required_tier: "silver" },
      { status: 402 },
    );
  }

  let body: {
    category?: unknown;
    needed_at?: unknown;
    radius_km?: unknown;
    scope?: unknown;
    appointment_id?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return bad("invalid JSON");
  }

  const category = typeof body.category === "string" ? body.category.trim() : "";
  if (!category) return bad("category is required");
  if (typeof body.needed_at !== "string") {
    return bad("needed_at is required (ISO)");
  }
  const when = new Date(body.needed_at);
  if (Number.isNaN(when.getTime())) return bad("needed_at is not a valid date");

  const radiusRaw =
    typeof body.radius_km === "number" ? Math.floor(body.radius_km) : 40;
  const radius_km = Math.max(1, Math.min(200, radiusRaw));

  const scope =
    typeof body.scope === "string" ? body.scope.slice(0, 500) : "";
  const appointment_id =
    typeof body.appointment_id === "string" && UUID_RE.test(body.appointment_id)
      ? body.appointment_id
      : null;

  const row = await insertCrewRequest({
    requester_contractor_id: contractorId,
    requester_user_id: userId,
    category,
    needed_at: when.toISOString(),
    radius_km,
    scope,
    appointment_id,
  });
  if (!row) return bad("couldn't create request", 500);

  const fanout = await runCrewFanOut(row);
  return NextResponse.json({ request: row, fanout });
}
