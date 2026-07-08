/**
 * M4.0a — License-board contractor data ingestion.
 *
 * Different shape from `ContractorSourceAdapter` (the search-time
 * adapter pattern). License boards are *bulk ETL* sources: we pull a
 * lot of rows once (or refresh weekly), upsert into our contractors
 * table, then M2.1 search reads them normally. Nothing about license
 * boards is "search-time".
 *
 * State-by-state implementations live as siblings to this file:
 *   - cslb.ts          (California — first)
 *   - tdlr.ts          (Texas — future M4.0a.1)
 *   - florida-dbpr.ts  (Florida — future M4.0a.2)
 *   - nys-dos.ts       (New York — future M4.0a.3)
 *
 * Each implements the `LicenseBoardSource` interface below. The admin
 * sync route picks one by state code and calls `fetchBatch`.
 *
 * v1 trust use: every row from a license-board source gets
 * `license_status='active'` (or whatever the board reports) AND
 * `licensed_flag=true`. That powers the "Ai Certified — License
 * Verified" badge in M4.3.
 */

import type { PriceTier } from "../types";

export type LicensedContractor = {
  /** Stable per-state license number — the source-of-truth primary key
   *  for cross-board joins. */
  license_number: string;
  license_issuing_state: string; // 'CA', 'TX', 'FL', 'NY', ...
  license_status: "active" | "expired" | "suspended" | "revoked" | "inactive" | "unknown";
  license_issued_at: string | null;   // ISO date
  license_expires_at: string | null;
  license_classifications: string[];  // ['C-36','B'] per CSLB

  // Identity + contact (whatever the board publishes — often sparse).
  business_name: string;
  doing_business_as: string | null;
  owner_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;

  /** Our 15-category taxonomy (mapped from license_classifications). */
  categories: string[];

  /** Best-effort lat/lng — license boards rarely include them; the
   *  admin sync's geocoder fills these in post-fetch. */
  lat: number | null;
  lng: number | null;

  /** Raw payload as returned by the board — kept for audit. */
  raw_payload: Record<string, unknown>;
};

export interface LicenseBoardSource {
  /** State code this adapter handles (e.g. 'CA'). */
  readonly state: string;

  /** Display name for admin dashboards ("California CSLB"). */
  readonly display_name: string;

  /** Whether env is set up enough to call fetchBatch. */
  readonly isConfigured: boolean;

  /**
   * Pull a batch of licensed contractors.
   *
   * `since` filters to rows updated by the board on or after that date,
   * for incremental refresh. Boards that don't support since-filtering
   * ignore it.
   *
   * `limit` caps the response size — admin sync paginates by calling
   * fetchBatch repeatedly with `cursor` until the board returns empty.
   */
  fetchBatch(args: {
    since?: string | null;
    cursor?: string | null;
    limit?: number;
  }): Promise<{
    rows: LicensedContractor[];
    /** Opaque cursor for the next page; null when exhausted. */
    next_cursor: string | null;
  }>;
}

// ─── State-board → taxonomy mapping ─────────────────────────────────

/**
 * CSLB license classifications → our 15-category taxonomy.
 * Pulled from https://www.cslb.ca.gov/About_Us/Library/Licensing_Classifications/
 *
 * A 'B' (General Building) maps to multiple categories because the
 * license-holder can do any of them. Downstream M2.4 ranking still
 * de-dupes via per-category search constraints.
 */
const CSLB_CLASSIFICATION_MAP: Record<string, string[]> = {
  "A":    ["general"],                    // General Engineering
  "B":    ["general", "carpenter"],       // General Building
  "B-2":  ["general"],                    // Residential Remodeling
  "C-2":  ["window"],                     // Insulation & Acoustical
  "C-4":  ["hvac"],                       // Boiler / Hot-Water Heating
  "C-5":  ["carpenter"],                  // Framing & Rough Carpentry
  "C-6":  ["carpenter"],                  // Cabinet, Millwork
  "C-7":  ["electrician"],                // Low Voltage Systems
  "C-8":  ["general"],                    // Concrete
  "C-9":  ["general"],                    // Drywall
  "C-10": ["electrician"],                // Electrical
  "C-12": ["general"],                    // Earthwork & Paving
  "C-13": ["general"],                    // Fencing
  "C-15": ["flooring"],                   // Flooring
  "C-16": ["general"],                    // Fire Protection
  "C-17": ["window"],                     // Glazing
  "C-20": ["hvac"],                       // HVAC
  "C-21": ["general"],                    // Building Moving / Demolition
  "C-23": ["general"],                    // Ornamental Metal
  "C-27": ["landscaper"],                 // Landscaping
  "C-28": ["handyman", "general"],        // Lock & Security Equipment
  "C-29": ["general"],                    // Masonry
  "C-31": ["general"],                    // Construction Zone Traffic Control
  "C-32": ["pest"],                       // Parking & Highway Improvement
  "C-33": ["painter"],                    // Painting & Decorating
  "C-34": ["general"],                    // Pipeline
  "C-35": ["general"],                    // Lathing & Plastering
  "C-36": ["plumber"],                    // Plumbing
  "C-38": ["hvac"],                       // Refrigeration
  "C-39": ["roofer"],                     // Roofing
  "C-42": ["general"],                    // Sanitation System
  "C-43": ["general"],                    // Sheet Metal
  "C-45": ["general"],                    // Sign
  "C-46": ["general"],                    // Solar
  "C-47": ["general"],                    // General Manufactured Housing
  "C-50": ["general"],                    // Reinforcing Steel
  "C-51": ["general"],                    // Structural Steel
  "C-53": ["general"],                    // Swimming Pool
  "C-54": ["flooring"],                   // Ceramic & Mosaic Tile
  "C-55": ["general"],                    // Water Conditioning
  "C-57": ["plumber"],                    // Well Drilling
  "C-60": ["general"],                    // Welding
  "C-61": ["handyman"],                   // Limited Specialty (catch-all)
  "D-03": ["window"],                     // Awnings (Limited Specialty branch)
  "D-06": ["general"],                    // Concrete Related Services
  "D-09": ["general"],                    // Drilling, Blasting & Oil Field
  "D-12": ["general"],                    // Synthetic Products
  "D-21": ["general"],                    // Machinery & Pumps
  "D-24": ["general"],                    // Metal Products
  "D-28": ["general"],                    // Doors, Gates and Activating Devices
  "D-29": ["general"],                    // Paperhanging
  "D-30": ["general"],                    // Pile Driving and Pressure Foundation Jacking
  "D-34": ["general"],                    // Prefab Equipment
  "D-35": ["pest"],                       // Pool & Spa Maintenance
  "D-38": ["general"],                    // Sandblasting
  "D-39": ["general"],                    // Scaffolding
  "D-40": ["general"],                    // Service Station Equipment
  "D-41": ["general"],                    // Siding & Decking
  "D-42": ["window"],                     // Non-Electrical Sign Installation
  "D-49": ["window"],                     // Tree Service (also landscape — picked safer one)
  "D-50": ["window"],                     // Suspended Ceilings
  "D-52": ["window"],                     // Window Coverings
  "D-53": ["window"],                     // Wood Tanks
  "D-56": ["general"],                    // Trenching Only
  "D-59": ["pest"],                       // Hydroseed Spraying
  "D-62": ["general"],                    // Air & Water Balancing
  "D-63": ["general"],                    // Construction Cleanup
  "D-64": ["general"],                    // Non-Specialized
  "D-65": ["general"],                    // Weatherization & Energy Conservation
};

/**
 * Map a list of board-issued classifications to our 15-category
 * taxonomy. De-duplicates and falls back to ['general'] if nothing matches.
 */
export function mapCslbClassificationsToCategories(
  classifications: string[],
): string[] {
  const set = new Set<string>();
  for (const c of classifications) {
    const mapped = CSLB_CLASSIFICATION_MAP[c.toUpperCase()];
    if (mapped) for (const m of mapped) set.add(m);
  }
  if (set.size === 0) set.add("general");
  return Array.from(set);
}

// ─── Helpers used by every state board impl ────────────────────────

export function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D+/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function toLicensedContractor(args: {
  state: string;
  license_number: string;
  raw: Record<string, unknown>;
  business_name: string;
  status: LicensedContractor["license_status"];
  classifications: string[];
  issued_at?: string | null;
  expires_at?: string | null;
  doing_business_as?: string | null;
  owner_name?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  zip?: string | null;
  lat?: number | null;
  lng?: number | null;
}): LicensedContractor {
  return {
    license_number: args.license_number,
    license_issuing_state: args.state,
    license_status: args.status,
    license_issued_at: args.issued_at ?? null,
    license_expires_at: args.expires_at ?? null,
    license_classifications: args.classifications,
    categories: mapCslbClassificationsToCategories(args.classifications),
    business_name: args.business_name,
    doing_business_as: args.doing_business_as ?? null,
    owner_name: args.owner_name ?? null,
    phone: normalizePhone(args.phone ?? null),
    email: args.email ?? null,
    address: args.address ?? null,
    city: args.city ?? null,
    state: args.state,
    zip: args.zip ?? null,
    lat: args.lat ?? null,
    lng: args.lng ?? null,
    raw_payload: args.raw,
  };
}

/**
 * Convert a LicensedContractor to the fields we upsert into the
 * `contractors` table. Source is set to `license_board:<STATE>` so the
 * orchestrator can tell where the row came from.
 */
export function toContractorRow(c: LicensedContractor): {
  source: string;
  source_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  categories: string[];
  price_tier: PriceTier | null;
  licensed_flag: boolean;
  same_day_flag: null;
  locally_owned: null;
  rating_avg: null;
  rating_count: null;
  license_number: string;
  license_issuing_state: string;
  license_status: string;
  license_issued_at: string | null;
  license_expires_at: string | null;
  license_classifications: string[];
  license_verified_at: string;
  scraped_payload: Record<string, unknown>;
} {
  return {
    source: `license_board:${c.license_issuing_state}`,
    source_id: c.license_number,
    name: c.doing_business_as ?? c.business_name,
    phone: c.phone,
    email: c.email,
    address: c.address,
    city: c.city,
    state: c.state,
    zip: c.zip,
    lat: c.lat,
    lng: c.lng,
    categories: c.categories,
    price_tier: null,
    licensed_flag: c.license_status === "active",
    same_day_flag: null,
    locally_owned: null,
    rating_avg: null,
    rating_count: null,
    license_number: c.license_number,
    license_issuing_state: c.license_issuing_state,
    license_status: c.license_status,
    license_issued_at: c.license_issued_at,
    license_expires_at: c.license_expires_at,
    license_classifications: c.license_classifications,
    license_verified_at: new Date().toISOString(),
    scraped_payload: c.raw_payload,
  };
}
