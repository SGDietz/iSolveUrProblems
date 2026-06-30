import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../../src/lib/apiRouteSecurity";
import { getUserId } from "../../../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../../../src/lib/supabaseAdmin";
import {
  getAppointmentById,
  getChecklistByAppointmentId,
  generateChecklist,
} from "../../../../../src/lib/appointments";

export const dynamic = "force-dynamic";

/**
 * GET /api/appointments/[id]/checklist (M4.3)
 *
 * Returns the pre-departure checklist for an appointment. Caller must
 * be the homeowner who owns the appointment OR the claimed contractor
 * for it. Anyone else gets 403.
 *
 * If the row doesn't exist yet, returns { row: null } (UI shows the
 * "generate" CTA).
 */

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function fetchUserContractorId(userId: string): Promise<string | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/users?id=eq.${encodeURIComponent(
      userId,
    )}&select=contractor_id,role&limit=1`,
    {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      cache: "no-store",
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{
    contractor_id: string | null;
    role: string;
  }>;
  return rows[0]?.contractor_id ?? null;
}

async function authorize(
  appointment_id: string,
  user_id: string,
): Promise<{
  appointment_id: string;
  contractor_id: string;
  agenda: string;
  contract_id: string | null;
} | null> {
  // Fast path: caller is the homeowner.
  const owned = await getAppointmentById(appointment_id, user_id);
  if (owned && owned.contractor_id) {
    return {
      appointment_id,
      contractor_id: owned.contractor_id,
      agenda: owned.agenda,
      contract_id: owned.contract_id,
    };
  }

  // Slow path: caller is the claimed contractor for this appointment.
  const contractorId = await fetchUserContractorId(user_id);
  if (!contractorId) return null;
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/appointments?id=eq.${encodeURIComponent(
      appointment_id,
    )}&contractor_id=eq.${encodeURIComponent(
      contractorId,
    )}&select=id,contractor_id,agenda,contract_id&limit=1`,
    {
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      cache: "no-store",
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{
    id: string;
    contractor_id: string;
    agenda: string;
    contract_id: string | null;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    appointment_id: row.id,
    contractor_id: row.contractor_id,
    agenda: row.agenda,
    contract_id: row.contract_id,
  };
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const userId = await getUserId();
  if (!userId) return bad("sign-in required", 401);
  const { id } = await ctx.params;
  const authz = await authorize(id, userId);
  if (!authz) return bad("forbidden", 403);
  const row = await getChecklistByAppointmentId(id);
  return NextResponse.json({ row });
}

/**
 * POST /api/appointments/[id]/checklist (M4.3)
 *
 * Manually generate (or regenerate) the checklist for this appointment.
 * Body: { force?: boolean }
 *
 * Same authorization as GET. Returns the row or a structured `error`
 * payload if generation was tier-gated / LLM failed.
 */
export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const userId = await getUserId();
  if (!userId) return bad("sign-in required", 401);
  const { id } = await ctx.params;
  const authz = await authorize(id, userId);
  if (!authz) return bad("forbidden", 403);

  let body: { force?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    // empty body is fine
  }
  const force = body.force === true;

  // Pull contract scope + contractor category for the prompt.
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const [scope, category] = await Promise.all([
    (async () => {
      if (!authz.contract_id) return null;
      const r = await fetch(
        `${url}/rest/v1/contracts?id=eq.${encodeURIComponent(
          authz.contract_id,
        )}&select=scope&limit=1`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
          },
          cache: "no-store",
        },
      );
      if (!r.ok) return null;
      const rows = (await r.json()) as Array<{ scope: string | null }>;
      return rows[0]?.scope ?? null;
    })(),
    (async () => {
      const r = await fetch(
        `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(
          authz.contractor_id,
        )}&select=categories&limit=1`,
        {
          headers: {
            apikey: serviceRoleKey,
            Authorization: `Bearer ${serviceRoleKey}`,
          },
          cache: "no-store",
        },
      );
      if (!r.ok) return null;
      const rows = (await r.json()) as Array<{ categories: string[] | null }>;
      return rows[0]?.categories?.[0] ?? null;
    })(),
  ]);

  const result = await generateChecklist({
    appointment_id: id,
    contractor_id: authz.contractor_id,
    agenda: authz.agenda,
    scope,
    category,
    force,
    reason: "manual",
  });
  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.reason,
        debug: "debug" in result ? result.debug : undefined,
      },
      { status: result.reason === "tier_gate" ? 402 : 500 },
    );
  }
  return NextResponse.json({ row: result.row, generated: result.generated });
}
