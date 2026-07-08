-- M3.1 — 3-way phone calls with 6 as an active participant.
--
-- Vision ¶13: "6 calls the contractor and the homeowner on a 3-way phone
-- call, and 6 is on the line as a participant."
--
-- Architecture (Vercel-compatible — no WebSocket required):
--   1. /api/calls/start dials homeowner + contractor + creates a Twilio
--      Conference room they both join
--   2. Twilio fires `<Start><Transcription>` against the conference, so
--      both sides' speech is transcribed by Twilio's built-in STT and
--      POSTed back to /api/webhooks/twilio/transcription
--   3. Each transcript chunk is persisted into the existing M3.0c
--      `transcripts` table (using session_id = our call.id) AND routed
--      through the M3.0e intent orchestrator
--   4. When the orchestrator decides 6 should speak (Q3.1c: only when
--      addressed by name), we POST to Twilio's REST API to update the
--      6 participant's TwiML with `<Say>` text — Twilio's TTS pipes it
--      into the conference live
--
-- M3.3 piggy-backs on this table: `recording_url` is the Twilio-stored
-- recording URL, mirrored into Supabase Storage by the recording webhook.
--
-- RLS: only the homeowner reads their own calls. Service role bypasses
-- everywhere because all writes (Twilio webhooks, orchestrator) run
-- server-side.

CREATE TABLE IF NOT EXISTS calls (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contractor_id            uuid REFERENCES contractors(id) ON DELETE SET NULL,
  contract_id              uuid REFERENCES contracts(id) ON DELETE SET NULL,
  -- Twilio identifiers.
  twilio_conference_sid    text,
  twilio_call_sid_user     text,
  twilio_call_sid_contractor text,
  twilio_call_sid_six      text,
  -- Phone numbers we dialed (E.164 format).
  to_user_phone            text NOT NULL,
  to_contractor_phone      text NOT NULL,
  from_phone               text NOT NULL,
  -- Lifecycle.
  status                   text NOT NULL DEFAULT 'queued'
    CHECK (status IN (
      'queued',          -- /start route created the row, hasn't dialed yet
      'dialing',         -- Twilio dialing both parties
      'in_progress',     -- both joined the conference
      'completed',       -- normal hangup
      'failed',          -- one or both legs failed to connect
      'no_answer',
      'busy',
      'cancelled'
    )),
  -- "Hey 6" wake-word state. v1: when 6 is currently speaking we don't
  -- want to fire another response on top of itself.
  six_speaking             boolean NOT NULL DEFAULT false,
  -- M3.3 — recording bookkeeping. Set by the recording-completed webhook.
  twilio_recording_sid     text,
  twilio_recording_url     text,
  storage_recording_path   text,  -- Supabase Storage object key
  recording_duration_s     integer,
  -- Free-form audit / debug context.
  context                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at               timestamptz,
  ended_at                 timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_calls_user_created
  ON calls (user_id, created_at DESC);

-- Webhook reconciliation: find a call by any of its Twilio call SIDs.
CREATE INDEX IF NOT EXISTS idx_calls_call_sid_user
  ON calls (twilio_call_sid_user) WHERE twilio_call_sid_user IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calls_call_sid_contractor
  ON calls (twilio_call_sid_contractor) WHERE twilio_call_sid_contractor IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calls_call_sid_six
  ON calls (twilio_call_sid_six) WHERE twilio_call_sid_six IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_calls_conf_sid
  ON calls (twilio_conference_sid) WHERE twilio_conference_sid IS NOT NULL;

DROP TRIGGER IF EXISTS calls_touch_updated_at ON calls;
CREATE TRIGGER calls_touch_updated_at
  BEFORE UPDATE ON calls
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "calls: owner read" ON calls;
CREATE POLICY "calls: owner read"
  ON calls FOR SELECT TO authenticated
  USING (user_id = auth.uid());

-- All writes go through service-role (Twilio webhooks + orchestrator).

-- M3.0c transcripts table reuse: pass call.id as session_id when
-- persisting per-call utterances. We also need to relax the speaker
-- check so phone-call participants ("contractor" and "six") are valid.
ALTER TABLE transcripts DROP CONSTRAINT IF EXISTS transcripts_speaker_check;
ALTER TABLE transcripts
  ADD CONSTRAINT transcripts_speaker_check
  CHECK (speaker IN ('user', 'avatar', 'contractor', 'six', 'system'));

-- M3.6 — Voice-driven estimate generator.
--
-- Vision ¶17: "help estimate projects... simply by talking to the
-- contractor, which can be done as the contractor drives down the road"
--
-- Q3.6a — Fixed JSON schema. line_items is a structured array so M3.7
-- contract drafting can read the canonical scope and so M5 historical
-- analysis has consistent shape.
--
-- v1 source: a completed M3.1 call. v1.1 may accept synchronous voice
-- intake outside a phone call.

CREATE TABLE IF NOT EXISTS estimates (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contractor_id            uuid REFERENCES contractors(id) ON DELETE SET NULL,
  call_id                  uuid REFERENCES calls(id) ON DELETE SET NULL,
  contract_id              uuid REFERENCES contracts(id) ON DELETE SET NULL,
  -- Free-form scope summary the contractor verbally walked through.
  scope_summary            text NOT NULL DEFAULT '',
  -- Structured line items per Q3.6a fixed schema.
  line_items               jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal_cents           integer NOT NULL DEFAULT 0,
  tax_cents                integer NOT NULL DEFAULT 0,
  total_cents              integer NOT NULL DEFAULT 0,
  currency                 text NOT NULL DEFAULT 'USD',
  status                   text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'sent', 'accepted', 'declined', 'expired')),
  -- Where the source transcripts came from (for re-extraction).
  source                   text NOT NULL DEFAULT 'call'
    CHECK (source IN ('call', 'manual', 'voice_intake')),
  context                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_estimates_user_created
  ON estimates (user_id, created_at DESC);

DROP TRIGGER IF EXISTS estimates_touch_updated_at ON estimates;
CREATE TRIGGER estimates_touch_updated_at
  BEFORE UPDATE ON estimates
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE estimates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "estimates: owner read" ON estimates;
CREATE POLICY "estimates: owner read"
  ON estimates FOR SELECT TO authenticated
  USING (user_id = auth.uid());
