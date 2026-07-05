-- M4.5 — Daily photo/video job logging.
--
-- Vision ¶31: "every task in a job will be documented multiple times
-- per day."
--
-- One row per uploaded artifact (photo, short video, or text note).
-- Tied to an appointment so we can render a per-job timeline + email
-- a day-of-completion summary to the homeowner (follow-up).
--
-- Storage layout (private bucket `job-logs`):
--   <appointment_id>/<yyyy-mm>/<kind>-<isoTimestamp>-<rand>.<ext>
--
-- RLS: the claimed contractor for the appointment can read its own
-- rows; homeowners read rows for their own appointments. Mutations
-- go through service-role API routes that verify ownership.
--
-- Tier gate: bronze+ for capture (see tiers.ts `photo_log`). v1
-- requires arrival + completion photos per Q4.5a; per-checklist-item
-- photos are a follow-up tied to M4.3.

CREATE TABLE IF NOT EXISTS public.job_log_entries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id  uuid NOT NULL REFERENCES public.appointments(id) ON DELETE CASCADE,
  contractor_id   uuid NOT NULL REFERENCES public.contractors(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    -- The auth.user who uploaded (i.e. the claimed contractor user, or
    -- a future crew member working under the contractor).
  kind            text NOT NULL CHECK (kind IN ('photo', 'video', 'note')),
  -- Q4.5a v1 — arrival + completion are special-case captures. NULL
  -- means a free-form mid-job log entry.
  phase           text CHECK (phase IS NULL OR phase IN ('arrival', 'in_progress', 'completion')),
  -- Storage path inside the `job-logs` bucket. NULL only for kind='note'.
  storage_path    text,
  mime_type       text,
  size_bytes      integer,
  -- Best-effort geolocation from the browser at capture time. The
  -- contractor can opt out — null means "wasn't shared".
  gps_lat         double precision,
  gps_lng         double precision,
  gps_accuracy_m  double precision,
  -- Free-form text. For 'note' rows this is the body; for media rows
  -- this is the contractor-typed caption (optional).
  caption         text,
  -- Reserved for M4.6 CV — populated by the vision pipeline. Not used
  -- in M4.5 v1.
  ai_caption      text,
  context         jsonb NOT NULL DEFAULT '{}'::jsonb,
  taken_at        timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_log_appointment
  ON public.job_log_entries (appointment_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_log_contractor_taken
  ON public.job_log_entries (contractor_id, taken_at DESC);

ALTER TABLE public.job_log_entries ENABLE ROW LEVEL SECURITY;

-- Claimed contractor reads their own rows.
DROP POLICY IF EXISTS "job_log: contractor-read" ON public.job_log_entries;
CREATE POLICY "job_log: contractor-read"
  ON public.job_log_entries
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.contractors c
      WHERE c.id = job_log_entries.contractor_id
        AND c.claimed_by_user_id = auth.uid()
    )
  );

-- Homeowner reads logs for their own appointments.
DROP POLICY IF EXISTS "job_log: homeowner-read" ON public.job_log_entries;
CREATE POLICY "job_log: homeowner-read"
  ON public.job_log_entries
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.appointments a
      WHERE a.id = job_log_entries.appointment_id
        AND a.user_id = auth.uid()
    )
  );

-- ─── Storage bucket ───────────────────────────────────────────────
-- Private — never publicly listable. Service-role-only access for
-- uploads; signed URLs for display.
INSERT INTO storage.buckets (id, name, public)
  VALUES ('job-logs', 'job-logs', false)
  ON CONFLICT (id) DO NOTHING;
