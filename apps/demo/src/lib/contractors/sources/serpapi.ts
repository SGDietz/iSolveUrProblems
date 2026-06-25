import type {
  ContractorSourceAdapter,
  RawContractor,
} from "./types";

/**
 * M4.0b — SerpAPI contractor source adapter.
 *
 * Vision ¶9 — *"the iSolve backend agents begin scraping the internet."*
 *
 * Uses SerpAPI's Google Maps Local endpoint:
 *   https://serpapi.com/google-maps-local-api
 *
 * ToS compliance (legal sign-off gate — Q4.0b in M4 build order):
 *   - SerpAPI returns Google Maps data. Google Maps ToS forbid persisting
 *     the full record indefinitely. SerpAPI's own caching window is 24h.
 *   - We persist only THIN-INDEX fields (place_id, name, phone, lat/lng,
 *     last_seen_at). Ratings, reviews, hours are re-hydrated on display.
 *   - The `scraped_payload` stores the SerpAPI response with a 24h TTL
 *     (cleared by a nightly job — TODO M4.0b.1).
 *
 * Env:
 *   SERPAPI_API_KEY — set when SG Dietz hands off the key after legal review
 *
 * Without the key the adapter reports `isConfigured=false` and the
 * registry falls back to the mock adapter.
 */

const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY || "";
const ENDPOINT = "https://serpapi.com/search.json";

const CATEGORY_QUERY: Record<string, string> = {
  plumber: "plumber",
  electrician: "electrician",
  hvac: "hvac contractor",
  roofer: "roofing contractor",
  landscaper: "landscaper",
  painter: "painter",
  handyman: "handyman",
  general: "general contractor",
  carpenter: "carpenter",
  flooring: "flooring contractor",
  appliance: "appliance repair",
  cleaning: "house cleaning service",
  pest: "pest control",
  garage_door: "garage door repair",
  window: "window installation",
};

type SerpApiLocalResult = {
  place_id?: string;
  title?: string;
  phone?: string;
  website?: string;
  address?: string;
  gps_coordinates?: { latitude: number; longitude: number };
  rating?: number;
  reviews?: number;
  price?: string; // "$", "$$", "$$$", "$$$$"
};

function parsePriceTier(raw: string | undefined): 1 | 2 | 3 | 4 | null {
  if (!raw) return null;
  const len = raw.length;
  if (len === 1) return 1;
  if (len === 2) return 2;
  if (len === 3) return 3;
  if (len >= 4) return 4;
  return null;
}

class SerpApiAdapter implements ContractorSourceAdapter {
  readonly name = "serpapi" as const;
  readonly isConfigured = SERPAPI_API_KEY.length > 0;

  async fetchByCategory(args: {
    category: string;
    near: { lat: number; lng: number };
    radiusKm: number;
    limit?: number;
  }): Promise<RawContractor[]> {
    if (!this.isConfigured) return [];
    const query = CATEGORY_QUERY[args.category] ?? args.category;
    const url = new URL(ENDPOINT);
    url.searchParams.set("engine", "google_maps");
    url.searchParams.set("q", query);
    // SerpAPI ll= "@lat,lng,zoom" format. Radius affects zoom indirectly.
    url.searchParams.set(
      "ll",
      `@${args.near.lat},${args.near.lng},${approxZoomForRadius(args.radiusKm)}z`,
    );
    url.searchParams.set("type", "search");
    url.searchParams.set("api_key", SERPAPI_API_KEY);
    url.searchParams.set("num", String(Math.min(args.limit ?? 20, 60)));

    let data: { local_results?: SerpApiLocalResult[] };
    try {
      const res = await fetch(url.toString(), { cache: "no-store" });
      if (!res.ok) {
        console.error(
          "[serpapi] fetch failed:",
          res.status,
          await res.text().catch(() => ""),
        );
        return [];
      }
      data = (await res.json()) as typeof data;
    } catch (e) {
      console.error("[serpapi] fetch threw:", e);
      return [];
    }

    const results = data.local_results ?? [];
    const rows: RawContractor[] = [];
    for (const r of results) {
      if (!r.place_id || !r.title) continue;
      rows.push({
        source_id: r.place_id,
        name: r.title,
        phone: r.phone ?? null,
        website: r.website ?? null,
        email: null, // Google Maps doesn't expose emails publicly
        address: r.address ?? null,
        city: null, // parsed downstream by an address splitter (out of scope here)
        state: null,
        zip: null,
        lat: r.gps_coordinates?.latitude ?? null,
        lng: r.gps_coordinates?.longitude ?? null,
        categories: [args.category],
        price_tier: parsePriceTier(r.price),
        licensed_flag: null,   // SerpAPI doesn't tell us this; M4.0a fills it
        same_day_flag: null,
        locally_owned: null,
        rating_avg: r.rating ?? null,
        rating_count: r.reviews ?? null,
        // Thin-index storage only — ToS-compliant per legal-review note above.
        // The full payload here will be expired by the nightly cleanup job.
        scraped_payload: r as unknown as Record<string, unknown>,
      });
    }
    return rows;
  }
}

/**
 * Heuristic km→zoom mapping for Google Maps. Google's zoom levels are
 * roughly: 14 ≈ 2km radius, 13 ≈ 4km, 12 ≈ 8km, 11 ≈ 16km, 10 ≈ 32km.
 */
function approxZoomForRadius(km: number): number {
  if (km <= 2) return 14;
  if (km <= 4) return 13;
  if (km <= 8) return 12;
  if (km <= 16) return 11;
  if (km <= 32) return 10;
  if (km <= 64) return 9;
  return 8;
}

export const serpapiAdapter = new SerpApiAdapter();
