-- 3-way call consent ledger (G order 2026-07-02 night: "write the code for
-- permissions with 3 way calling"; Herm TASK_088/092 legal gates).
-- MD all-party consent is a CRIMINAL statute (§10-402): recording or
-- transcription may only ever run when EVERY party's consent row says yes.
-- The feature flag FEATURE_AI_CONFERENCE_CALLS stays OFF regardless; this
-- ledger is the machinery that must exist BEFORE any enable.
-- APPEND-ONLY schema doctrine: new table, no changes to existing tables.

create table if not exists public.call_consents (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null,
  -- who consented: the homeowner (in-app sheet) or the contractor (phone
  -- keypress/speech at pickup)
  party text not null check (party in ('user', 'contractor')),
  consented boolean not null,
  -- how consent was captured: app_sheet (homeowner tap), dtmf (pressed 1),
  -- speech ("yes"), timeout (no answer = NO consent, fail-closed)
  method text not null check (method in ('app_sheet', 'dtmf', 'speech', 'timeout')),
  -- exact consent copy version shown/spoken, for the audit trail
  consent_version text not null default 'v1',
  created_at timestamptz not null default now()
);

create index if not exists call_consents_call_id_idx
  on public.call_consents (call_id);
create index if not exists call_consents_created_at_idx
  on public.call_consents (created_at desc);

-- Service-role only (RLS on, zero public policies) — consent rows are legal
-- audit data, never client-readable/writable directly.
alter table public.call_consents enable row level security;
