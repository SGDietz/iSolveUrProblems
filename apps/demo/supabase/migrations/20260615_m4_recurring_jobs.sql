-- M4.7 — Recurring / autopilot job scheduler.
--
-- Vision ¶33: "autopilot, such as their grass mowed, weeds pulled,
-- gutters cleaned, A.C. fixed, driveway snow plowed — anything and
-- everything"
--
-- One row per homeowner-initiated recurring job. Each row owns an
-- RRULE describing when instances should fire. A nightly cron walks
-- every active row, expands the next 7 days of the RRULE, and
-- materializes appointments (one per RRULE instance) that don't
-- already exist for this recurring_job_id + scheduled_at pair.
--
-- Each materialized appointment is a normal M3.4 row — gets reminders,
-- contractor confirmations, photo logs, dispute mediation — and is
-- linked back via appointments.recurring_job_id.
--
-- Lifecycle:
--   active       — cron materializes
--   paused       — cron skips; user can resume
--   ended        — past active_until; archived
--   cancelled    — user-cancelled; future materialization blocked
--
-- Tier gate: silver+ per Q4.1a. The orchestrator enforces this; the
-- table itself doesn't gate at the DB layer.

CREATE TABLE IF NOT EXISTS public.recurring_jobs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contractor_id        uuid REFERENCES public.contractors(id) ON DELETE SET NULL,
  contract_id          uuid REFERENCES public.contracts(id) ON DELETE SET NULL,
  -- Free-form description: "lawn mowing", "monthly gutter check"
  title                text NOT NULL,
  -- The agenda copied into each materialized appointment.
  agenda               text NOT NULL DEFAULT '',
  duration_minutes     integer NOT NULL DEFAULT 60 CHECK (duration_minutes > 0),
  -- IANA timezone the schedule is anchored in (so DST doesn't drift the
  -- "every Tuesday at 10am" instances).
  timezone             text NOT NULL DEFAULT 'UTC',
  -- iCalendar-style RRULE encoded as JSON for query-ability + type safety:
  --   {
  --     "freq": "WEEKLY" | "MONTHLY" | "DAILY",
  --     "interval": 1,                       // every-N
  --     "byday": ["MO","TU"],                // weekly only
  --     "bymonthday": [1,15],                // monthly only
  --     "bymonth": [5,6,7,8,9,10],           // restrict to specific months
  --     "byhour": [10],                      // wall clock hour in `timezone`
  --     "byminute": [0],
  --     "until": "2026-10-31T00:00:00Z",
  --     "count": null
  --   }
  schedule             jsonb NOT NULL,
  status               text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'ended', 'cancelled')),
  active_from          timestamptz NOT NULL DEFAULT now(),
  active_until         timestamptz,
  -- Cron-side bookkeeping — last instance materialized, so we don't
  -- walk the entire RRULE every tick.
  last_materialized_at timestamptz,
  context              jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recurring_jobs_user
  ON public.recurring_jobs (user_id, status);
CREATE INDEX IF NOT EXISTS idx_recurring_jobs_active
  ON public.recurring_jobs (status, active_from)
  WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_recurring_jobs_contractor
  ON public.recurring_jobs (contractor_id) WHERE contractor_id IS NOT NULL;

DROP TRIGGER IF EXISTS recurring_jobs_touch_updated_at
  ON public.recurring_jobs;
CREATE TRIGGER recurring_jobs_touch_updated_at
  BEFORE UPDATE ON public.recurring_jobs
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.recurring_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "recurring_jobs: owner read" ON public.recurring_jobs;
CREATE POLICY "recurring_jobs: owner read"
  ON public.recurring_jobs FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- All writes go through service-role (cron + orchestrator).

-- Link materialized appointments back to their recurring job.
ALTER TABLE public.appointments
  ADD COLUMN IF NOT EXISTS recurring_job_id uuid REFERENCES public.recurring_jobs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_appointments_recurring_job
  ON public.appointments (recurring_job_id, scheduled_at)
  WHERE recurring_job_id IS NOT NULL;

-- Unique constraint to prevent duplicate materialization — if cron
-- runs twice in the same minute, we shouldn't double-create.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_appointments_recurring_instance
  ON public.appointments (recurring_job_id, scheduled_at)
  WHERE recurring_job_id IS NOT NULL;
