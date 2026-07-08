-- M2.1 — Contractor marketplace foundation.
--
-- Vision ¶9: "the iSolve backend agents begin scraping the internet"
-- + ¶10/¶11 inform the searchable fields (price, locality, rating).
--
-- Three tables:
--   * contractors — one row per contractor, unique by (source, source_id)
--   * contractor_reviews — review records pulled per contractor
--   * contractor_categories — slug → display-name lookup
--
-- RLS: locked to service role. The search/recommendation routes read
-- via service role; nothing is exposed to the browser directly. Future
-- public read can be added when we ship a /contractors directory page.

-- 1. Contractors
CREATE TABLE IF NOT EXISTS contractors (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- provenance
  source            text NOT NULL,         -- 'mock', 'serpapi', 'yelp', ...
  source_id         text NOT NULL,
  -- identity + contact
  name              text NOT NULL,
  phone             text,
  website           text,
  email             text,
  -- location
  address           text,
  city              text,
  state             text,
  zip               text,
  lat               double precision,
  lng               double precision,
  -- offerings
  categories        text[] NOT NULL DEFAULT '{}',   -- e.g. ['plumber','hvac']
  price_tier        int CHECK (price_tier BETWEEN 1 AND 4),  -- Google-style $..$$$$
  -- preference signals (Vision ¶10)
  licensed_flag     boolean,
  same_day_flag     boolean,
  locally_owned     boolean,
  -- ratings
  rating_avg        double precision,
  rating_count      int,
  -- meta
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  scraped_payload   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source, source_id)
);

CREATE INDEX IF NOT EXISTS idx_contractors_categories
  ON contractors USING GIN (categories);
CREATE INDEX IF NOT EXISTS idx_contractors_city
  ON contractors (city);
CREATE INDEX IF NOT EXISTS idx_contractors_state_city
  ON contractors (state, city);
CREATE INDEX IF NOT EXISTS idx_contractors_rating
  ON contractors (rating_avg DESC NULLS LAST);
-- Geo: bucket by integer lat/lng for cheap pre-filter before Haversine
CREATE INDEX IF NOT EXISTS idx_contractors_lat_lng
  ON contractors (lat, lng);

DROP TRIGGER IF EXISTS contractors_touch_updated_at ON contractors;
CREATE TRIGGER contractors_touch_updated_at
  BEFORE UPDATE ON contractors
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE contractors ENABLE ROW LEVEL SECURITY;
-- No policies — service role only for v1.

-- 2. Reviews
CREATE TABLE IF NOT EXISTS contractor_reviews (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contractor_id     uuid NOT NULL REFERENCES contractors(id) ON DELETE CASCADE,
  source            text NOT NULL,
  source_review_id  text NOT NULL,
  rating            double precision,
  body              text,
  reviewer_name     text,
  reviewed_at       timestamptz,
  scraped_payload   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source, source_review_id)
);

CREATE INDEX IF NOT EXISTS idx_contractor_reviews_contractor_id
  ON contractor_reviews (contractor_id);
CREATE INDEX IF NOT EXISTS idx_contractor_reviews_reviewed_at
  ON contractor_reviews (reviewed_at DESC NULLS LAST);

ALTER TABLE contractor_reviews ENABLE ROW LEVEL SECURITY;
-- No policies — service role only.

-- 3. Categories lookup
CREATE TABLE IF NOT EXISTS contractor_categories (
  slug          text PRIMARY KEY,
  display_name  text NOT NULL,
  description   text
);

INSERT INTO contractor_categories (slug, display_name) VALUES
  ('plumber',        'Plumber'),
  ('electrician',    'Electrician'),
  ('hvac',           'HVAC / Air Conditioning'),
  ('roofer',         'Roofer'),
  ('landscaper',     'Landscaper / Lawn Care'),
  ('painter',        'Painter'),
  ('handyman',       'Handyman'),
  ('general',        'General Contractor'),
  ('carpenter',      'Carpenter'),
  ('flooring',       'Flooring Installer'),
  ('appliance',      'Appliance Repair'),
  ('cleaning',       'House Cleaning'),
  ('pest',           'Pest Control'),
  ('garage_door',    'Garage Door Service'),
  ('window',         'Window / Siding')
ON CONFLICT (slug) DO NOTHING;

ALTER TABLE contractor_categories ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "contractor_categories: public read" ON contractor_categories;
CREATE POLICY "contractor_categories: public read"
  ON contractor_categories
  FOR SELECT
  TO authenticated, anon
  USING (true);
