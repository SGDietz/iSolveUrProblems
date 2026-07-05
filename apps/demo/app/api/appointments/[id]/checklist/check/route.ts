import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../../../src/lib/apiRouteSecurity";
import { getUserId } from "../../../../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../../../../src/lib/supabaseAdmin";
import { setChecklistItemChecked } from "../../../../../../src/lib/appointments";

export const dynamic = "force-dynamic";

/**
 * POST /api/appointments/[id]/checklist/check (M4.3)
 *
 * Body: { item_id: string, checked: boolean }
 *
 * Toggles a single checklist item's checked state. Only the claimed
 * contractor for the appointment can mutate — homeowners get 403.
 *
 * Returns the updated checklist row.
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

async function appointmentBelongsToContractor(args: {
  appointment_id: string;
  contractor_id: string;
}): Promise<boolean> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/appointments?id=eq.${encodeURIComponent(
      args.appointment_id,
    )}&contractor_id=eq.${encodeURIComponent(
      args.contractor_id,
    )}&select=id&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    },
  );
  if (!res.ok) return false;
  const rows = (await res.json()) as Array<{ id: string }>;
  return rows.length === 1;
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const userId = await getUserId();
  if (!userId) return bad("sign-in required", 401);
  const { id } = await ctx.params;

  const contractorId = await fetchClaimedContractorId(userId);
  if (!contractorId) return bad("forbidden — no claimed contractor", 403);
  const owns = await appointmentBelongsToContractor({
    appointment_id: id,
    contractor_id: contractorId,
  });
  if (!owns) return bad("forbidden — appointment not yours", 403);

  let body: { item_id?: unknown; checked?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad("invalid JSON");
  }
  if (typeof body.item_id !== "string" || body.item_id.length === 0) {
    return bad("item_id is required");
  }
  if (typeof body.checked !== "boolean") {
    return bad("checked must be boolean");
  }

  const row = await setChecklistItemChecked({
    appointment_id: id,
    item_id: body.item_id,
    checked: body.checked,
    user_id: userId,
  });
  if (!row) return bad("checklist not found", 404);
  return NextResponse.json({ row });
}
