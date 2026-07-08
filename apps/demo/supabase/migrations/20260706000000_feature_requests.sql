-- Feature/channel/bug request capture from voice turns.
--
-- Used when 6 hears "send it by WeChat", "you should add X", or a
-- user reports a product bug. Inserts are service-role only and must be
-- fail-soft from the app so user speech is never blocked by triage logging.

create table if not exists public.feature_requests (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  session_id        text not null,
  user_id           uuid references auth.users(id) on delete set null,
  kind              text not null check (kind in ('channel', 'feature', 'bug')),
  raw_text          text not null,
  requested_channel text,
  source            text not null default 'voice',
  status            text not null default 'new'
                    check (status in ('new', 'triaged', 'planned', 'done', 'wont_do')),
  context           jsonb not null default '{}'::jsonb
);

create index if not exists idx_feature_requests_session
  on public.feature_requests (session_id, created_at desc);

create index if not exists idx_feature_requests_status
  on public.feature_requests (status, created_at desc);

create index if not exists idx_feature_requests_kind
  on public.feature_requests (kind, created_at desc);

create index if not exists idx_feature_requests_requested_channel
  on public.feature_requests (requested_channel, created_at desc)
  where requested_channel is not null;

comment on table public.feature_requests is
  'Fail-soft voice/user capture for unsupported channel asks, feature requests, and bug reports.';

comment on column public.feature_requests.raw_text is
  'Truncated/sanitized user text that triggered the request. Never store env values or credentials here.';

comment on column public.feature_requests.context is
  'Small redacted metadata only; app code strips secret-like keys before insert.';

drop trigger if exists feature_requests_touch_updated_at on public.feature_requests;
create trigger feature_requests_touch_updated_at
  before update on public.feature_requests
  for each row execute function public.touch_updated_at();

alter table public.feature_requests enable row level security;
-- No policies: service role only, same posture as notifications_sent.
