import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../../src/lib/rateLimit";
import { getUserId } from "../../../../../src/lib/auth/getUser";
import { TWILIO_VOICE_FROM_NUMBER } from "../../../../api/secrets";
import {
  createCall,
  createCallLeg,
  isTwilioVoiceConfigured,
  patchCall,
  setCallStatus,
} from "../../../../../src/lib/calls";
import { getSupabaseAdminConfig } from "../../../../../src/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/calls/go-between/start (M4.9)
 *
 * Vision ¶15: "6 will also manage the in-person meetings as the
 * go-between, live on one or both phones."
 *
 * Initiator flow (homeowner or contractor is holding their phone; the
 * OTHER party is physically standing next to them). 6 dials both
 * phones into the same Twilio conference; homeowner puts their phone
 * on speaker so the contractor can hear 6 mediate.
 *
 * Distinct from POST /api/calls/start (M3.1) by context.mode = 'go_between'.
 * The pipe underneath is identical — createCallLeg, conference, live
 * transcription, Twilio Conference Announce for 6's replies.
 *
 * Body:
 *   {
 *     contractor_id: uuid,
 *     to_user_phone: string,       // E.164 — the homeowner's phone
 *     contract_id?: uuid,
 *     appointment_id?: uuid,       // pre-fill mediation context
 *   }
 *
 * Returns:
 *   { call_id: uuid, status: "dialing", mode: "go_between" }
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9]\d{6,14}$/;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function fetchContractorPhone(
  contractorId: string,
): Promise<string | null> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const res = await fetch(
      `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(
        contractorId,
      )}&select=phone&limit=1`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        cache: "no-store",
      },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ phone: string | null }>;
    return rows[0]?.phone ?? null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  if (!isTwilioVoiceConfigured()) {
    return bad(
      "Twilio Voice not configured — set TWILIO_VOICE_FROM_NUMBER + APP_PUBLIC_BASE_URL",
      503,
    );
  }

  const userId = await getUserId();
  if (!userId) return bad("sign-in required", 401);

  let body: {
    contractor_id?: unknown;
    to_user_phone?: unknown;
    contract_id?: unknown;
    appointment_id?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return bad("invalid JSON");
  }

  if (
    typeof body.contractor_id !== "string" ||
    !UUID_RE.test(body.contractor_id)
  ) {
    return bad("contractor_id is required (uuid)");
  }
  if (
    typeof body.to_user_phone !== "string" ||
    !E164_RE.test(body.to_user_phone)
  ) {
    return bad("to_user_phone is required (E.164 format)");
  }
  if (
    body.contract_id != null &&
    (typeof body.contract_id !== "string" || !UUID_RE.test(body.contract_id))
  ) {
    return bad("contract_id must be a uuid");
  }
  if (
    body.appointment_id != null &&
    (typeof body.appointment_id !== "string" ||
      !UUID_RE.test(body.appointment_id))
  ) {
    return bad("appointment_id must be a uuid");
  }

  const contractorPhone = await fetchContractorPhone(body.contractor_id);
  if (!contractorPhone || !E164_RE.test(contractorPhone)) {
    return bad("contractor has no usable phone on file", 422);
  }

  const call = await createCall({
    user_id: userId,
    contractor_id: body.contractor_id,
    contract_id: typeof body.contract_id === "string" ? body.contract_id : null,
    to_user_phone: body.to_user_phone,
    to_contractor_phone: contractorPhone,
    from_phone: TWILIO_VOICE_FROM_NUMBER,
    context: {
      source: "api_post",
      mode: "go_between",
      appointment_id:
        typeof body.appointment_id === "string" ? body.appointment_id : null,
    },
  });
  if (!call) return bad("failed to create call row", 500);

  const [userLeg, contractorLeg] = await Promise.all([
    createCallLeg({
      to: body.to_user_phone,
      callId: call.id,
      participant: "user",
    }),
    createCallLeg({
      to: contractorPhone,
      callId: call.id,
      participant: "contractor",
    }),
  ]);

  if (!userLeg.ok || !contractorLeg.ok) {
    const errMsg = [
      !userLeg.ok ? `user: ${userLeg.error}` : "",
      !contractorLeg.ok ? `contractor: ${contractorLeg.error}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    await setCallStatus(call.id, "failed");
    return bad(`Twilio dial failed: ${errMsg}`, 502);
  }

  await patchCall(call.id, {
    status: "dialing",
    twilio_call_sid_user: userLeg.sid,
    twilio_call_sid_contractor: contractorLeg.sid,
  });

  return NextResponse.json({
    call_id: call.id,
    status: "dialing",
    mode: "go_between",
    sids: {
      user: userLeg.sid,
      contractor: contractorLeg.sid,
    },
  });
}
