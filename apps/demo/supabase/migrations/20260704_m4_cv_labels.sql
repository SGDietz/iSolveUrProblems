-- M4.6 — Worker-in-the-loop computer vision labels.
--
-- Vision ¶27: "6 identifies which plants are weeds and which are
-- flowers ... over time, the Ai will learn and improve its accuracy."
--
-- One row per prediction over a job-log photo. The prediction is made
-- by OpenAI Vision (`gpt-4o` in v1 — see src/lib/vision/classify.ts);
-- the worker confirms or corrects it inline, and the correction is
-- persisted so a future v2 fine-tune can consume the anchor set. v1
-- is data-collection-only: no fine-tune, no visual-diff, no
-- multi-visit comparison.
--
-- Tier gate: gold-only (billing/tiers.ts `cv_labeling`). Free / bronze
-- / silver contractors don't see the "identify" button.
--
-- Note on privacy: we already hold the photo bytes in the `job-logs`
-- bucket. cv_labels stores only the returned label + confidence, not
-- the photo itself. If the source job_log_entries row is deleted, the
-- cv_labels row goes with it via ON DELETE CASCADE.

CREATE TABLE IF NOT EXISTS public.cv_labels (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_log_entry_id       uuid NOT NULL REFERENCES public.job_log_entries(id) ON DELETE CASCADE,
  -- The model that produced the prediction (e.g. 'gpt-4o'). Useful
  -- for later comparing model versions and gating fine-tune snapshots
  -- to a single model family.
  model                  text NOT NULL,
  -- The predicted label — typically short ("weed", "flower", or a
  -- specific species name if the model is confident). Free-form.
  predicted_label        text NOT NULL,
  -- Bucketed confidence, keeping the vision-response schema simple.
  -- Q4.6b — 70% test-set accuracy is the gate; per-item confidence is
  -- distinct (worker-facing signal, not our ship criterion).
  predicted_confidence   text NOT NULL
    CHECK (predicted_confidence IN ('low', 'medium', 'high')),
  -- Optional short list of alternative candidates the model returned.
  alternatives           jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Worker correction. When the predicted label is right, the worker
  -- taps "yes" and we copy predicted_label here. When wrong, they
  -- type/say a correction. NULL until confirmed.
  confirmed_label        text,
  confirmed_correct      boolean,
  confirmed_by_user_id   uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  confirmed_at           timestamptz,
  -- Free-form: prompt hint the worker gave ("focus on the plant on the
  -- left"), model latency ms, raw API response snippet, etc.
  context                jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- The common lookup: "give me the CV predictions for this log entry".
-- ORDER BY created_at DESC so the most recent prediction wins on
-- multi-prediction rows (e.g. worker asked 6 to re-identify).
CREATE INDEX IF NOT EXISTS idx_cv_labels_entry
  ON public.cv_labels (job_log_entry_id, created_at DESC);

-- The fine-tune anchor query: "give me all confirmed labels since T".
-- Only rows the worker actually confirmed become training data.
CREATE INDEX IF NOT EXISTS idx_cv_labels_confirmed
  ON public.cv_labels (confirmed_at DESC)
  WHERE confirmed_label IS NOT NULL;

DROP TRIGGER IF EXISTS cv_labels_touch_updated_at ON public.cv_labels;
CREATE TRIGGER cv_labels_touch_updated_at
  BEFORE UPDATE ON public.cv_labels
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.cv_labels ENABLE ROW LEVEL SECURITY;

-- Claimed contractor for the underlying job log reads their own rows.
DROP POLICY IF EXISTS "cv_labels: contractor-read" ON public.cv_labels;
CREATE POLICY "cv_labels: contractor-read"
  ON public.cv_labels
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.job_log_entries j
      JOIN public.contractors c ON c.id = j.contractor_id
      WHERE j.id = cv_labels.job_log_entry_id
        AND c.claimed_by_user_id = auth.uid()
    )
  );

-- Homeowner reads CV labels attached to their own appointments' photos.
DROP POLICY IF EXISTS "cv_labels: homeowner-read" ON public.cv_labels;
CREATE POLICY "cv_labels: homeowner-read"
  ON public.cv_labels
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.job_log_entries j
      JOIN public.appointments a ON a.id = j.appointment_id
      WHERE j.id = cv_labels.job_log_entry_id
        AND a.user_id = auth.uid()
    )
  );
