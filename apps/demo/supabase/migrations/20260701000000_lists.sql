-- 2026-07-01 — 6-led lists (G voice directive on the iPad smoke + "bring in
-- the aiASAP list work"). Ported from aiASAP's list system (user_metadata
-- assistant_lists) onto real tables: multiple named lists per user, spoken
-- index/pick, positional remove, clear-all — for homeowners (house list:
-- "stuff my house needs", each item can become a job) AND contractors
-- (per-job punch lists, supply runs), riding one rail.
--
-- Two tables: lists (the named containers) + list_items (the things on them).
-- A list optionally links to the contractors row its owner has claimed.
-- Items can link to a media_events row (the photo/video of the problem).
--
-- RLS mirrors appointments: owner reads/writes their own; service role
-- bypasses for the voice orchestrator.

CREATE TABLE IF NOT EXISTS lists (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contractor_id uuid REFERENCES contractors(id) ON DELETE SET NULL,
  title         text NOT NULL,
  kind          text NOT NULL DEFAULT 'todo'
    CHECK (kind IN ('todo', 'house', 'job', 'shopping', 'custom')),
  status        text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'archived')),
  context       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_lists_user_status
  ON lists (user_id, status, created_at);

CREATE TABLE IF NOT EXISTS list_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  list_id        uuid NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The item in the user's words: "wax ring", "call the Hendersons back".
  title          text NOT NULL,
  details        text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'done', 'dropped')),
  -- Spoken order — ordinals ("take off number two") resolve against this.
  position       int NOT NULL DEFAULT 0,
  due_at         timestamptz,
  done_at        timestamptz,
  -- The photo/video of the problem this item tracks (homeowner house-list
  -- items carry their capture into the pro's punch list on hire).
  media_event_id uuid REFERENCES media_events(id) ON DELETE SET NULL,
  context        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- "what's on my list" — open items in spoken order.
CREATE INDEX IF NOT EXISTS idx_list_items_list_status_position
  ON list_items (list_id, status, position);

DROP TRIGGER IF EXISTS lists_touch_updated_at ON lists;
CREATE TRIGGER lists_touch_updated_at
  BEFORE UPDATE ON lists
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

DROP TRIGGER IF EXISTS list_items_touch_updated_at ON list_items;
CREATE TRIGGER list_items_touch_updated_at
  BEFORE UPDATE ON list_items
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE list_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "lists: owner read" ON lists;
CREATE POLICY "lists: owner read"
  ON lists FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "lists: owner write" ON lists;
CREATE POLICY "lists: owner write"
  ON lists FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "lists: owner update" ON lists;
CREATE POLICY "lists: owner update"
  ON lists FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "list_items: owner read" ON list_items;
CREATE POLICY "list_items: owner read"
  ON list_items FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS "list_items: owner write" ON list_items;
CREATE POLICY "list_items: owner write"
  ON list_items FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "list_items: owner update" ON list_items;
CREATE POLICY "list_items: owner update"
  ON list_items FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- DELETE is intentionally not policy'd on either table — items leave via
-- status -> 'done'/'dropped', lists via 'archived'. Nothing a user said is
-- ever lost.
