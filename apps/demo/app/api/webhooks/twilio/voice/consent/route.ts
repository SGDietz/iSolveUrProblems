import { NextResponse, type NextRequest } from "next/server";
import { verifyTwilioRequest } from "../../../../../../src/lib/twilioSig";
import {
  getCallConsents,
  recordCallConsent,
} from "../../../../../../src/lib/calls";
import { buildConferenceTwiml, buildErrorTwiml } from "../../../../../../src/lib/calls/twiml";

export const dynamic = "force-dynamic";

/**
 * POST /api/webhooks/twilio/voice/consent (2026-07-03 — G's 3-way
 * permissions order; Herm TASK_088 layer-4 legal gates).
 *
 * The contractor just heard the disclosure <Gather>. This route:
 *   1. reads their answer (keypress 1 / spoken yes = consent; 2 / other /
 *      Gather timeout = NO consent — fail-closed),
 *   2. writes the contractor row into the call_consents audit ledger,
 *   3. joins them to the conference:
 *        - BOTH parties consented → monitored join (<Start><Transcription>
 *          + record="record-from-start") — the ONLY code path in the app
 *          that emits monitoring TwiML,
 *        - anything else → plain join, zero recording/transcription, and 6
 *          stays out (no transcript pipe = no ears = no speaking).
 *
 * MD §10-402 is an all-party-consent CRIMINAL statute: when in doubt, the
 * answer is always the plain join.
 */

// Herm TASK_096 pre-enable fix: negatives FIRST, then strict whole-utterance
// affirmatives only. "not okay", "I don't agree", "yeah no", voicemail
// greetings, and any rambling sentence containing a yes-ish token all read
// as NO consent (fail-closed — MD §10-402 is criminal law).
const NO_SPEECH_RE =
  /\b(?:no|nope|decline|declined|do\s+not|don'?t|not\s+ok(?:ay)?|not\s+agree|disagree|refuse)\b/i;
const YES_ONLY_RE =
  /^\s*(?:yes|yeah|yep|sure|i\s+agree|agree|agreed|ok|okay)\s*[.!]?\s*$/i;

export async function POST(request: NextRequest) {
  let formParams = new URLSearchParams();
  try {
    const text = await request.clone().text();
    formParams = new URLSearchParams(text);
  } catch {
    /* empty body is fine (GET redirects) */
  }
  const verified = await verifyTwilioRequest({ request, formParams });
  if (!verified.ok) {
    return new NextResponse("", { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const callId = searchParams.get("call_id") ?? "";
  const timedOut = searchParams.get("timeout") === "1";

  const xml = (twiml: string) =>
    new NextResponse(twiml, {
      status: 200,
      headers: { "Content-Type": "text/xml; charset=utf-8" },
    });

  if (!callId) {
    return xml(buildErrorTwiml("missing call id"));
  }

  const digits = (formParams.get("Digits") ?? "").trim();
  const speech = (formParams.get("SpeechResult") ?? "").trim();

  let consented = false;
  let method: "dtmf" | "speech" | "timeout" = "timeout";
  if (timedOut) {
    consented = false;
    method = "timeout";
  } else if (digits) {
    consented = digits === "1";
    method = "dtmf";
  } else if (speech) {
    consented = !NO_SPEECH_RE.test(speech) && YES_ONLY_RE.test(speech);
    method = "speech";
  }

  // Ledger first. If the write fails we CANNOT prove consent — treat as no.
  const row = await recordCallConsent({
    call_id: callId,
    party: "contractor",
    consented,
    method,
  });
  const provableConsent = consented && row !== null;

  // Monitoring requires EVERY party's latest ledger row to say yes.
  const consents = provableConsent
    ? await getCallConsents(callId)
    : { user: false, contractor: false };
  const bothConsented = consents.user && consents.contractor;

  if (bothConsented) {
    return xml(
      buildConferenceTwiml({
        callId,
        attachMonitoring: true,
        inboundTrackLabel: "contractor",
        sayFirst: "Thank you. Connecting you now.",
      }),
    );
  }

  // No consent (or unprovable): honest notice, plain join, nothing records,
  // 6 stays silent for the whole call.
  return xml(
    buildConferenceTwiml({
      callId,
      attachMonitoring: false,
      sayFirst:
        "No problem. This call will not be recorded. Connecting you now.",
    }),
  );
}

// Twilio may retry/redirect via GET.
export const GET = POST;
