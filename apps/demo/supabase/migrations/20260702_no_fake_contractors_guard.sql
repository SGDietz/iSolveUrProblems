-- 2026-07-02 — DB-level enforcement of G's reality doctrine (Herm release
-- blocker #4): the contractors table must NEVER hold fake supply again.
-- The 750 mock rows (+ fake reviews/contract) were purged 2026-07-02 and the
-- mock code paths were deleted; this trigger is the belt-and-suspenders that
-- outlives any future code change — an INSERT/UPDATE with source 'mock' or
-- 'seed' fails loudly at the database, in every environment.
--
-- NOTE on migration hygiene: this project has NO supabase_migrations history
-- table (verified 2026-07-02) — schema changes are applied directly via the
-- management API, and every file in this folder is idempotent (IF NOT EXISTS
-- / OR REPLACE / DROP IF EXISTS) so re-running any of them is safe.

CREATE OR REPLACE FUNCTION public.reject_fake_contractors()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.source IN ('mock', 'seed') THEN
    RAISE EXCEPTION
      'contractors.source "%" is forbidden: real contractors only (G doctrine 2026-07-02)',
      NEW.source;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contractors_reject_fake ON contractors;
CREATE TRIGGER contractors_reject_fake
  BEFORE INSERT OR UPDATE ON contractors
  FOR EACH ROW EXECUTE FUNCTION public.reject_fake_contractors();
