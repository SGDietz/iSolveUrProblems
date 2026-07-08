-- M2.5 fix — gate on charges_enabled instead of payouts_enabled.
--
-- The original gate in /api/contracts/create blocked Hire & pay until
-- the contractor's Stripe Connect account had `payouts_enabled=true`.
-- That's stricter than Stripe actually requires for a destination
-- charge: we only need `charges_enabled=true` on the connected account
-- for funds to transfer into its Stripe balance. `payouts_enabled`
-- governs whether the contractor can move from Stripe balance to their
-- own bank, which is async and Stripe's verification, not ours.
--
-- This migration adds a separate `stripe_charges_enabled` column we can
-- gate on instead. `payouts_enabled` stays as an informational field
-- (audit / UI display) but is no longer the blocker.
--
-- Backfill: any contractor whose `payouts_enabled` is already true
-- definitionally has `charges_enabled` true too (Stripe never enables
-- payouts before charges). So we copy the flag forward so existing
-- connected contractors keep working without re-syncing.

ALTER TABLE contractors
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled boolean NOT NULL DEFAULT false;

UPDATE contractors
   SET stripe_charges_enabled = true
 WHERE payouts_enabled = true
   AND stripe_charges_enabled = false;

CREATE INDEX IF NOT EXISTS idx_contractors_stripe_charges_enabled
  ON contractors (stripe_charges_enabled)
  WHERE stripe_charges_enabled = true;
