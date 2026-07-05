import { haversineKm, type ContractorSearchHit } from "./search";
import type { ContractorRow } from "./types";
import { getSupabaseAdminConfig } from "../supabaseAdmin";

/**
 * Live contractor find via Outscraper (real Google Maps businesses) — the REAL
 * supply engine (G 2026-06-30: no mock data, ever). Returns hits in the same
 * shape as the DB searchContractors so the existing card mapping is unchanged.
 *
 * Proven working 2026-06-30: "plumber near Austin, TX" → real pros with phones.
 * Key lives in env OUTSCRAPER_API_KEY. Pay-as-you-go, first 500/mo free.
 */

const OUTSCRAPER_MAPS_SEARCH = "https://api.app.outscraper.com/maps/search-v3";

const LIVE_SEARCH_TERMS: Record<string, string> = {
  hvac: "air conditioning contractor",
  plumber: "plumber",
  electrician: "electrician",
  roofer: "roofing contractor",
  landscaper: "landscaping company",
  painter: "painting contractor",
  handyman: "handyman",
  carpenter: "carpenter",
  flooring: "flooring contractor",
  appliance: "appliance repair service",
  cleaner: "cleaning service",
  pest: "pest control service",
  garage_door: "garage door repair service",
  window: "window repair service",
  general: "general contractor",
};

export function liveContractorSearchTerm(category: string): string {
  const normalized = category.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return LIVE_SEARCH_TERMS[normalized] ?? category.trim();
}

type RawBusiness = {
  place_id?: string;
  google_id?: string;
  name?: string;
  phone?: string;
  site?: string;
  website?: string;
  full_address?: string;
  address?: string;
  city?: string;
  us_state?: string;
  state?: string;
  postal_code?: string;
  latitude?: number;
  longitude?: number;
  rating?: number;
  reviews?: number;
};

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

/**
 * Persist every real scrape into the `contractors` table — a PERMANENT,
 * sacred asset that compounds with every search and is NEVER deleted
 * (G 2026-07-01). Idempotent upsert on (source, source_id): re-scraping the
 * same pro updates last_seen_at, never duplicates. Scraped rows carry no
 * claimed_by_user_id, so account/test-account deletion can't touch them.
 * Best-effort — a failed save just means the pro gets saved next search.
 *
 * Returns the source_id → contractors.id (UUID) mapping from the upsert so
 * the CARDS can carry real DB UUIDs (Herm release blocker #1: place_id card
 * ids broke follow-up summary/details/appointment resolution, which looks
 * contractors up by UUID). Empty map on any failure — callers fall back to
 * source_id ids, which fetchSnapshotContractorMeta can still resolve.
 */
async function persistScrapedContractors(
  hits: ContractorSearchHit[],
): Promise<Map<string, string>> {
  const idMap = new Map<string, string>();
  if (hits.length === 0) return idMap;
  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return idMap; // no DB configured (local dev) — nothing to persist to
  }
  const rows = hits.map((h) => ({
    source: h.source,
    source_id: h.source_id,
    name: h.name,
    phone: h.phone,
    website: h.website,
    email: h.email,
    address: h.address,
    city: h.city,
    state: h.state,
    zip: h.zip,
    lat: h.lat,
    lng: h.lng,
    categories: h.categories,
    price_tier: h.price_tier,
    licensed_flag: h.licensed_flag,
    same_day_flag: h.same_day_flag,
    locally_owned: h.locally_owned,
    rating_avg: h.rating_avg,
    rating_count: h.rating_count,
    last_seen_at: h.last_seen_at,
    scraped_payload: h.scraped_payload,
  }));
  try {
    const res = await fetch(
      `${url}/rest/v1/contractors?on_conflict=source,source_id&select=id,source_id`,
      {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(rows),
      },
    );
    // A 4xx/5xx (bad body shape, missing column, missing unique constraint)
    // must NOT be silently treated as a successful save (Herm TASK_065 #4).
    if (!res.ok) {
      throw new Error(`contractors persistence ${res.status}`);
    }
    const saved = (await res.json()) as Array<{
      id?: string;
      source_id?: string;
    }>;
    for (const s of saved) {
      if (typeof s.id === "string" && typeof s.source_id === "string") {
        idMap.set(s.source_id, s.id);
      }
    }
  } catch (e) {
    // best-effort — never block/fail the user's turn, but log so we notice if
    // the permanent contractors DB stops accepting scrapes.
    console.warn(
      "persistScrapedContractors failed:",
      e instanceof Error ? e.message : "unknown",
    );
  }
  return idMap;
}

export async function findContractorsLive(input: {
  category: string;
  locationText?: string | null;
  /** Resolved user coords, when we recognized their city — lets us compute a
   *  real distance to each pro. Absent = we honestly show no distance (never
   *  a fake 0.0 km). */
  near?: { lat: number; lng: number } | null;
  limit?: number;
}): Promise<{ hits: ContractorSearchHit[]; error?: string }> {
  const key = process.env.OUTSCRAPER_API_KEY;
  if (!key) return { hits: [], error: "OUTSCRAPER_API_KEY not set" };

  const where = (input.locationText ?? "").trim();
  // Outscraper needs a place in the query for local results.
  if (!where) return { hits: [], error: "no location for live find" };

  const queryTerm = liveContractorSearchTerm(input.category);
  const query = `${queryTerm} near ${where}`;
  // Outscraper is the PRIMARY supply (DB is a near-empty compounding cache,
  // G 2026-07-03). Default 8, not 3, so any caller that omits a limit still
  // pulls enough REAL local pros to fill the cards; hard-capped at 20.
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 20);
  const url = `${OUTSCRAPER_MAPS_SEARCH}?query=${encodeURIComponent(query)}&limit=${limit}&async=false`;

  let json: { status?: string; data?: unknown };
  // Never let a hung directory call freeze 6's turn (Herm audit 2026-06-30).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: { "X-API-KEY": key },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) {
      return { hits: [], error: `outscraper ${res.status}` };
    }
    json = (await res.json()) as { status?: string; data?: unknown };
  } catch (e) {
    return {
      hits: [],
      error: `outscraper fetch failed: ${e instanceof Error ? e.message : "unknown"}`,
    };
  } finally {
    clearTimeout(timer);
  }

  // Response shape: { status, data: [ [ business, business, … ] ] } — the
  // businesses for a single query are nested one level in data[0].
  const d = json.data;
  let businesses: RawBusiness[] = [];
  if (Array.isArray(d)) {
    businesses = (Array.isArray(d[0]) ? d[0] : d) as RawBusiness[];
  }

  const now = new Date().toISOString();
  const hits: ContractorSearchHit[] = businesses
    .filter((b) => b && b.name)
    .slice(0, limit)
    .map((b, i) => {
      const rating = num(b.rating);
      const reviews = num(b.reviews);
      const row: ContractorRow = {
        id: b.place_id || b.google_id || `outscraper_${i}`,
        source: "outscraper_live",
        source_id: b.place_id || b.google_id || `outscraper_${i}`,
        name: b.name as string,
        phone: b.phone ?? null,
        website: b.site ?? b.website ?? null,
        email: null,
        address: b.full_address ?? b.address ?? null,
        city: b.city ?? null,
        state: b.us_state ?? b.state ?? null,
        zip: b.postal_code ?? null,
        lat: num(b.latitude),
        lng: num(b.longitude),
        categories: [input.category],
        price_tier: null,
        licensed_flag: null,
        same_day_flag: null,
        locally_owned: null,
        rating_avg: rating,
        rating_count: reviews,
        last_seen_at: now,
        scraped_payload: { source: "outscraper_live", query, fetched_at: now },
        created_at: now,
        updated_at: now,
      };
      // Real distance when we know the user's coords AND the business has
      // coords; otherwise 0 = "unknown", and the UI/voice HIDE it (never
      // print a fake 0.0 km). G's reality doctrine, Herm audit 2026-06-30.
      const distance_km =
        input.near && row.lat != null && row.lng != null
          ? Math.round(
              haversineKm(input.near, { lat: row.lat, lng: row.lng }) * 10,
            ) / 10
          : 0;
      // Rating-driven score (distance is a soft signal we can't always know).
      const score = rating != null ? Math.max(0, Math.min(1, (rating - 1) / 4)) : 0.5;
      return { ...row, distance_km, score };
    });

  // Save every scrape to the permanent contractors DB (bounded so a slow
  // write can't hang 6's turn; the pros still show regardless) and REHYDRATE
  // the cards with the real DB UUIDs the upsert returned (Herm release
  // blocker #1) — follow-ups (summary/details/appointments) resolve
  // contractors by UUID. On timeout/failure the ids stay source_id, which
  // the snapshot meta lookup can still resolve by source_id.
  const idMap = await Promise.race([
    persistScrapedContractors(hits),
    new Promise<Map<string, string>>((resolve) =>
      setTimeout(() => resolve(new Map()), 2500),
    ),
  ]);
  if (idMap.size > 0) {
    for (const h of hits) {
      const dbId = idMap.get(h.source_id);
      if (dbId) h.id = dbId;
    }
  }

  return { hits };
}
