-- M3.9 — Dispute mediator agent (async-text surface, v1).
--
-- Vision ¶16: "6 will be the front line for disputes, to help work out
-- problems in the moment."
--
-- v1 ships the async-text surface only. The phone-call intake path is
-- gated on M3.1 — when the spike lands we'll add `intake_call_id` and
-- the dispute opener will dual-write into M3.3 transcripts.
--
-- Two tables:
--   disputes          — one row per filed dispute (lifecycle, party, status)
--   dispute_messages  — append-only thread (user + mediator turns)
--
-- Escalation rules (Q3.9a):
--   - 3 mediator turns without resolution → escalate
--   - disputed_amount_cents > $500 → eligible for immediate escalation
--   - user message contains "I want a person" / "human" → escalate now
--
-- When escalation fires, status moves to 'escalated' and the M1.7
-- notifications fabric pings the admin queue (Slack/email per Q3.9a).
--
-- RLS: filing party reads + writes their own; service role bypasses for
-- the mediator brain (which runs server-side) and for escalation cron.

CREATE TABLE IF NOT EXISTS disputes (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contract_id              uuid REFERENCES contracts(id) ON DELETE SET NULL,
  contractor_id            uuid REFERENCES contractors(id) ON DELETE SET NULL,
  -- Which side filed it. v1 lets the homeowner file; contractor-side
  -- filing waits on a contractor portal (not yet built).
  party                    text NOT NULL DEFAULT 'user'
    CHECK (party IN ('user', 'contractor')),
  -- The homeowner's opening complaint — short, free-form.
  complaint                text NOT NULL,
  -- Disputed dollar amount in cents. Used by the >$500 escalation rule.
  disputed_amount_cents    integer,
  -- Lifecycle.
  status                   text NOT NULL DEFAULT 'open'
    CHECK (status IN (
      'open',          -- thread is active, mediator brain is replying
      'awaiting_user', -- mediator asked the user something; waiting
      'resolved',      -- both sides agreed to a remedy
      'escalated',     -- handed to human admin queue
      'closed'         -- archived without further action
    )),
  -- How it ended (set when status reaches resolved/escalated/closed).
  resolution_kind          text
    CHECK (resolution_kind IS NULL OR resolution_kind IN (
      'refund_full',
      'refund_partial',
      'redo_work',
      'no_action',
      'human_escalation'
    )),
  resolution_summary       text,
  -- Counter used by the 3-strike escalation rule. Bumped on each
  -- mediator reply that doesn't resolve.
  mediator_turn_count      integer NOT NULL DEFAULT 0,
  -- For the phone-call intake path (M3.1, deferred).
  intake_call_id           uuid,
  -- Audit context (source intent, transcript pointers, etc.)
  context                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  resolved_at              timestamptz,
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- User-scoped lookup: "show me my open disputes".
CREATE INDEX IF NOT EXISTS idx_disputes_user_status
  ON disputes (user_id, status, created_at DESC);

-- Admin queue lookup: "what's escalated waiting on a human?".
CREATE INDEX IF NOT EXISTS idx_disputes_escalated
  ON disputes (status, created_at DESC)
  WHERE status = 'escalated';

DROP TRIGGER IF EXISTS disputes_touch_updated_at ON disputes;
CREATE TRIGGER disputes_touch_updated_at
  BEFORE UPDATE ON disputes
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE disputes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "disputes: owner read" ON disputes;
CREATE POLICY "disputes: owner read"
  ON disputes
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "disputes: owner write" ON disputes;
CREATE POLICY "disputes: owner write"
  ON disputes
  FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "disputes: owner update" ON disputes;
CREATE POLICY "disputes: owner update"
  ON disputes
  FOR UPDATE
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- ─── Thread messages ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dispute_messages (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id               uuid NOT NULL REFERENCES disputes(id) ON DELETE CASCADE,
  -- Who said it. 'mediator' is 6 — produced by the server-side brain.
  sender                   text NOT NULL
    CHECK (sender IN ('user', 'contractor', 'mediator', 'system')),
  body                     text NOT NULL,
  -- Hints the panel uses: a 'remedy_proposal' renders with an accept
  -- button; an 'escalation_notice' renders with the admin handoff badge.
  kind                     text NOT NULL DEFAULT 'message'
    CHECK (kind IN (
      'message',
      'remedy_proposal',
      'escalation_notice',
      'resolution_confirmation'
    )),
  context                  jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now()
);

-- Order-by-time per thread (panel renders chronologically).
CREATE INDEX IF NOT EXISTS idx_dispute_messages_thread
  ON dispute_messages (dispute_id, created_at);

ALTER TABLE dispute_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "dispute_messages: owner read" ON dispute_messages;
CREATE POLICY "dispute_messages: owner read"
  ON dispute_messages
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM disputes d
      WHERE d.id = dispute_messages.dispute_id
        AND d.user_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "dispute_messages: owner write" ON dispute_messages;
CREATE POLICY "dispute_messages: owner write"
  ON dispute_messages
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM disputes d
      WHERE d.id = dispute_messages.dispute_id
        AND d.user_id = auth.uid()
    )
  );
