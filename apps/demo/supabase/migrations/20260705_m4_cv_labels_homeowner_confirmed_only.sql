-- M4.6 follow-up — restrict homeowner reads of cv_labels to confirmed
-- rows only.
--
-- Vision ¶27 speaks of the worker confirming/correcting the AI's guess
-- so accuracy improves over time. The original policy in
-- 20260704_m4_cv_labels.sql exposed raw predicted labels to the
-- homeowner immediately, before the worker got a chance to reject a
-- hallucinated label ("dead lawn", "poison ivy"). That's a bad UX and
-- against the intent of the anchor-set workflow.
--
-- This migration replaces the homeowner-read policy with one that
-- only exposes rows where confirmed_label IS NOT NULL — i.e. the
-- worker has already said "yes that's right" or supplied a
-- correction. Contractor-read is unchanged (contractors need to see
-- pending predictions so they can act on them).

DROP POLICY IF EXISTS "cv_labels: homeowner-read" ON public.cv_labels;
CREATE POLICY "cv_labels: homeowner-read"
  ON public.cv_labels
  FOR SELECT TO authenticated
  USING (
    confirmed_label IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.job_log_entries j
      JOIN public.appointments a ON a.id = j.appointment_id
      WHERE j.id = cv_labels.job_log_entry_id
        AND a.user_id = auth.uid()
    )
  );
