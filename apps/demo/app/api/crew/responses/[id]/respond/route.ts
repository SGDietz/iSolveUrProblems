import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../../../src/lib/apiRouteSecurity";
import { getUserId } from "../../../../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../../../../src/lib/supabaseAdmin";
import {
  markRequestFilledIfOpen,
  setResponseStatus,
} from "../../../../../../src/lib/crew";
import { send } from "../../../../../../src/lib/notifications";
import { APP_PUBLIC_BASE_URL } from "../../../../secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/crew/responses/[id]/respond (M4.2)
 *
 * Body: { action: 'accept' | 'decline' }
 *
 * The invitee contractor accepts or declines a specific invitation.
 * First accept wins — a compare-and-swap on crew_requests.status flips
 * the request to 'filled'. If someone else already won, the caller is
 * told the request was filled and their row is left as 'declined'
 * (with a "beaten to it" note in context — they can still see it in
 * their inbox for audit).
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

async function fetchResponseWithRequest(response_id: string): Promise<{
  crew_request_id: string;
  invitee_contractor_id: string;
  request_status: string;
  request_category: string;
  request_needed_at: string;
  requester_user_id: string;
  requester_email: string | null;
  requester_name: string;
} | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/crew_request_responses?id=eq.${encodeURIComponent(
      response_id,
    )}&select=crew_request_id,invitee_contractor_id,request:crew_requests!crew_request_id(status,category,needed_at,requester_user_id,requester:contractors!requester_contractor_id(email,name))&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{
    crew_request_id: string;
    invitee_contractor_id: string;
    request: {
      status: string;
      category: string;
      needed_at: string;
      requester_user_id: string;
      requester: { email: string | null; name: string } | null;
    } | null;
  }>;
  const r = rows[0];
  if (!r || !r.request) return null;
  return {
    crew_request_id: r.crew_request_id,
    invitee_contractor_id: r.invitee_contractor_id,
    request_status: r.request.status,
    request_category: r.request.category,
    request_needed_at: r.request.needed_at,
    requester_user_id: r.request.requester_user_id,
    requester_email: r.request.requester?.email ?? null,
    requester_name: r.request.requester?.name ?? "the contractor",
  };
}

async function fetchHelperContact(
  contractor_id: string,
): Promise<{ name: string; phone: string | null; email: string | null }> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(
      contractor_id,
    )}&select=name,phone,email&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    },
  );
  if (!res.ok) return { name: "the helper", phone: null, email: null };
  const rows = (await res.json()) as Array<{
    name: string;
    phone: string | null;
    email: string | null;
  }>;
  const r = rows[0];
  return {
    name: r?.name ?? "the helper",
    phone: r?.phone ?? null,
    email: r?.email ?? null,
  };
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
  if (!contractorId) return bad("no claimed contractor", 403);

  let body: { action?: unknown };
  try {
    body = await request.json();
  } catch {
    return bad("invalid JSON");
  }
  const action = body.action;
  if (action !== "accept" && action !== "decline") {
    return bad("action must be 'accept' or 'decline'");
  }

  const meta = await fetchResponseWithRequest(id);
  if (!meta) return bad("invitation not found", 404);
  if (meta.invitee_contractor_id !== contractorId) {
    return bad("not your invitation", 403);
  }

  if (meta.request_status !== "open" && action === "accept") {
    // Someone else won. Mark the caller's row as declined-late so they
    // don't see the outstanding "accept" CTA forever.
    await setResponseStatus({
      response_id: id,
      invitee_contractor_id: contractorId,
      new_status: "declined",
    });
    return NextResponse.json(
      { ok: false, reason: "already_filled" },
      { status: 409 },
    );
  }

  if (action === "decline") {
    const row = await setResponseStatus({
      response_id: id,
      invitee_contractor_id: contractorId,
      new_status: "declined",
    });
    if (!row) return bad("update failed", 500);
    return NextResponse.json({ row, filled: false });
  }

  // action === "accept". Try to win the request atomically.
  const won = await markRequestFilledIfOpen({
    crew_request_id: meta.crew_request_id,
    filled_by_contractor_id: contractorId,
  });
  if (!won) {
    await setResponseStatus({
      response_id: id,
      invitee_contractor_id: contractorId,
      new_status: "declined",
    });
    return NextResponse.json(
      { ok: false, reason: "already_filled" },
      { status: 409 },
    );
  }
  const row = await setResponseStatus({
    response_id: id,
    invitee_contractor_id: contractorId,
    new_status: "accepted",
  });
  if (!row) return bad("update failed", 500);

  // Notify the requester their crew request just got filled.
  if (meta.requester_email) {
    const helper = await fetchHelperContact(contractorId);
    const dashboardUrl = APP_PUBLIC_BASE_URL
      ? `${APP_PUBLIC_BASE_URL}/en/contractor/dashboard`
      : "/en/contractor/dashboard";
    await send({
      channel: "email",
      recipient: meta.requester_email,
      templateId: "crew.filled.v1",
      data: {
        recipientName: meta.requester_name,
        helperName: helper.name,
        helperPhone: helper.phone,
        helperEmail: helper.email,
        category: meta.request_category,
        neededAtText: new Date(meta.request_needed_at).toLocaleString(),
        dashboardUrl,
      },
      context: {
        crew_request_id: meta.crew_request_id,
        accepted_by_contractor_id: contractorId,
      },
    });
  }

  return NextResponse.json({ row, filled: true });
}
