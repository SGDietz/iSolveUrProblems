import { getSupabaseAdminConfig } from "../supabaseAdmin";
import { dedupeInBatch } from "./dedupe";
import { getContractorSource } from "./sources";
import type {
  ContractorSourceAdapter,
  RawContractor,
  RawContractorReview,
} from "./sources/types";

/**
 * Refresh orchestrator — pulls contractors from the active source for a
 * (category, location) pair and upserts them into Supabase. Reviews come
 * along inside `RawContractor.reviews` and get bulk-upserted too.
 *
 * Idempotent: re-running the same call updates `last_seen_at` and any
 * changed fields, never duplicates.
 *
 * Service role only (writes to `contractors` + `contractor_reviews`).
 */

export type RefreshResult = {
  source: string;
  category: string;
  fetched: number;
  upserted_contractors: number;
  upserted_reviews: number;
  errors: string[];
};

const PG_CONFLICT_TARGET = "source,source_id";
const REVIEW_CONFLICT_TARGET = "source,source_review_id";

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

/**
 * Refresh contractors for one (category, near) target. Internally:
 *   1. Ask the active adapter for raw contractors
 *   2. Dedupe within the batch (same business in two categories etc.)
 *   3. Upsert contractors via PostgREST on conflict (source, source_id)
 *   4. Stamp last_seen_at = now() on every returned row
 *   5. Map returned row ids back to their source_ids
 *   6. Upsert reviews bound to those contractor ids
 */
export async function refreshContractors(args: {
  category: string;
  near: { lat: number; lng: number };
  radiusKm: number;
  limit?: number;
}): Promise<RefreshResult> {
  // Fail closed in prod: getContractorSource throws when no real source is
  // configured. Turn that into a clean error result instead of an uncaught 500
  // (G's reality doctrine — never silently seed fake pros).
  let adapter: ContractorSourceAdapter;
  try {
    adapter = getContractorSource();
  } catch (e) {
    return {
      source: process.env.CONTRACTOR_DATA_SOURCE ?? "unset",
      category: args.category,
      fetched: 0,
      upserted_contractors: 0,
      upserted_reviews: 0,
      errors: [
        e instanceof Error ? e.message : "contractor source not configured",
      ],
    };
  }
  const result: RefreshResult = {
    source: adapter.name,
    category: args.category,
    fetched: 0,
    upserted_contractors: 0,
    upserted_reviews: 0,
    errors: [],
  };

  let raw: RawContractor[];
  try {
    raw = await adapter.fetchByCategory({
      category: args.category,
      near: args.near,
      radiusKm: args.radiusKm,
      limit: args.limit,
    });
  } catch (e) {
    result.errors.push(
      `adapter fetch failed: ${e instanceof Error ? e.message : "unknown"}`,
    );
    return result;
  }
  result.fetched = raw.length;
  const deduped = dedupeInBatch(raw);

  if (deduped.length === 0) return result;

  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    result.errors.push("supabase not configured");
    return result;
  }

  const now = new Date().toISOString();

  // Build the contractor upsert payload (strip the embedded reviews;
  // they get inserted in a second pass keyed to the returned ids).
  const contractorRows = deduped.map((c) => ({
    source: adapter.name,
    source_id: c.source_id,
    name: c.name,
    phone: c.phone ?? null,
    website: c.website ?? null,
    email: c.email ?? null,
    address: c.address ?? null,
    city: c.city ?? null,
    state: c.state ?? null,
    zip: c.zip ?? null,
    lat: c.lat ?? null,
    lng: c.lng ?? null,
    categories: c.categories ?? [args.category],
    price_tier: c.price_tier ?? null,
    licensed_flag: c.licensed_flag ?? null,
    same_day_flag: c.same_day_flag ?? null,
    locally_owned: c.locally_owned ?? null,
    rating_avg: c.rating_avg ?? null,
    rating_count: c.rating_count ?? null,
    last_seen_at: now,
    scraped_payload: c.scraped_payload ?? {},
  }));

  try {
    const res = await fetch(
      `${url}/rest/v1/contractors?on_conflict=${PG_CONFLICT_TARGET}`,
      {
        method: "POST",
        headers: {
          ...adminHeaders(serviceRoleKey),
          Prefer: "resolution=merge-duplicates,return=representation",
        },
        body: JSON.stringify(contractorRows),
      },
    );
    if (!res.ok) {
      result.errors.push(`contractors upsert ${res.status}: ${await res.text()}`);
      return result;
    }
    const inserted = (await res.json()) as Array<{
      id: string;
      source: string;
      source_id: string;
    }>;
    result.upserted_contractors = inserted.length;

    // Build a (source, source_id) → uuid map
    const idMap = new Map<string, string>();
    for (const row of inserted) {
      idMap.set(`${row.source}|${row.source_id}`, row.id);
    }

    // Reviews
    const reviewRows: Array<{
      contractor_id: string;
      source: string;
      source_review_id: string;
      rating: number | null;
      body: string | null;
      reviewer_name: string | null;
      reviewed_at: string | null;
      scraped_payload: Record<string, unknown>;
    }> = [];
    for (const c of deduped) {
      const id = idMap.get(`${adapter.name}|${c.source_id}`);
      if (!id || !c.reviews) continue;
      for (const r of c.reviews) {
        reviewRows.push({
          contractor_id: id,
          source: adapter.name,
          source_review_id: r.source_review_id,
          rating: r.rating ?? null,
          body: r.body ?? null,
          reviewer_name: r.reviewer_name ?? null,
          reviewed_at: r.reviewed_at ?? null,
          scraped_payload: r.scraped_payload ?? {},
        });
      }
    }

    if (reviewRows.length > 0) {
      const rRes = await fetch(
        `${url}/rest/v1/contractor_reviews?on_conflict=${REVIEW_CONFLICT_TARGET}`,
        {
          method: "POST",
          headers: {
            ...adminHeaders(serviceRoleKey),
            Prefer: "resolution=merge-duplicates,return=minimal",
          },
          body: JSON.stringify(reviewRows),
        },
      );
      if (!rRes.ok) {
        result.errors.push(`reviews upsert ${rRes.status}: ${await rRes.text()}`);
      } else {
        result.upserted_reviews = reviewRows.length;
      }
    }
  } catch (e) {
    result.errors.push(
      `upsert threw: ${e instanceof Error ? e.message : "unknown"}`,
    );
  }

  return result;
}

// Silence unused-import lint for the type re-export below
export type { RawContractorReview };
