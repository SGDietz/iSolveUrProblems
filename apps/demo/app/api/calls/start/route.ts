import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../src/lib/rateLimit";
import { getUserId } from "../../../../src/lib/auth/getUser";
import { TWILIO_VOICE_FROM_NUMBER } from "../../../api/secrets";
import {
  createCall,
  createCallLeg,
  isTwilioVoiceConfigured,
  patchCall,
  recordCallConsent,
  setCallStatus,
  userKnowsContractor,
} from "../../../../src/lib/calls";
import { getSupabaseAdminConfig } from "../../../../src/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/calls/start (M3.1 — DORMANT behind FEATURE_AI_CONFERENCE_CALLS)
 *
 * Starts a consented conference call: homeowner ⟷ contractor, with 6
 * speaking via Conference Announce (TWO outbound legs, no third "6" leg —
 * Herm TASK_094/095 doc fix).
 *
 * Body:
 *   {
 *     contractor_id: uuid,
 *     to_user_phone: string,       // homeowner's number (E.164)
 *     contract_id?: uuid,
 *     user_consent: true,          // REQUIRED — express in-app consent
 *     consent_version?: string,
 *   }
 *
 * Returns:
 *   { call_id: uuid, status: "dialing" }
 *
 * Each leg's callback URL points at /api/webhooks/twilio/voice; the
 * contractor leg hears the consent disclosure before joining. Twilio
 * fires status webhooks as each leg progresses.
 */

// Dormant-default hard gate (Herm TASK_093): without this, a signed-in
// same-origin caller could start a REAL Twilio 3-way call even though the
// orchestrator/UI keep the feature off. The flag alone is NOT the launch
// gate — all-party consent/legal/disclosure must exist before any public
// enable (MD §10-402 all-party consent).
const AI_CONFERENCE_CALLS_ENABLED =
  process.env.FEATURE_AI_CONFERENCE_CALLS === "1";

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

  // 404 (not 403/503) while dormant: less discoverable until G enables.
  if (!AI_CONFERENCE_CALLS_ENABLED) {
    return bad("Ai conference calls are disabled", 404);
  }

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
    user_consent?: unknown;
    consent_version?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return bad("invalid JSON");
  }

  // HOMEOWNER CONSENT IS A HARD PRECONDITION (MD §10-402 all-party consent
  // — criminal statute). The in-app consent sheet v2 must have shown the
  // Ai-on-the-line + recording/transcription disclosure and captured an
  // express YES before this route may dial anyone. No consent, no call.
  if (body.user_consent !== true) {
    return bad(
      "user_consent:true is required — the caller must expressly consent to 6 on the line and to recording/transcription before any dial",
      403,
    );
  }
  const consentVersion =
    typeof body.consent_version === "string" &&
    body.consent_version.trim() !== ""
      ? body.consent_version.trim().slice(0, 20)
      : "v1";

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

  // Nuisance-call defense (M4 authz, backported per plan v2 3b): the caller
  // must have a REAL relationship with this contractor (contract, appointment
  // or prior call row). Without it any signed-in user could make Twilio dial
  // any contractor in the directory.
  const knows = await userKnowsContractor({
    user_id: userId,
    contractor_id: body.contractor_id,
  });
  if (!knows) {
    return bad(
      "no existing relationship with this contractor — calls can only be placed to pros you have a contract, appointment, or prior call with",
      403,
    );
  }

  const contractorPhone = await fetchContractorPhone(body.contractor_id);
  if (!contractorPhone || !E164_RE.test(contractorPhone)) {
    return bad("contractor has no usable phone on file", 422);
  }

  // 1. Create the DB row first so we have a stable ID to pass through
  //    the TwiML callbacks.
  const call = await createCall({
    user_id: userId,
    contractor_id: body.contractor_id,
    contract_id: typeof body.contract_id === "string" ? body.contract_id : null,
    to_user_phone: body.to_user_phone,
    to_contractor_phone: contractorPhone,
    from_phone: TWILIO_VOICE_FROM_NUMBER,
    context: { source: "api_post" },
  });
  if (!call) return bad("failed to create call row", 500);

  // 1b. Write the homeowner's consent to the audit ledger BEFORE any dial.
  //     If the ledger write fails, the call must not proceed — consent
  //     without a record is not consent we can prove (fail-closed).
  const consentRow = await recordCallConsent({
    call_id: call.id,
    party: "user",
    consented: true,
    method: "app_sheet",
    consent_version: consentVersion,
  });
  if (!consentRow) {
    await setCallStatus(call.id, "failed");
    return bad("consent ledger write failed — call not started", 500);
  }

  // 2. Dial homeowner + contractor in parallel. The "6 leg" is NOT
  //    needed — 6 speaks into the conference via Twilio's Conference
  //    Announce API (see twilio.ts → announceToConference), not as a
  //    separate dialed leg. Saves a Twilio outbound minute per call
  //    and simplifies state.
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
    sids: {
      user: userLeg.sid,
      contractor: contractorLeg.sid,
    },
  });
}
