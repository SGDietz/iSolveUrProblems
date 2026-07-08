-- Media capture events.
-- Tied to a LiveAvatar session_id (same as transcript_events.session_id).
-- Stores: every camera snapshot, every recorded video, every gallery upload,
-- and every Go Live polling frame. Purpose: give Claude the ability to audit
-- what 6 was actually looking at when debugging conversation issues.

CREATE TABLE IF NOT EXISTS media_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  source           text NOT NULL CHECK (source IN (
                     'camera_snapshot',
                     'video_recording',
                     'gallery_image',
                     'gallery_video',
                     'go_live_frame'
                   )),
  storage_path     text NOT NULL,      -- key inside the isolve-media bucket
  mime_type        text,
  size_bytes       integer,
  gemini_analysis  text,               -- whatever Gemini said about this frame (null if not analyzed)
  problem_at_time  text,               -- the currentProblemRef value when this was captured
  error            text                -- non-null if analysis errored
);

CREATE INDEX IF NOT EXISTS idx_media_events_session_id
  ON media_events (session_id);

CREATE INDEX IF NOT EXISTS idx_media_events_created_at
  ON media_events (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_events_source
  ON media_events (source);

-- No RLS policies. Service role bypasses RLS; anon has no access.
-- Media is read/written only by the server-side API routes using the
-- service role key from env.
