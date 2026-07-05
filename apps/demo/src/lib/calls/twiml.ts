import { APP_PUBLIC_BASE_URL } from "../../../app/api/secrets";

/**
 * Shared TwiML builders for the DORMANT 3-way call feature
 * (FEATURE_AI_CONFERENCE_CALLS — stays OFF until consent/legal/G approval).
 *
 * CONSENT LAW (MD §10-402, all-party, criminal): transcription + recording
 * TwiML is emitted ONLY by buildConferenceTwiml({ attachMonitoring: true }),
 * and the ONLY caller allowed to pass true is the contractor-consent action
 * route AFTER the ledger shows BOTH parties consented. The homeowner leg
 * always joins plain — nothing records before the contractor's yes.
 */

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === "<"
      ? "&lt;"
      : c === ">"
        ? "&gt;"
        : c === "&"
          ? "&amp;"
          : c === '"'
            ? "&quot;"
            : "&apos;",
  );
}

export function callbackUrl(path: string): string {
  return `${APP_PUBLIC_BASE_URL.replace(/\/$/, "")}${path}`;
}

const SAY_VOICE = `voice="Polly.Joanna-Neural"`;

/**
 * Conference join TwiML. attachMonitoring=true additionally starts
 * transcription + recording — consent-gated at the call site.
 */
export function buildConferenceTwiml(args: {
  callId: string;
  attachMonitoring: boolean;
  /** Spoken before joining (e.g. consent thank-you / no-recording notice). */
  sayFirst?: string;
  /** Twilio track labels for the transcription webhook speaker mapping. */
  inboundTrackLabel?: string;
}): string {
  const conferenceName = args.callId;
  const transcriptionUrl = callbackUrl(
    `/api/webhooks/twilio/transcription?call_id=${args.callId}`,
  );
  const recordingCallback = callbackUrl(
    `/api/webhooks/twilio/recording?call_id=${args.callId}`,
  );
  const statusCallback = callbackUrl(
    `/api/webhooks/twilio/status?call_id=${args.callId}`,
  );

  const conferenceAttrs = [
    `startConferenceOnEnter="true"`,
    `endConferenceOnExit="true"`,
    args.attachMonitoring ? `record="record-from-start"` : "",
    args.attachMonitoring
      ? `recordingStatusCallback="${escapeXml(recordingCallback)}"`
      : "",
    args.attachMonitoring ? `recordingStatusCallbackEvent="completed"` : "",
    `statusCallback="${escapeXml(statusCallback)}"`,
    `statusCallbackEvent="start end join leave"`,
    `waitUrl=""`,
  ]
    .filter((s) => s.length > 0)
    .join(" ");

  const transcriptionVerb = args.attachMonitoring
    ? `<Start><Transcription statusCallbackUrl="${escapeXml(
        transcriptionUrl,
      )}" inboundTrackLabel="${escapeXml(
        args.inboundTrackLabel ?? "contractor",
      )}" outboundTrackLabel="conference" /></Start>`
    : "";

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Response>`,
    args.sayFirst
      ? `<Say ${SAY_VOICE}>${escapeXml(args.sayFirst)}</Say>`
      : "",
    transcriptionVerb,
    `<Dial>`,
    `<Conference ${conferenceAttrs}>${escapeXml(conferenceName)}</Conference>`,
    `</Dial>`,
    `</Response>`,
  ]
    .filter((s) => s.length > 0)
    .join("");
}

/**
 * Contractor pickup disclosure + consent capture (Herm TASK_088 layer-4
 * doctrine; G's order: "we've got to notify the plumber... that it's being
 * monitored or transcribed"). Gather posts to the consent action route; a
 * silent pickup falls through to the timeout redirect = NO consent.
 */
export function buildContractorConsentTwiml(args: { callId: string }): string {
  const consentUrl = callbackUrl(
    `/api/webhooks/twilio/voice/consent?call_id=${args.callId}`,
  );
  const disclosure =
    "Hello! This call is set up by i Solve Ur Problems for a homeowner who wants to talk with you about a job. Heads up: 6, an Ai assistant, is on the line to take notes. This call may be recorded and transcribed only if you agree. Press 1 or say yes to allow recording. If you do not agree, you can still talk to the homeowner, but 6 will not listen, record, transcribe, or assist on the call — press 2 or just stay on the line.";

  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Response>`,
    `<Gather input="dtmf speech" numDigits="1" timeout="6" speechTimeout="auto" action="${escapeXml(
      consentUrl,
    )}" method="POST">`,
    `<Say ${SAY_VOICE}>${escapeXml(disclosure)}</Say>`,
    `</Gather>`,
    // No input at all → NO consent (fail-closed); the action route records
    // the timeout and joins them without any monitoring.
    `<Redirect method="POST">${escapeXml(`${consentUrl}&timeout=1`)}</Redirect>`,
    `</Response>`,
  ].join("");
}

export function buildErrorTwiml(error: string): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<Response>`,
    `<Say ${SAY_VOICE}>Sorry, this call could not be connected. ${escapeXml(error)}</Say>`,
    `<Hangup />`,
    `</Response>`,
  ].join("");
}
