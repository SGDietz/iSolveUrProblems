import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../../src/lib/apiRouteSecurity";
import { getUserId } from "../../../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../../../src/lib/supabaseAdmin";
import { listLatestCvLabelsForAppointment } from "../../../../../src/lib/vision";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/appointments/[id]/cv-labels (M4.6)
 *
 * Batch fetch of the latest cv_label per photo entry on this
 * appointment. Replaces the per-photo GET pattern in CvLabelChip so a
 * 20-photo log fires one query instead of 20.
 *
 * Auth: signed-in user must be either the appointment's homeowner OR
 * the claimed contractor. Mirrors the SELECT policies on cv_labels
 * (with homeowner rows already filtered to confirmed_label IS NOT
 * NULL by the 20260705 migration).
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function authorize(args: {
  appointment_id: string;
  user_id: string;
}): Promise<{ ok: true; is_contractor: boolean } | { ok: false }> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
  const apptRes = await fetch(
    `${url}/rest/v1/appointments?id=eq.${encodeURIComponent(
      args.appointment_id,
    )}&select=id,user_id,contractor_id&limit=1`,
    { headers, cache: "no-store" },
  );
  if (!apptRes.ok) return { ok: false };
  const rows = (await apptRes.json()) as Array<{
    id: string;
    user_id: string;
    contractor_id: string | null;
  }>;
  const appt = rows[0];
  if (!appt || !appt.contractor_id) return { ok: false };

  if (appt.user_id === args.user_id) {
    return { ok: true, is_contractor: false };
  }
  const userRes = await fetch(
    `${url}/rest/v1/users?id=eq.${encodeURIComponent(
      args.user_id,
    )}&select=contractor_id&limit=1`,
    { headers, cache: "no-store" },
  );
  if (!userRes.ok) return { ok: false };
  const userRows = (await userRes.json()) as Array<{
    contractor_id: string | null;
  }>;
  if (userRows[0]?.contractor_id === appt.contractor_id) {
    return { ok: true, is_contractor: true };
  }
  return { ok: false };
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
  if (!UUID_RE.test(id)) return bad("invalid appointment id");

  const authz = await authorize({ appointment_id: id, user_id: userId });
  if (!authz.ok) return bad("not your appointment", 403);

  const rows = await listLatestCvLabelsForAppointment(id);
  // Homeowner sees only confirmed rows (matches the RLS shape after
  // migration 20260705). Contractor sees pending too.
  const filtered = authz.is_contractor
    ? rows
    : rows.filter((r) => r.confirmed_label !== null);
  return NextResponse.json({ rows: filtered });
}
