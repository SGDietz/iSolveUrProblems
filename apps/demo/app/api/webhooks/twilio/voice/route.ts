import { NextResponse, type NextRequest } from "next/server";
import { verifyTwilioRequest } from "../../../../../src/lib/twilioSig";
import {
  buildConferenceTwiml,
  buildContractorConsentTwiml,
  buildErrorTwiml,
} from "../../../../../src/lib/calls/twiml";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/twilio/voice (M3.1 — DORMANT behind
 * FEATURE_AI_CONFERENCE_CALLS; consent rework 2026-07-03, G's order +
 * Herm TASK_088/092 legal gates).
 *
 * ?call_id=<uuid>&participant=user|contractor
 *
 * CONSENT-FIRST BEHAVIOR (MD §10-402 all-party consent — criminal statute,
 * fail-closed):
 *   - user leg: joins the Conference PLAIN. No transcription, no recording
 *     — the homeowner consented in-app, but NOTHING may record until the
 *     contractor also says yes.
 *   - contractor leg: hears the disclosure FIRST ("6, an Ai assistant, is
 *     on the line... recorded and transcribed only if you agree") via
 *     <Gather>. Their keypress/speech posts to
 *     /api/webhooks/twilio/voice/consent, which writes the consent ledger
 *     and returns the join TwiML — WITH monitoring only when BOTH ledger
 *     rows say yes, plain otherwise. Silence = timeout = NO consent.
 *
 * 6 speaks via Conference Announce (no third leg) and only ever when the
 * transcription pipe exists — i.e. only on fully-consented calls.
 */

export async function POST(request: NextRequest) {
  let formParams = new URLSearchParams();
  try {
    const text = await request.clone().text();
    formParams = new URLSearchParams(text);
  } catch {
    /* no body — that's fine, params stays empty */
  }
  const verified = await verifyTwilioRequest({ request, formParams });
  if (!verified.ok) {
    return new NextResponse("", { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const callId = searchParams.get("call_id") ?? "";
  const participantRaw = searchParams.get("participant") ?? "";

  const xml = (twiml: string) =>
    new NextResponse(twiml, {
      status: 200, // Twilio always wants 200 + TwiML
      headers: { "Content-Type": "text/xml; charset=utf-8" },
    });

  if (!callId) {
    return xml(buildErrorTwiml("missing call id"));
  }
  if (participantRaw !== "user" && participantRaw !== "contractor") {
    return xml(buildErrorTwiml("unknown participant"));
  }

  if (participantRaw === "contractor") {
    // Disclosure + consent capture BEFORE the contractor ever joins.
    return xml(buildContractorConsentTwiml({ callId }));
  }

  // Homeowner leg: plain join, never carries monitoring (see header).
  return xml(
    buildConferenceTwiml({
      callId,
      attachMonitoring: false,
    }),
  );
}

// Twilio sometimes uses GET (notably during <Redirect>). Mirror the POST.
export const GET = POST;
