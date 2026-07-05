-- Herm TASK_096 wipe-correctness fix: media cleanup needs a direct user
-- handle, not just session correlation. Nullable (anonymous sessions save
-- media too), populated by /api/media/save when a user is signed in.
-- APPEND-ONLY: additive column + index only.

alter table public.media_assets
  add column if not exists user_id uuid;

create index if not exists media_assets_user_id_idx
  on public.media_assets (user_id);
