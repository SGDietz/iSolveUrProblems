-- M1.8a — Supabase-native error logs.
--
-- Captures uncaught client errors, server-side exceptions, and explicit
-- captureError() calls from API routes. Written via service role only;
-- nobody else can read them (admin console comes in M2.9).
--
-- We deliberately do not store request bodies, emails, or other PII —
-- only user_id (uuid), session_id (LiveAvatar id), and the technical
-- error fields needed to diagnose what broke.

CREATE TABLE IF NOT EXISTS error_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- Severity: 'error' (default) | 'warn' | 'info'
  level         text NOT NULL DEFAULT 'error'
                  CHECK (level IN ('error', 'warn', 'info')),
  -- Where the log originated.
  runtime       text NOT NULL
                  CHECK (runtime IN ('client', 'server', 'edge')),
  user_id       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  session_id    text,
  request_id    text,
  -- The error itself.
  message       text NOT NULL,
  stack         text,
  -- Where the error happened in the app.
  route         text,
  -- Browser UA (client only).
  user_agent    text,
  -- production | preview | development
  env           text,
  -- App version / git sha (best-effort).
  release       text,
  -- Arbitrary structured context — be careful what you put in here;
  -- assume it could be read by a future admin viewer.
  context       jsonb DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_error_logs_created_at
  ON error_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_error_logs_user_id
  ON error_logs (user_id) WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_error_logs_session_id
  ON error_logs (session_id) WHERE session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_error_logs_level
  ON error_logs (level);

CREATE INDEX IF NOT EXISTS idx_error_logs_runtime
  ON error_logs (runtime);

-- Lock down reads. RLS is on; no SELECT/INSERT/UPDATE/DELETE policies
-- are defined, so only the service role (which bypasses RLS) can touch
-- the table. The admin viewer in M2.9 will use the service role too.
ALTER TABLE error_logs ENABLE ROW LEVEL SECURITY;
