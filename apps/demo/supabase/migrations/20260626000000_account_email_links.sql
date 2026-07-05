-- account_email_links — voice-account resume store.
-- Ported from aiASAP (schema.sql), adapted for iSolve's own Supabase project.
-- Holds the email 6 captures by voice + the magic-link token hash + a resume
-- payload, so on return 6 can say "You talked, I remembered."
--
-- IMPORTANT (G's rule): expires_at gates RESUME-STATE freshness, NOT the user's
-- ability to sign in. A stale row must still sign the user in (with a fresh/blank
-- resume) — never a dead-end. 6 can offer a fresh link.
--
-- RLS is ENABLED with NO policies => client roles (anon/authenticated) get no
-- access; only the service role (which bypasses RLS) reads/writes, via the
-- /api/account/* routes. Mirrors aiASAP's service-role-only access.

create table if not exists public.account_email_links (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  session_id text,
  token_hash text not null unique,
  captured_lists jsonb not null default '[]'::jsonb,  -- { lists, resumeState, fullName }
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_account_email_links_email
  on public.account_email_links (email);
create index if not exists idx_account_email_links_created
  on public.account_email_links (created_at desc);

alter table public.account_email_links enable row level security;
-- (no policies on purpose — service role bypasses RLS for the account routes)
