-- Session media ledger (G order 2026-07-02 night: "start saving all pics and
-- vids as standard. While testing, we will mostly delete them").
-- Rows point at private Storage objects in the session-media bucket; the
-- media itself never becomes public. Deleting a row + object is the whole
-- cleanup story for test wipes.
-- APPEND-ONLY schema doctrine: new table only.

create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  -- LiveAvatar session id (joins conversation_messages/app_events envelope)
  session_id text,
  kind text not null check (kind in ('photo', 'video')),
  -- object path inside the session-media bucket
  storage_path text not null,
  mime text,
  bytes bigint,
  env text,
  created_at timestamptz not null default now()
);

create index if not exists media_assets_session_id_idx
  on public.media_assets (session_id);
create index if not exists media_assets_created_at_idx
  on public.media_assets (created_at desc);

-- Service-role only (RLS on, zero public policies) — uploads flow through
-- our signed-URL route, reads through service-role tooling only.
alter table public.media_assets enable row level security;
