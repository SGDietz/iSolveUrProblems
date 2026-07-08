-- M4.4 — Backup / replacement dispatcher.
--
-- Vision ¶33: "If contractors don't show, 6 will get contractors that do."
--
-- Detection has two triggers:
--   (a) Passive: appointment time + configured slack window with the
--       contractor never having confirmed on-site.
--   (b) Active: homeowner says "they didn't show" (report_no_show intent).
--
-- Either trigger flips the appointment to status='no_show' and hands the
-- baton to the dispatcher, which re-runs same-day search over M2.1 and
-- fans out an urgent invitation to same-day-capable contractors. The
-- audit row lives in appointment_replacements so we can trace what got
-- swapped for what — useful when the homeowner asks "who showed up
-- yesterday" and 6 needs to answer with the substitute's name.
--
-- Columns added to appointments:
--   - contractor_confirmed_at: on-site / arrival confirmation. Also
--     written by M4.5 photo-log uploads (first photo on the appointment
--     counts as confirmation). Absence → no_show risk.
--   - no_show_detected_at: idempotency gate for the cron so we don't
--     re-dispatch on every 5-minute pass once no-show has been declared.
--   - replaced_by_appointment_id: back-pointer to the substitute if the
--     dispatcher successfully filled the slot.
--
-- Backwards compatible: all new columns are nullable.

-- ─── 1. appointments — confirmation + no-show tracking ─────────────

ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS contractor_confirmed_at    timestamptz,
  ADD COLUMN IF NOT EXISTS no_show_detected_at        timestamptz,
  ADD COLUMN IF NOT EXISTS replaced_by_appointment_id uuid
    REFERENCES public.appointments(id) ON DELETE SET NULL;

-- The no-show detector's primary lookup: "any appointment past its
-- scheduled_at, still 'scheduled/rescheduled', without a confirmation,
-- and not already flagged". Partial index keeps it small.
CREATE INDEX IF NOT EXISTS idx_appointments_no_show_scan
  ON public.appointments (scheduled_at)
  WHERE status IN ('scheduled', 'rescheduled')
    AND contractor_confirmed_at IS NULL
    AND no_show_detected_at IS NULL;

-- ─── 2. appointment_replacements — dispatcher audit trail ──────────

CREATE TABLE IF NOT EXISTS public.appointment_replacements (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- The original appointment whose contractor no-showed.
  original_appointment_id     uuid NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  -- The substitute appointment 6 dispatched. NULL until at least one
  -- helper accepts; the dispatcher inserts the row eagerly so we have a
  -- ledger of "we tried" even when nobody bites.
  replacement_appointment_id  uuid REFERENCES public.appointments(id) ON DELETE SET NULL,
  -- What flipped the switch — cron detection or homeowner report.
  trigger                     text NOT NULL
    CHECK (trigger IN ('cron_grace_expired', 'homeowner_report', 'admin_manual')),
  -- Who / what invited. Snapshot fields — the actual invited rows live
  -- in crew_request_responses if we reused that infra, or in the
  -- context payload when we didn't.
  invited_count               int  NOT NULL DEFAULT 0,
  accepted_by_contractor_id   uuid REFERENCES public.contractors(id) ON DELETE SET NULL,
  accepted_at                 timestamptz,
  -- Free-form: transcript ids, cron_run_id, homeowner text, etc.
  context                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_appt_replacements_original
  ON public.appointment_replacements (original_appointment_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_appt_replacements_replacement
  ON public.appointment_replacements (replacement_appointment_id)
  WHERE replacement_appointment_id IS NOT NULL;

DROP TRIGGER IF EXISTS appointment_replacements_touch_updated_at
  ON public.appointment_replacements;
CREATE TRIGGER appointment_replacements_touch_updated_at
  BEFORE UPDATE ON public.appointment_replacements
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.appointment_replacements ENABLE ROW LEVEL SECURITY;

-- Homeowner reads their own dispatch history via the original appointment
-- they own. Contractors don't get RLS access — dispatch is a platform
-- operation, and the substitute contractor sees the *replacement*
-- appointment through the normal contractor RLS on appointments.
DROP POLICY IF EXISTS "appt_replacements: homeowner-read"
  ON public.appointment_replacements;
CREATE POLICY "appt_replacements: homeowner-read"
  ON public.appointment_replacements
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.appointments a
      WHERE a.id = appointment_replacements.original_appointment_id
        AND a.user_id = auth.uid()
    )
  );
