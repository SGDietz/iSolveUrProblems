-- M1.7 — Notifications fabric: delivery audit log.
--
-- One row per (channel, recipient, template) attempt. Inserted as
-- 'queued' before the provider call, then patched with provider_id +
-- 'sent' (or 'failed' + error). Provider webhooks later flip to
-- 'delivered' / 'bounced' / 'opened'.
--
-- RLS: locked to service role only. The user-facing "what messages
-- did 6 send me" view will read via service role through an admin
-- console (M2.9).
--
-- The /api/webhooks/* routes need to read this table by provider_id;
-- they use service role for that. Webhook callers don't carry our
-- auth cookies, so the route handler signature checks the provider's
-- own signature header instead.

CREATE TABLE IF NOT EXISTS notifications_sent (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  user_id         uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id      text,
  channel         text NOT NULL CHECK (channel IN ('email', 'sms', 'whatsapp')),
  recipient       text NOT NULL,
  template_id     text NOT NULL,
  locale          text,
  -- Provider's id (Resend message id, Twilio SID).
  provider_id     text,
  status          text NOT NULL DEFAULT 'queued'
                    CHECK (status IN (
                      'queued',
                      'sent',
                      'failed',
                      'delivered',
                      'bounced',
                      'opened',
                      'clicked',
                      'spam',
                      'unsubscribed'
                    )),
  error           text,
  retry_after     timestamptz,
  -- Whether this attempt was a fallback because the user's preferred
  -- channel was unavailable (per Q1.7b fail-open posture).
  is_fallback     boolean NOT NULL DEFAULT false,
  -- Arbitrary structured context (template data echo, attempt #, etc.)
  context         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_notifications_sent_user_id
  ON notifications_sent (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_sent_provider_id
  ON notifications_sent (provider_id)
  WHERE provider_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_sent_status
  ON notifications_sent (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_sent_retry
  ON notifications_sent (retry_after)
  WHERE retry_after IS NOT NULL AND status = 'failed';

-- Reuse the M1.1 touch_updated_at trigger function.
DROP TRIGGER IF EXISTS notifications_sent_touch_updated_at ON notifications_sent;
CREATE TRIGGER notifications_sent_touch_updated_at
  BEFORE UPDATE ON notifications_sent
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE notifications_sent ENABLE ROW LEVEL SECURITY;
-- No policies — service role only.
