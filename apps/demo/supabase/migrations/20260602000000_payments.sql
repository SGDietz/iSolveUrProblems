-- M2.5 — Payments, platform cut, payouts.
--
-- Vision ¶21: "iSolve makes a cut of every contract"
--
-- Two changes:
--   1. Extend `contractors` with Stripe Connect linkage (account id +
--      payouts_enabled flag).
--   2. Add a `contracts` ledger — one row per accepted estimate, with
--      Stripe IDs and the M2.6 candidate set we need for the win/lose
--      fan-out once payment confirms.
--
-- Connect flavor: Express (Q2.5a) — Stripe-hosted onboarding, stripped-down
-- contractor dashboard, payouts work out of the box.
-- Cut timing:    at job acceptance (Q2.5b) — manual release model.
-- Platform fee:  5 % (Q2.5c) — overridable via PLATFORM_FEE_PERCENT env.
-- Currency:      USD only (Q2.5d) — overridable via PLATFORM_CURRENCY env.
--
-- RLS: contracts are user-scoped (the homeowner who paid). Admin
-- reconciliation goes through service role.

-- 1. Contractors — add Stripe Connect linkage
ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS stripe_connect_account_id text,
  ADD COLUMN IF NOT EXISTS payouts_enabled          boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS stripe_onboarded_at      timestamptz;

CREATE INDEX IF NOT EXISTS idx_contractors_stripe_connect_account_id
  ON contractors (stripe_connect_account_id)
  WHERE stripe_connect_account_id IS NOT NULL;

-- 2. Contracts ledger
CREATE TABLE IF NOT EXISTS contracts (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contractor_id               uuid NOT NULL REFERENCES contractors(id) ON DELETE RESTRICT,
  -- Category snapshot — copied at create time so a renamed category
  -- doesn't break historical contracts.
  category                    text NOT NULL,
  -- Money is stored in cents to dodge float math.
  amount_cents                int  NOT NULL CHECK (amount_cents > 0),
  platform_fee_cents          int  NOT NULL CHECK (platform_fee_cents >= 0),
  currency                    text NOT NULL DEFAULT 'usd',
  status                      text NOT NULL
    CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'canceled'))
    DEFAULT 'pending',
  -- Stripe IDs — populated as the lifecycle progresses.
  stripe_checkout_session_id  text,
  stripe_payment_intent_id    text,
  stripe_transfer_id          text,
  -- M2.6 fan-out target — the other candidates who saw this homeowner.
  candidate_ids               uuid[] NOT NULL DEFAULT '{}',
  -- Free-form audit context.
  context                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  paid_at                     timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_contracts_user_id
  ON contracts (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contracts_contractor_id
  ON contracts (contractor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contracts_status
  ON contracts (status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_stripe_checkout_session_id
  ON contracts (stripe_checkout_session_id)
  WHERE stripe_checkout_session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_stripe_payment_intent_id
  ON contracts (stripe_payment_intent_id)
  WHERE stripe_payment_intent_id IS NOT NULL;

DROP TRIGGER IF EXISTS contracts_touch_updated_at ON contracts;
CREATE TRIGGER contracts_touch_updated_at
  BEFORE UPDATE ON contracts
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE contracts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "contracts: owner read" ON contracts;
CREATE POLICY "contracts: owner read"
  ON contracts
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- All writes go through service role (API routes / webhook). No INSERT
-- / UPDATE policies for end users.
