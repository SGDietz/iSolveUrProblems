-- M2.3 — Review summarizer storage.
--
-- Vision ¶11: "summarize their reviews, strengths and weaknesses"
--
-- One row per contractor — the latest LLM-generated synthesis of their
-- reviews. Generation is lazy (on-demand from the API route in v1) and
-- cached; a future cron job (M3+) refreshes when ≥5 new reviews have
-- arrived or the row is >30 days old.
--
-- RLS: service-role only. The API route uses service role to read+write,
-- and exposes the summary to clients via /api/contractors/[id]/summary.

CREATE TABLE IF NOT EXISTS contractor_summaries (
  contractor_id     uuid PRIMARY KEY REFERENCES contractors(id) ON DELETE CASCADE,
  summary           text NOT NULL,
  strengths_md      text NOT NULL DEFAULT '',
  weaknesses_md     text NOT NULL DEFAULT '',
  sample_quotes     jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Number of reviews the summary was generated from. Lets the lazy
  -- refresher decide whether to regenerate (>=5 new since last run).
  reviews_summarized int NOT NULL DEFAULT 0,
  model             text NOT NULL,
  generated_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contractor_summaries_generated_at
  ON contractor_summaries (generated_at DESC);

DROP TRIGGER IF EXISTS contractor_summaries_touch_updated_at
  ON contractor_summaries;
CREATE TRIGGER contractor_summaries_touch_updated_at
  BEFORE UPDATE ON contractor_summaries
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE contractor_summaries ENABLE ROW LEVEL SECURITY;
-- No policies — service role only.
