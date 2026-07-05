import {
  APP_PUBLIC_BASE_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_VOICE_FROM_NUMBER,
} from "../../../app/api/secrets";

/**
 * M3.1 — Twilio Voice REST wrapper. DORMANT behind FEATURE_AI_CONFERENCE_CALLS.
 *
 * Vercel-compatible audio pipeline (as actually built — Herm TASK_094 fixed
 * this doc: there is NO third "6" call leg):
 *   - Twilio dials TWO human legs (homeowner + contractor) into a Conference.
 *   - 6 "speaks" via the Conference Announce helper below: Twilio
 *     plays TTS INSIDE the room to all participants — no third leg, no
 *     WebSocket needed.
 *   - `<Start><Transcription>` on the conference posts every transcript
 *     chunk to our /api/webhooks/twilio/transcription HTTP endpoint.
 *     MUST become consent-gated before the feature ever enables (MD
 *     all-party consent — see the calls/start route gate).
 *
 * All Twilio responses come back as JSON when we hit `.json` endpoints.
 */

export function isTwilioVoiceConfigured(): boolean {
  return (
    TWILIO_ACCOUNT_SID.length > 0 &&
    TWILIO_AUTH_TOKEN.length > 0 &&
    TWILIO_VOICE_FROM_NUMBER.length > 0 &&
    APP_PUBLIC_BASE_URL.length > 0
  );
}

function basicAuthHeader(): string {
  // Auth token may be stored as "<sid>:<token>" or just "<token>" — strip
  // the leading SID prefix if present so HTTP basic auth still works.
  const token = TWILIO_AUTH_TOKEN.includes(":")
    ? TWILIO_AUTH_TOKEN.split(":").slice(1).join(":")
    : TWILIO_AUTH_TOKEN;
  return (
    "Basic " +
    Buffer.from(`${TWILIO_ACCOUNT_SID}:${token}`).toString("base64")
  );
}

function baseUrl(): string {
  return `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}`;
}

async function twilioPost(
  path: string,
  body: Record<string, string | undefined>,
): Promise<
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string }
> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== "") form.append(k, v);
  }
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const msg =
      typeof data.message === "string" ? data.message : `twilio ${res.status}`;
    return { ok: false, error: msg };
  }
  return { ok: true, data };
}

/**
 * Build absolute URLs for Twilio webhooks. Twilio requires publicly
 * reachable HTTPS — APP_PUBLIC_BASE_URL must be set to the deployed
 * domain (or an ngrok tunnel in dev).
 */
function callbackUrl(path: string): string {
  return `${APP_PUBLIC_BASE_URL.replace(/\/$/, "")}${path}`;
}

export type CreateCallLegArgs = {
  to: string;            // E.164
  callId: string;        // our internal call.id (passed through as `call_id`)
  participant: "user" | "contractor";
};

/**
 * Place an outbound call. The URL points at our /api/webhooks/twilio/voice
 * endpoint which returns TwiML telling Twilio to join the right Conference.
 *
 * NOTE: status_callback is set to /api/webhooks/twilio/status so we track
 * the call's lifecycle.
 */
export async function createCallLeg(
  args: CreateCallLegArgs,
): Promise<{ ok: true; sid: string } | { ok: false; error: string }> {
  const qs = new URLSearchParams({
    call_id: args.callId,
    participant: args.participant,
  });
  const voiceUrl = `${callbackUrl("/api/webhooks/twilio/voice")}?${qs.toString()}`;
  const statusUrl = callbackUrl("/api/webhooks/twilio/status");

  const result = await twilioPost("/Calls.json", {
    To: args.to,
    From: TWILIO_VOICE_FROM_NUMBER,
    Url: voiceUrl,
    StatusCallback: statusUrl,
    StatusCallbackEvent: "initiated ringing answered completed",
    StatusCallbackMethod: "POST",
    // Hard cap each leg to 60 minutes — protects budget if a call hangs.
    TimeLimit: "3600",
  });
  if (!result.ok) return result;
  return { ok: true, sid: String(result.data.sid ?? "") };
}

/**
 * Inject 6's voice into the conference using Twilio's Conference
 * Announce API:
 *   POST /Conferences/{ConferenceSid}/Participants/{ParticipantCallSid}
 *     with `Announce=<URL>` — Twilio fetches the URL, gets TwiML back,
 *     plays it to ALL participants in the conference, then resumes.
 *
 * The announce TwiML is served by /api/webhooks/twilio/announce, which
 * reads `text` from the query string and returns `<Say>text</Say>`.
 *
 * Why this beats updating a "6 leg"'s TwiML: updating a leg's TwiML
 * disconnects that leg from the conference and plays audio only to
 * that leg's remote party — useless when the 6 leg is a self-call.
 * Announce plays audio INSIDE the conference room, audible to both
 * the homeowner and the contractor.
 */
export async function announceToConference(args: {
  conferenceSid: string;
  /** Any participant's call SID — the API uses it as a routing handle;
   *  the announcement is still conference-wide. */
  participantCallSid: string;
  text: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = args.text.slice(0, 1200); // Twilio caps Say at ~1500 chars
  const announceUrl =
    `${callbackUrl("/api/webhooks/twilio/announce")}?text=${encodeURIComponent(
      trimmed,
    )}`;
  const result = await twilioPost(
    `/Conferences/${args.conferenceSid}/Participants/${args.participantCallSid}.json`,
    {
      Announce: announceUrl,
      AnnounceMethod: "GET",
    },
  );
  if (!result.ok) return result;
  return { ok: true };
}

/**
 * End a Conference — completes all participants.
 */
export async function endConference(args: {
  conferenceSid: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await twilioPost(`/Conferences/${args.conferenceSid}.json`, {
    Status: "completed",
  });
  if (!result.ok) return result;
  return { ok: true };
}

/**
 * Look up a Twilio conference by friendly name (we use our call.id).
 * Used by the orchestrator to find the conference SID after both legs
 * have joined (we don't know it at /start time — Twilio creates it on
 * first <Conference> verb).
 */
export async function findConferenceByFriendlyName(args: {
  friendlyName: string;
}): Promise<{ sid: string | null }> {
  const url = `${baseUrl()}/Conferences.json?FriendlyName=${encodeURIComponent(
    args.friendlyName,
  )}&Status=in-progress`;
  const res = await fetch(url, {
    headers: { Authorization: basicAuthHeader() },
  });
  if (!res.ok) return { sid: null };
  const data = (await res.json()) as { conferences?: Array<{ sid: string }> };
  return { sid: data.conferences?.[0]?.sid ?? null };
}
