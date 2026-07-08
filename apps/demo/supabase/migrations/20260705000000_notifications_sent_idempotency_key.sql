-- Add durable notification idempotency for cron fan-out.
--
-- A queued row is inserted before provider dispatch. The unique key prevents
-- overlapping/retry cron passes from dispatching the same recipient/template
-- again while the first attempt is queued or already sent. Failed sends clear
-- the key in application code so legitimate retries can create a new attempt.

alter table public.notifications_sent
  add column if not exists idempotency_key text;

create unique index if not exists uniq_notifications_sent_idempotency_key
  on public.notifications_sent (idempotency_key);

comment on column public.notifications_sent.idempotency_key is
  'Optional durable dedupe key for idempotent notification fan-out; failed sends clear it so retries can proceed.';
