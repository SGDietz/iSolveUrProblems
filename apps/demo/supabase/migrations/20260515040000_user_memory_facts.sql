-- M1.2 — Per-user persistent memory.
--
-- Stores durable facts the LLM extracts from each conversation turn,
-- plus their text-embedding-3-small (1536-dim) vector. Each turn's
-- writer pass distills facts like name / address / property type /
-- preferences / prior issues. The reader pass on the next turn does
-- a similarity search and injects the top-K facts into 6's system prompt.
--
-- Anonymous sessions are NOT stored (no user_id, nowhere to attach
-- memory). Memory only accrues for signed-in users.
--
-- Q1.2a (Supabase pgvector) / Q1.2b (fact extraction, not raw-turn
-- embedding) / Q1.2c (text-embedding-3-small) locked.

-- pgvector — Supabase usually enables this automatically; safe to re-run.
CREATE EXTENSION IF NOT EXISTS vector;

-- Fact kinds we currently recognize. 'other' is the catch-all so the
-- extractor never has to lie about a fact it doesn't fit elsewhere.
DO $$ BEGIN
  CREATE TYPE memory_fact_kind AS ENUM (
    'name',
    'address',
    'property',
    'preference',
    'prior_issue',
    'contact',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS user_memory_facts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  session_id        text,
  kind              memory_fact_kind NOT NULL DEFAULT 'other',
  content           text NOT NULL,
  embedding         vector(1536),
  source_event_id   uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_memory_facts_user_id
  ON user_memory_facts (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_memory_facts_session_id
  ON user_memory_facts (session_id)
  WHERE session_id IS NOT NULL;

-- Approximate-nearest-neighbour index for similarity search. ivfflat
-- with cosine distance is the default Supabase recommendation for
-- 1536-dim OpenAI embeddings at small-to-medium scale.
CREATE INDEX IF NOT EXISTS idx_user_memory_facts_embedding
  ON user_memory_facts
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

-- updated_at trigger (reuses public.touch_updated_at from M1.1).
DROP TRIGGER IF EXISTS user_memory_facts_touch_updated_at ON user_memory_facts;
CREATE TRIGGER user_memory_facts_touch_updated_at
  BEFORE UPDATE ON user_memory_facts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- RLS. Authenticated user can read & delete (right-to-forget) their own
-- facts; service role bypasses RLS for the writer.
ALTER TABLE user_memory_facts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_memory_facts: owner-select" ON user_memory_facts;
CREATE POLICY "user_memory_facts: owner-select"
  ON user_memory_facts
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "user_memory_facts: owner-delete" ON user_memory_facts;
CREATE POLICY "user_memory_facts: owner-delete"
  ON user_memory_facts
  FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- Stored function for the reader pass. PostgREST exposes this as
-- /rest/v1/rpc/match_user_memory_facts so the writer can keep using
-- the existing service-role REST pattern (no supabase-js needed).
CREATE OR REPLACE FUNCTION match_user_memory_facts(
  target_user_id  uuid,
  query_embedding vector(1536),
  match_count     int   DEFAULT 5,
  min_similarity  float DEFAULT 0.0
)
RETURNS TABLE (
  id          uuid,
  kind        memory_fact_kind,
  content     text,
  similarity  float,
  created_at  timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    f.id,
    f.kind,
    f.content,
    1 - (f.embedding <=> query_embedding) AS similarity,
    f.created_at
  FROM user_memory_facts f
  WHERE
    f.user_id = target_user_id
    AND f.embedding IS NOT NULL
    AND 1 - (f.embedding <=> query_embedding) >= min_similarity
  ORDER BY f.embedding <=> query_embedding ASC
  LIMIT match_count;
END
$$;

REVOKE ALL ON FUNCTION match_user_memory_facts FROM PUBLIC;
GRANT EXECUTE ON FUNCTION match_user_memory_facts TO service_role;
