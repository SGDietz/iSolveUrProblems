-- M3.4 + M3.5 — Appointment & reminder agent + auto-reschedule.
--
-- Vision ¶14: "before meetings or when work is to occur, 6 will message
-- both parties to make sure they'll be on time and ready... If not,
-- he'll coordinate rescheduling."
--
-- v1 stores appointments in our own table (no Google Calendar OAuth
-- required). Reminders fire through the M1.7 notifications fabric on
-- a 15-minute cron cadence — checks for any appointment whose 24h or
-- 2h reminder window is open and not yet sent.
--
-- When SG Dietz unblocks Google Calendar OAuth verification, we'll add
-- a follow-up migration with `google_event_id` + sync logic. Until then,
-- 6 owns the source of truth.
--
-- RLS: owner reads + writes their own; service role bypasses for cron.

CREATE TABLE IF NOT EXISTS appointments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contractor_id            uuid REFERENCES contractors(id) ON DELETE SET NULL,
  contract_id              uuid REFERENCES contracts(id) ON DELETE SET NULL,
  -- When the appointment happens. UTC.
  scheduled_at             timestamptz NOT NULL,
  duration_minutes         int NOT NULL DEFAULT 60 CHECK (duration_minutes > 0),
  -- Free-form description: "look at the broken faucet", "install the new
  -- water heater", etc. Captured from the user's voice intake.
  agenda                   text NOT NULL DEFAULT '',
  -- Lifecycle.
  status                   text NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'rescheduled', 'cancelled', 'completed', 'no_show')),
  -- Reminder tracking — set when the corresponding reminder dispatches.
  -- The cron uses these as a write-once "already sent" guard so we don't
  -- double-send if the cron fires twice in the window.
  reminder_24h_sent_at     timestamptz,
  reminder_2h_sent_at      timestamptz,
  -- Audit context (intake source, transcript ids, etc.)
  context                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Fast cron lookup: "any scheduled appointments whose reminder windows
-- are open?". Filtering on status + scheduled_at uses this index.
CREATE INDEX IF NOT EXISTS idx_appointments_status_scheduled_at
  ON appointments (status, scheduled_at)
  WHERE status = 'scheduled';

-- User-scoped recent lookup ("what's on my calendar this week").
CREATE INDEX IF NOT EXISTS idx_appointments_user_scheduled_at
  ON appointments (user_id, scheduled_at);

DROP TRIGGER IF EXISTS appointments_touch_updated_at ON appointments;
CREATE TRIGGER appointments_touch_updated_at
  BEFORE UPDATE ON appointments
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "appointments: owner read" ON appointments;
CREATE POLICY "appointments: owner read"
  ON appointments
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "appointments: owner write" ON appointments;
CREATE POLICY "appointments: owner write"
  ON appointments
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "appointments: owner update" ON appointments;
CREATE POLICY "appointments: owner update"
  ON appointments
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- DELETE is intentionally not policy'd — cancellations go through UPDATE
-- (status -> 'cancelled') so audit history is preserved.
