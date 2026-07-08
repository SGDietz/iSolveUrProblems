-- M3.0c — Conversation transcripts.
--
-- Captures every USER_TRANSCRIPTION + AVATAR_TRANSCRIPTION event from
-- the avatar session, one row per finalized utterance (per turn). This
-- becomes the signal the M3.0e intent classifier reads and the corpus
-- the M3.9 dispute mediator references.
--
-- We persist user transcripts always; avatar transcripts only when
-- they're useful for downstream audit (replay / dispute / debugging).
--
-- RLS: service role only. The API route uses service role to write
-- and read; clients never query this table directly.

CREATE TABLE IF NOT EXISTS transcripts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Anonymous sessions are allowed (M3.0d test drive lets you talk
  -- to 6 without signing in), so user_id is nullable.
  user_id      uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  -- HeyGen session id — links every utterance in one conversation.
  session_id   text NOT NULL,
  speaker      text NOT NULL CHECK (speaker IN ('user', 'avatar')),
  text         text NOT NULL,
  -- Per-turn metadata (optional). Captures things like turn index, or
  -- the avatar's prior-turn id, for downstream analysis.
  context      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Fast recall by session — M3.0e needs the last N turns of a session
-- to classify intent; M3.9 needs the full transcript to mediate.
CREATE INDEX IF NOT EXISTS idx_transcripts_session_id_created_at
  ON transcripts (session_id, created_at DESC);

-- Per-user recall (e.g. "show me what I talked to 6 about last week").
CREATE INDEX IF NOT EXISTS idx_transcripts_user_id_created_at
  ON transcripts (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
-- No policies — service role only. The /api/transcripts/append route
-- writes; /api/intent/classify (M3.0e) and the M3.9 mediator read.
