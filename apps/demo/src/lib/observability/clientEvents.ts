/**
 * Fire-and-forget product-event pings from the browser to /api/events
 * (public.app_events). Telemetry must NEVER break or slow the UI: every
 * failure path collapses to silence. keepalive:true so events fired right
 * before a navigation (tel: dial, website open) still get delivered.
 *
 * Event names must stay in lockstep with the ALLOWED_EVENTS set in
 * app/api/events/route.ts — the server drops anything else.
 */
export type AppEventName =
  | "call_consent_open"
  | "call_consent_yes"
  | "call_consent_dismiss"
  | "contractor_website_tap"
  | "contractor_email_consent_open"
  | "contractor_email_consent_yes"
  | "contractor_email_consent_dismiss";

/**
 * The live avatar session id (same id conversation_messages rows carry), so
 * every app_event joins back to the transcript/session envelope (Herm
 * release board 2026-07-02 item 1 — app_events had session_id=null).
 * LiveAvatarSession registers it on CONNECTED and clears it on DISCONNECTED;
 * panels never need to thread it. Null = event still lands, just unjoined.
 */
let liveSessionId: string | null = null;

export function setAppEventSessionId(id: string | null): void {
  liveSessionId = id && id.trim() ? id.trim() : null;
}

/** Current live session id (or null) — shared by media saves etc. */
export function getAppEventSessionId(): string | null {
  return liveSessionId;
}

export function pingAppEvent(
  event: AppEventName,
  data?: {
    contractorId?: string | null;
    context?: Record<string, unknown>;
  },
): void {
  try {
    void fetch("/api/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        session_id: liveSessionId ?? undefined,
        contractor_id: data?.contractorId ?? undefined,
        context: data?.context,
      }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Never let telemetry surface into the calling code path.
  }
}
