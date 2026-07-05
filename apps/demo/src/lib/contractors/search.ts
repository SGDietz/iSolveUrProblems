import { getSupabaseAdminConfig } from "../supabaseAdmin";
import type { ContractorRow } from "./types";

/**
 * Preference-tuned contractor search (M2.2 — Vision ¶10).
 *
 * Strategy for v1: bounding-box prefilter via PostgREST (cheap index
 * lookup), then Haversine distance + composite score in JS over the
 * prefiltered set. Works comfortably up to a few thousand contractors
 * per category-region. When we grow, swap to a Postgres RPC.
 *
 * Hard filters (applied in SQL): category, bbox, min_rating, price tier,
 * locally_owned, same_day. Soft signal: distance is folded into score
 * but never excluded beyond the requested radius.
 */

const EARTH_RADIUS_KM = 6371;
const LAT_DEG_KM = 111.32; // approx km per degree latitude
const PG_PREFETCH_HARD_CAP = 500; // protect against pathological queries

export type ContractorSearchInput = {
  category: string;
  near: { lat: number; lng: number };
  /** Hard radius — contractors beyond this are excluded. */
  radius_km?: number;
  /** Floor on rating_avg, e.g. 4.5 (vision ¶10). */
  min_rating?: number;
  /** Ceiling on price_tier 1..4. */
  max_price_tier?: 1 | 2 | 3 | 4;
  /** Hard-filter to locally-owned only. */
  locally_owned?: boolean;
  /** Hard-filter to same-day-capable only. */
  same_day?: boolean;
  /** Restrict to these source values (real-source allow-list). */
  sources?: string[];
  /** Exclude these source values (e.g. mock/seed). */
  exclude_sources?: string[];
  /** Optional cap on returned rows (default 20). */
  limit?: number;
};

export type ContractorSearchHit = ContractorRow & {
  distance_km: number;
  score: number;
};

export type ContractorSearchResult = {
  hits: ContractorSearchHit[];
  total_considered: number;
  filters_applied: ContractorSearchInput;
  error?: string;
};

function deg2rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = deg2rad(b.lat - a.lat);
  const dLng = deg2rad(b.lng - a.lng);
  const lat1 = deg2rad(a.lat);
  const lat2 = deg2rad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Composite score on [0,1]. Higher = better. Distance and rating are
 * the main signals; price/locality/same-day are already hard-filtered
 * so they don't get extra weight here. When M2.3 ships review-sentiment
 * we'll fold it in.
 */
function scoreHit(args: {
  distance_km: number;
  rating_avg: number | null;
  rating_count: number | null;
  radius_km: number;
}): number {
  const { distance_km, rating_avg, rating_count, radius_km } = args;
  const distanceScore = Math.max(0, 1 - distance_km / Math.max(radius_km, 1));
  const ratingScore =
    typeof rating_avg === "number"
      ? Math.max(0, Math.min(1, (rating_avg - 1) / 4))
      : 0;
  // Confidence damps low-review-count contractors a touch.
  const confidence =
    typeof rating_count === "number"
      ? Math.min(1, rating_count / 25)
      : 0;
  return 0.55 * ratingScore * (0.5 + 0.5 * confidence) + 0.45 * distanceScore;
}

function buildBbox(
  center: { lat: number; lng: number },
  radius_km: number,
): { latMin: number; latMax: number; lngMin: number; lngMax: number } {
  const dLat = radius_km / LAT_DEG_KM;
  const cosLat = Math.cos(deg2rad(center.lat)) || 1e-6;
  const dLng = radius_km / (LAT_DEG_KM * cosLat);
  return {
    latMin: center.lat - dLat,
    latMax: center.lat + dLat,
    lngMin: center.lng - dLng,
    lngMax: center.lng + dLng,
  };
}

export async function searchContractors(
  input: ContractorSearchInput,
): Promise<ContractorSearchResult> {
  const radius_km = input.radius_km ?? 25;
  const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);

  const filters: ContractorSearchInput = {
    ...input,
    radius_km,
    limit,
  };

  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return {
      hits: [],
      total_considered: 0,
      filters_applied: filters,
      error: "supabase not configured",
    };
  }

  // Core query + score for a given radius. Pulled out so we can sweep the
  // radius outward when the asked circle comes back empty (see below).
  const runAtRadius = async (
    r: number,
  ): Promise<{
    hits: ContractorSearchHit[];
    considered: number;
    error?: string;
  }> => {
    const bbox = buildBbox(input.near, r);
    const qs = new URLSearchParams();
    qs.set("select", "*");
    // Category match — PostgREST `cs` (contains) operator on text[].
    qs.append("categories", `cs.{${input.category}}`);
    qs.append("lat", `gte.${bbox.latMin}`);
    qs.append("lat", `lte.${bbox.latMax}`);
    qs.append("lng", `gte.${bbox.lngMin}`);
    qs.append("lng", `lte.${bbox.lngMax}`);
    if (typeof input.min_rating === "number") {
      qs.append("rating_avg", `gte.${input.min_rating}`);
    }
    if (typeof input.max_price_tier === "number") {
      qs.append("price_tier", `lte.${input.max_price_tier}`);
    }
    if (input.locally_owned === true) {
      qs.append("locally_owned", "is.true");
    }
    if (input.same_day === true) {
      qs.append("same_day_flag", "is.true");
    }
    // Source gating. Allow-list wins when set; mock/seed are excluded
    // UNCONDITIONALLY — every environment, no escape hatch (G 2026-07-02:
    // real data only, forever; the mock rows + adapter are gone, this filter
    // is the belt-and-suspenders if any fake row ever sneaks back in).
    // PostgREST AND's repeated column filters.
    if (input.sources?.length) {
      qs.append("source", `in.(${input.sources.join(",")})`);
    }
    const excluded = new Set(input.exclude_sources ?? []);
    excluded.add("mock");
    excluded.add("seed");
    qs.append("source", `not.in.(${[...excluded].join(",")})`);
    // Fetch a generous slice; we score + cap in JS.
    qs.append("limit", String(PG_PREFETCH_HARD_CAP));
    qs.append("order", "rating_avg.desc.nullslast");

    let rows: ContractorRow[];
    try {
      const res = await fetch(`${url}/rest/v1/contractors?${qs.toString()}`, {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        // Search is read-only and idempotent — let edge cache it briefly.
        cache: "no-store",
      });
      if (!res.ok) {
        return {
          hits: [],
          considered: 0,
          error: `supabase ${res.status}: ${await res.text()}`,
        };
      }
      rows = (await res.json()) as ContractorRow[];
    } catch (e) {
      return {
        hits: [],
        considered: 0,
        error: `fetch failed: ${e instanceof Error ? e.message : "unknown"}`,
      };
    }

    // Score every row by precise Haversine distance and composite score,
    // drop ones outside the true circular radius (bbox is square), sort.
    const scored: ContractorSearchHit[] = [];
    for (const row of rows) {
      if (row.lat == null || row.lng == null) continue;
      const distance_km = haversineKm(input.near, {
        lat: row.lat,
        lng: row.lng,
      });
      if (distance_km > r) continue;
      const score = scoreHit({
        distance_km,
        rating_avg: row.rating_avg,
        rating_count: row.rating_count,
        radius_km: r,
      });
      scored.push({ ...row, distance_km, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return { hits: scored, considered: rows.length };
  };

  // NATIONAL fallback REMOVED for release (Herm ship-blocker 2026-07-02): the
  // silent sweep out to 5000 km let far-away DB pros ride into results and
  // recommendations without a "not local" label, and its non-empty result
  // suppressed the live Outscraper fallback (which only runs when the DB
  // comes back empty). Empty at the asked radius now returns empty — callers
  // fall through to the live find or speak the honest no-results copy. If a
  // labeled wide search ever comes back, it must be explicit and say so.
  const run = await runAtRadius(radius_km);

  return {
    hits: run.hits.slice(0, limit),
    total_considered: run.considered,
    filters_applied: filters,
    error: run.error,
  };
}
