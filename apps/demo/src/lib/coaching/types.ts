/**
 * M4.8 — Positive-coaching nudges types.
 */

export type CoachingEventKey =
  | "first_five_star_review"
  | "third_repeat_customer";

export type CoachingEvaluation = {
  /** Stable natural-key fingerprint of the firing instance. */
  signature: string;
  /** Free-form context passed to the LLM composer. */
  facts: Record<string, unknown>;
  /** Optional one-line topic the composer can lean on. */
  topic: string;
};

export type CoachingNudgeRow = {
  id: string;
  contractor_id: string;
  event_key: CoachingEventKey;
  payload_signature: string;
  subject: string;
  body_text: string;
  body_html: string | null;
  channel: "email" | "sms" | "whatsapp";
  notification_row_id: string | null;
  context: Record<string, unknown>;
  sent_at: string;
};
