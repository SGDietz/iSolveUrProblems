/**
 * E.164 phone-number regex.
 *
 * Matches a leading `+`, a first digit 1–9 (no leading zero), then
 * 6–14 more digits. Total 7–15 digits after the plus, per the ITU
 * E.164 spec. Used server-side to validate homeowner/contractor
 * phones before dialing Twilio, and client-side to gate submit
 * buttons.
 *
 * Historically duplicated inline across api/calls/start,
 * api/calls/go-between/start, intent/orchestrator (place_call +
 * go_between_mode), and GoBetweenMode/StartButton. This shared
 * export is the single source of truth so a change (e.g. relaxing
 * for extension digits) lands in one place.
 */
export const E164_RE = /^\+[1-9]\d{6,14}$/;

export function isE164(v: unknown): v is string {
  return typeof v === "string" && E164_RE.test(v);
}
