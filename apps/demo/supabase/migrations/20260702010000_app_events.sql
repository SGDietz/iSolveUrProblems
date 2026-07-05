-- app_events — first-party product telemetry ledger (G order 2026-07-02:
-- "if people get the phone number and just call themselves, we're out of
-- the loop"). First consumers: the tap-to-call consent sheet
-- (open / yes / dismiss) and whole-card website taps, so iSolve can COUNT
-- the calls and site visits it sends each contractor. Also closes Herm's
-- standing gap: "client_sessions and app_events tables are missing, so
-- Supabase cannot prove device/layout from first-party telemetry."
--
-- Append-only by doctrine (like every table here — never less data).
-- No PII beyond user_id/session ids; contractor phone numbers are NOT
-- stored (contractor_id/source_id resolve them).

CREATE TABLE IF NOT EXISTS app_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Server-side allowlisted event name (see /api/events route).
  event         text NOT NULL CHECK (char_length(event) <= 80),
  user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id    text,
  -- Persisted contractor rows get contractor_id (uuid). Live Outscraper
  -- cards that missed the 2.5s persist window carry a place_id instead —
  -- that lands in source_id (the TASK_065 id-shape lesson).
  contractor_id uuid REFERENCES contractors(id) ON DELETE SET NULL,
  source_id     text,
  -- production | preview | development
  env           text,
  -- Git sha / deployment id (best-effort).
  release       text,
  user_agent    text,
  context       jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_app_events_created_at
  ON app_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_app_events_event
  ON app_events (event);

CREATE INDEX IF NOT EXISTS idx_app_events_contractor_id
  ON app_events (contractor_id) WHERE contractor_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_app_events_session_id
  ON app_events (session_id) WHERE session_id IS NOT NULL;

-- RLS on, zero policies: only the service role (which bypasses RLS) can
-- read or write — same lockdown as error_logs.
ALTER TABLE app_events ENABLE ROW LEVEL SECURITY;
