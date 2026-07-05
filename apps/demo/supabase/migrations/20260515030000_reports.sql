-- M1.5 — Fix-it reports.
--
-- Vision ¶7: "6 will offer to send them a written report explaining all
-- the fixes by email, text, or messaging app — however they prefer."
--
-- One row per generated report. The structured Report JSON is kept in
-- `payload` so we can re-render later (e.g. theme refresh, locale swap)
-- without re-running the expensive LLM compose step. The rendered HTML
-- and PDF are uploaded to the 'reports' Storage bucket; the row stores
-- their object paths.
--
-- A separate manual step is needed in the Supabase Dashboard:
-- Storage → New bucket → name "reports", private (RLS only). The server
-- writes via service role; signed URLs serve to end users.
--
-- RLS: owner reads their own; service role bypasses for writes + admin.

CREATE TABLE IF NOT EXISTS reports (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id   text,
  locale       text NOT NULL DEFAULT 'en',
  -- LLM-output title + summary, denormalized for list views.
  title        text,
  summary      text,
  -- Full structured Report JSON (sections / steps / materials / photos).
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Storage paths inside the 'reports' bucket.
  html_path    text,
  pdf_path     text,
  -- Lifecycle.
  status       text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued', 'generating', 'ready', 'failed')),
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reports_user_id
  ON reports (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reports_session_id
  ON reports (session_id)
  WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reports_status
  ON reports (status);

DROP TRIGGER IF EXISTS reports_touch_updated_at ON reports;
CREATE TRIGGER reports_touch_updated_at
  BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE reports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reports: owner-select" ON reports;
CREATE POLICY "reports: owner-select"
  ON reports
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "reports: owner-delete" ON reports;
CREATE POLICY "reports: owner-delete"
  ON reports
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());
