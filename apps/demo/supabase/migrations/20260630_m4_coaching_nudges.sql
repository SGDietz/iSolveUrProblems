-- M4.8 — Positive-coaching nudges dedup ledger.
--
-- Vision ¶28: "6 will always be positive and encouraging, helping people
-- be better business owners and employees."
--
-- The cron evaluates contractor-side events daily and composes an LLM-
-- driven email + in-app banner. This table guards against re-sending
-- the same nudge: unique on (contractor_id, event_key, payload_signature).
--
-- event_key:        catalog ID (e.g. 'first_five_star_review')
-- payload_signature: trigger-specific natural key — e.g. the review id
--                    that crossed the threshold — so a brand new 5-star
--                    review can re-fire the same event_key only if the
--                    signature changes (it won't for "first ever").
--
-- Tier gate (gold) is enforced inside the cron, not the schema.

CREATE TABLE IF NOT EXISTS public.coaching_nudges_sent (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id       uuid NOT NULL REFERENCES public.contractors(id) ON DELETE CASCADE,
  event_key           text NOT NULL,
  payload_signature   text NOT NULL,
  -- The LLM-generated subject + body, persisted for the dashboard
  -- banner and audit. Stored at compose time so we don't need a re-
  -- generation pass for the UI.
  subject             text NOT NULL,
  body_text           text NOT NULL,
  body_html           text,
  -- Channel summary: how it went out. Mirrored from notifications_sent.
  channel             text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
  notification_row_id uuid,
  context             jsonb NOT NULL DEFAULT '{}'::jsonb,
  sent_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contractor_id, event_key, payload_signature)
);

CREATE INDEX IF NOT EXISTS idx_coaching_nudges_contractor_sent
  ON public.coaching_nudges_sent (contractor_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_coaching_nudges_event
  ON public.coaching_nudges_sent (event_key, sent_at DESC);

ALTER TABLE public.coaching_nudges_sent ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "coaching_nudges: claimer-read"
  ON public.coaching_nudges_sent;
CREATE POLICY "coaching_nudges: claimer-read"
  ON public.coaching_nudges_sent
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.contractors c
      WHERE c.id = coaching_nudges_sent.contractor_id
        AND c.claimed_by_user_id = auth.uid()
    )
  );
