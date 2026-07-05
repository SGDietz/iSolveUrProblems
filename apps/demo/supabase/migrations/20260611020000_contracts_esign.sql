-- M3.7 — Contract drafter + e-signature delivery.
--
-- Vision ¶17: "write up contracts... deliver the contract in writing in
-- their email box."
--
-- Extends the M2.5 contracts table with the e-signature lifecycle columns.
-- v1 ships with the `mock` provider (auto-signs at draft time so the
-- M3.0d test drive can demonstrate the end-to-end loop without the real
-- vendor). When SG Dietz hands over Dropbox Sign sandbox keys we swap
-- the provider implementation; no schema change needed.
--
-- New columns:
--   scope                      — what the work covers (drives the doc body)
--   esign_provider             — 'mock' | 'dropbox_sign' | ... — which path
--                                the envelope was routed through
--   esign_envelope_id          — provider's external id; used for webhook
--                                reconciliation
--   esign_envelope_status      — 'draft' | 'sent' | 'awaiting_signature' |
--                                'signed' | 'declined' | 'cancelled' | 'expired'
--   esign_signing_url_user     — short-lived URL the homeowner clicks
--   esign_signing_url_contractor — short-lived URL the contractor clicks
--   signed_at_user             — set when homeowner completes signing
--   signed_at_contractor       — set when contractor completes signing
--   contract_doc_url           — final signed PDF URL (Stripe-style, post-sign)
--
-- All columns are nullable so existing rows (M2.5 contracts pre-M3.7)
-- stay valid.

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS scope                       text,
  ADD COLUMN IF NOT EXISTS esign_provider              text,
  ADD COLUMN IF NOT EXISTS esign_envelope_id           text,
  ADD COLUMN IF NOT EXISTS esign_envelope_status       text
    CHECK (esign_envelope_status IS NULL OR esign_envelope_status IN (
      'draft', 'sent', 'awaiting_signature',
      'signed', 'declined', 'cancelled', 'expired'
    )),
  ADD COLUMN IF NOT EXISTS esign_signing_url_user        text,
  ADD COLUMN IF NOT EXISTS esign_signing_url_contractor  text,
  ADD COLUMN IF NOT EXISTS signed_at_user                timestamptz,
  ADD COLUMN IF NOT EXISTS signed_at_contractor          timestamptz,
  ADD COLUMN IF NOT EXISTS contract_doc_url              text;

-- Webhook reconciliation needs to find a contract by its envelope id fast.
CREATE UNIQUE INDEX IF NOT EXISTS idx_contracts_esign_envelope_id
  ON contracts (esign_envelope_id)
  WHERE esign_envelope_id IS NOT NULL;

-- "Show me unsigned contracts" — useful for cron reminders or admin views.
CREATE INDEX IF NOT EXISTS idx_contracts_unsigned
  ON contracts (esign_envelope_status, created_at DESC)
  WHERE esign_envelope_status IN ('awaiting_signature', 'sent');
