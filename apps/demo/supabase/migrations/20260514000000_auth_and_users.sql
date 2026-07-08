-- M1.1 — Supabase Auth: users profile + RLS on session-keyed tables.
--
-- Adds a public.users profile that 1:1 extends auth.users, and idempotently
-- adds nullable user_id columns + RLS to the existing session-keyed tables
-- (transcript_events, conversation_messages, media_events, lead_sessions,
-- contact_entities). RLS lets logged-in users read their own rows; service
-- role bypasses RLS, so every existing server route keeps working.
--
-- user_id is left NULL-able so anonymous sessions still write fine. After
-- a user signs in, /api/auth/link-session re-keys their anonymous rows.

-- 1. Profile table extending auth.users
CREATE TABLE IF NOT EXISTS public.users (
  id                  uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email               text,
  phone               text,
  full_name           text,
  preferred_locale    text DEFAULT 'en',
  preferred_channels  jsonb DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_users_email ON public.users (email);

-- 2. Auto-create public.users row whenever a new auth.users row appears
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.users (id, email, phone, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    NEW.phone,
    COALESCE(
      NEW.raw_user_meta_data->>'full_name',
      NEW.raw_user_meta_data->>'name'
    )
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 3. updated_at trigger for public.users
CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS users_touch_updated_at ON public.users;
CREATE TRIGGER users_touch_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

-- 4. Add nullable user_id to existing session-keyed tables (idempotent;
--    only runs for tables that already exist).
DO $$
BEGIN
  IF to_regclass('public.transcript_events') IS NOT NULL THEN
    ALTER TABLE public.transcript_events
      ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_transcript_events_user_id
      ON public.transcript_events (user_id);
  END IF;

  IF to_regclass('public.conversation_messages') IS NOT NULL THEN
    ALTER TABLE public.conversation_messages
      ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_conversation_messages_user_id
      ON public.conversation_messages (user_id);
  END IF;

  IF to_regclass('public.media_events') IS NOT NULL THEN
    ALTER TABLE public.media_events
      ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_media_events_user_id
      ON public.media_events (user_id);
  END IF;

  IF to_regclass('public.lead_sessions') IS NOT NULL THEN
    ALTER TABLE public.lead_sessions
      ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_lead_sessions_user_id
      ON public.lead_sessions (user_id);
  END IF;

  IF to_regclass('public.contact_entities') IS NOT NULL THEN
    ALTER TABLE public.contact_entities
      ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_contact_entities_user_id
      ON public.contact_entities (user_id);
  END IF;
END
$$;

-- 5. RLS — public.users (each user reads/updates their own profile only)
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users: self-select" ON public.users;
CREATE POLICY "users: self-select"
  ON public.users
  FOR SELECT
  TO authenticated
  USING (auth.uid() = id);

DROP POLICY IF EXISTS "users: self-update" ON public.users;
CREATE POLICY "users: self-update"
  ON public.users
  FOR UPDATE
  TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

-- 6. RLS — session-keyed tables.
--    Service role bypasses RLS (so every existing server route keeps working
--    unchanged). Authenticated users can SELECT only their own rows.
DO $$
BEGIN
  IF to_regclass('public.transcript_events') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.transcript_events ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "transcript_events: owner-select" ON public.transcript_events';
    EXECUTE 'CREATE POLICY "transcript_events: owner-select" ON public.transcript_events
               FOR SELECT TO authenticated USING (user_id = auth.uid())';
  END IF;

  IF to_regclass('public.conversation_messages') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.conversation_messages ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "conversation_messages: owner-select" ON public.conversation_messages';
    EXECUTE 'CREATE POLICY "conversation_messages: owner-select" ON public.conversation_messages
               FOR SELECT TO authenticated USING (user_id = auth.uid())';
  END IF;

  IF to_regclass('public.media_events') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.media_events ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "media_events: owner-select" ON public.media_events';
    EXECUTE 'CREATE POLICY "media_events: owner-select" ON public.media_events
               FOR SELECT TO authenticated USING (user_id = auth.uid())';
  END IF;

  IF to_regclass('public.lead_sessions') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.lead_sessions ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "lead_sessions: owner-select" ON public.lead_sessions';
    EXECUTE 'CREATE POLICY "lead_sessions: owner-select" ON public.lead_sessions
               FOR SELECT TO authenticated USING (user_id = auth.uid())';
  END IF;

  IF to_regclass('public.contact_entities') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.contact_entities ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "contact_entities: owner-select" ON public.contact_entities';
    EXECUTE 'CREATE POLICY "contact_entities: owner-select" ON public.contact_entities
               FOR SELECT TO authenticated USING (user_id = auth.uid())';
  END IF;
END
$$;
