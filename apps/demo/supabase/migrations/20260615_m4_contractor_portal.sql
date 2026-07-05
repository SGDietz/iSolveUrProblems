-- M4.0 — Contractor portal foundation.
--
-- Vision-doc anchor: M4.0 is foundational scaffolding (like M3.0), not
-- a vision-paragraph feature. It enables every M4.x downstream feature
-- (M4.1 subscriptions, M4.2 crew marketplace, M4.3 checklist, M4.5
-- photo logs, M4.7 recurring jobs, etc.) by giving contractors a
-- logged-in surface.
--
-- This migration adds:
--   1. users.role + users.contractor_id — link the auth user to a
--      contractor row (one user can claim at most one contractor profile)
--   2. contractors.claimed_at + claimed_by_user_id — who claimed this
--      row, when
--   3. contractors.license_* — M4.0a license-board metadata
--   4. contractors.stripe_billing_customer_id — M4.1 Stripe Billing
--      (separate identifier from stripe_connect_account_id which is
--      the Connect Express account from M2.5)
--   5. contractor_billing_subscriptions — M4.1 subscription state
--      (mirror of Stripe Billing's source of truth)
--
-- Backward compatible: every column added is nullable, every CHECK
-- only enforces values that already exist for legacy rows.

-- ─── 1. users.role + users.contractor_id ───────────────────────────

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'homeowner'
    CHECK (role IN ('homeowner', 'contractor', 'admin')),
  ADD COLUMN IF NOT EXISTS contractor_id uuid REFERENCES public.contractors(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_role
  ON public.users (role) WHERE role <> 'homeowner';
CREATE INDEX IF NOT EXISTS idx_users_contractor_id
  ON public.users (contractor_id) WHERE contractor_id IS NOT NULL;

-- ─── 2. contractors.claim metadata ────────────────────────────────

ALTER TABLE public.contractors
  ADD COLUMN IF NOT EXISTS claimed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS claim_status      text NOT NULL DEFAULT 'unclaimed'
    CHECK (claim_status IN ('unclaimed', 'pending_review', 'claimed', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_contractors_claim_status
  ON public.contractors (claim_status) WHERE claim_status <> 'unclaimed';
CREATE INDEX IF NOT EXISTS idx_contractors_claimed_by_user
  ON public.contractors (claimed_by_user_id) WHERE claimed_by_user_id IS NOT NULL;

-- One contractor row per claiming user (a user can't claim multiple
-- contractor profiles). Enforced via partial unique index — only
-- enforces uniqueness among rows that actually have a claimer.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_contractors_claimed_by_user
  ON public.contractors (claimed_by_user_id)
  WHERE claimed_by_user_id IS NOT NULL;

-- ─── 3. contractors.license_* (M4.0a CSLB + future state boards) ──

ALTER TABLE public.contractors
  ADD COLUMN IF NOT EXISTS license_number          text,
  ADD COLUMN IF NOT EXISTS license_issuing_state   text,  -- 'CA','TX','FL','NY',...
  ADD COLUMN IF NOT EXISTS license_status          text
    CHECK (license_status IS NULL OR license_status IN (
      'active', 'expired', 'suspended', 'revoked', 'inactive', 'unknown'
    )),
  ADD COLUMN IF NOT EXISTS license_issued_at       date,
  ADD COLUMN IF NOT EXISTS license_expires_at      date,
  ADD COLUMN IF NOT EXISTS license_classifications text[] NOT NULL DEFAULT '{}',
    -- CSLB-style: ['C-36', 'B'] etc. Per-state vocabulary.
  ADD COLUMN IF NOT EXISTS license_verified_at     timestamptz;
    -- When we last re-pulled from the issuing board.

CREATE INDEX IF NOT EXISTS idx_contractors_license_number
  ON public.contractors (license_number)
  WHERE license_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contractors_license_status_state
  ON public.contractors (license_status, license_issuing_state)
  WHERE license_status IS NOT NULL;

-- ─── 4. contractors.stripe_billing_customer_id (M4.1) ─────────────

ALTER TABLE public.contractors
  ADD COLUMN IF NOT EXISTS stripe_billing_customer_id text;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_contractors_stripe_billing_customer
  ON public.contractors (stripe_billing_customer_id)
  WHERE stripe_billing_customer_id IS NOT NULL;

-- ─── 5. contractor_billing_subscriptions (M4.1) ───────────────────

CREATE TABLE IF NOT EXISTS public.contractor_billing_subscriptions (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id               uuid NOT NULL REFERENCES public.contractors(id) ON DELETE CASCADE,
  stripe_subscription_id      text NOT NULL UNIQUE,
  stripe_customer_id          text NOT NULL,
  stripe_price_id             text NOT NULL,
  -- Free / bronze / silver / gold — directional v1 tiers.
  tier                        text NOT NULL DEFAULT 'free'
    CHECK (tier IN ('free', 'bronze', 'silver', 'gold')),
  status                      text NOT NULL
    CHECK (status IN (
      'trialing', 'active', 'past_due', 'canceled',
      'incomplete', 'incomplete_expired', 'unpaid', 'paused'
    )),
  current_period_start        timestamptz,
  current_period_end          timestamptz,
  cancel_at_period_end        boolean NOT NULL DEFAULT false,
  canceled_at                 timestamptz,
  trial_end                   timestamptz,
  context                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contractor_subscriptions_contractor
  ON public.contractor_billing_subscriptions (contractor_id);
CREATE INDEX IF NOT EXISTS idx_contractor_subscriptions_status
  ON public.contractor_billing_subscriptions (status)
  WHERE status IN ('active', 'trialing', 'past_due');

DROP TRIGGER IF EXISTS contractor_subscriptions_touch_updated_at
  ON public.contractor_billing_subscriptions;
CREATE TRIGGER contractor_subscriptions_touch_updated_at
  BEFORE UPDATE ON public.contractor_billing_subscriptions
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.contractor_billing_subscriptions ENABLE ROW LEVEL SECURITY;

-- Contractor can read their own subscription row.
DROP POLICY IF EXISTS "contractor_subs: claimer-read"
  ON public.contractor_billing_subscriptions;
CREATE POLICY "contractor_subs: claimer-read"
  ON public.contractor_billing_subscriptions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.contractors c
      WHERE c.id = contractor_billing_subscriptions.contractor_id
        AND c.claimed_by_user_id = auth.uid()
    )
  );

-- ─── 6. Public-ish read on contractors for self-service ───────────
--
-- contractors are now partially user-facing (a claiming contractor
-- needs to read their own row in the dashboard). Allow authenticated
-- users to read rows they have claimed. Service role bypasses for all
-- other access (search, recommend, etc. — same as before M4).

ALTER TABLE public.contractors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "contractors: claimer-read" ON public.contractors;
CREATE POLICY "contractors: claimer-read"
  ON public.contractors
  FOR SELECT TO authenticated
  USING (claimed_by_user_id = auth.uid());

-- ─── 7. Claim audit log (operational for admin review) ────────────

CREATE TABLE IF NOT EXISTS public.contractor_claim_attempts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id       uuid REFERENCES public.contractors(id) ON DELETE SET NULL,
  attempted_by_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Which signal(s) the user provided. JSON for forward-compat.
  signals             jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Outcome of the verification check.
  outcome             text NOT NULL
    CHECK (outcome IN (
      'auto_approved',    -- strong signal match (email + license)
      'pending_review',   -- ambiguous; admin must decide
      'rejected',         -- conflict with existing claim
      'invalid'           -- malformed input
    )),
  reason              text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_claim_attempts_user
  ON public.contractor_claim_attempts (attempted_by_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_claim_attempts_pending
  ON public.contractor_claim_attempts (outcome, created_at DESC)
  WHERE outcome = 'pending_review';
