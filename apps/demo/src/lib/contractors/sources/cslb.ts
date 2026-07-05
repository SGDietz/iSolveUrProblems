import type {
  LicenseBoardSource,
  LicensedContractor,
} from "./licenseBoard";
import { toLicensedContractor } from "./licenseBoard";

/**
 * M4.0a — California Contractors State License Board (CSLB) adapter.
 *
 * Vision ¶9 — "the iSolve backend agents begin scraping the internet"
 *
 * The CSLB publishes a downloadable monthly bulk file at
 *   https://www.cslb.ca.gov/About_Us/Library/Licensing_Information_List.aspx
 *
 * That file isn't queryable via a public REST API. Real-world ingestion
 * runs as an out-of-band ETL (cron or worker) that downloads + parses
 * the CSV into NDJSON, then exposes it at a static URL we own.
 *
 * This adapter reads from that NDJSON URL via env. If the env isn't
 * set, the adapter reports `isConfigured=false` and the admin sync
 * route returns a 503 cleanly.
 *
 * Env:
 *   CSLB_DATA_URL — https URL pointing at NDJSON-formatted CSLB data
 *
 * NDJSON row shape (one row per license — exactly the columns we read):
 *   {
 *     "LicenseNo": "1234567",
 *     "BusinessName": "ACME PLUMBING",
 *     "DoingBusinessAs": "Acme Plumbing",
 *     "BusinessPhone": "(555) 123-4567",
 *     "MailingAddress": "123 Main St",
 *     "City": "Los Angeles",
 *     "Zip": "90001",
 *     "Classifications": ["C-36","B"],
 *     "LicenseStatus": "Active",         // CSLB enum
 *     "IssueDate": "2010-04-15",
 *     "ExpirationDate": "2026-04-30",
 *     "BusinessType": "Sole Owner",
 *     "Owner": "Jane Doe"
 *   }
 *
 * Adding TX/FL/NY is a sibling file that implements the same interface
 * against their respective data source.
 */

const CSLB_DATA_URL = process.env.CSLB_DATA_URL || "";

function mapStatus(raw: string | null): LicensedContractor["license_status"] {
  if (!raw) return "unknown";
  const s = raw.toLowerCase().trim();
  if (s === "active" || s === "current") return "active";
  if (s === "expired") return "expired";
  if (s === "suspended") return "suspended";
  if (s === "revoked") return "revoked";
  if (s === "inactive" || s === "cancelled" || s === "canceled") return "inactive";
  return "unknown";
}

function safeIsoDate(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  const d = new Date(raw);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

type CslbRawRow = {
  LicenseNo?: string;
  BusinessName?: string;
  DoingBusinessAs?: string | null;
  BusinessPhone?: string | null;
  Email?: string | null;
  MailingAddress?: string | null;
  City?: string | null;
  Zip?: string | null;
  Classifications?: string[];
  LicenseStatus?: string;
  IssueDate?: string;
  ExpirationDate?: string;
  Owner?: string | null;
};

function parseCslbRow(raw: CslbRawRow): LicensedContractor | null {
  if (!raw.LicenseNo || !raw.BusinessName) return null;
  return toLicensedContractor({
    state: "CA",
    license_number: raw.LicenseNo.trim(),
    raw: raw as unknown as Record<string, unknown>,
    business_name: raw.BusinessName.trim(),
    doing_business_as: raw.DoingBusinessAs?.trim() ?? null,
    owner_name: raw.Owner?.trim() ?? null,
    phone: raw.BusinessPhone ?? null,
    email: raw.Email ?? null,
    address: raw.MailingAddress ?? null,
    city: raw.City ?? null,
    zip: raw.Zip ?? null,
    classifications: Array.isArray(raw.Classifications)
      ? raw.Classifications.filter((c) => typeof c === "string")
      : [],
    status: mapStatus(raw.LicenseStatus ?? null),
    issued_at: safeIsoDate(raw.IssueDate),
    expires_at: safeIsoDate(raw.ExpirationDate),
  });
}

/**
 * Fetch the CSLB NDJSON file from CSLB_DATA_URL and yield rows
 * cursored by simple line offset. The cursor is the line index of the
 * NEXT row to return (so cursor=0 starts at the top).
 *
 * Streams the whole file to memory then slices — fine for v1 because
 * the CSLB list is ~290k rows totaling <100MB. If we move to a 1M-row
 * source we'd switch to a true streaming parser.
 */
async function fetchCslbBatchInternal(args: {
  cursor: number;
  limit: number;
}): Promise<{ rows: LicensedContractor[]; nextOffset: number | null }> {
  if (!CSLB_DATA_URL) {
    return { rows: [], nextOffset: null };
  }
  let raw: string;
  try {
    const res = await fetch(CSLB_DATA_URL, { cache: "no-store" });
    if (!res.ok) {
      console.error(
        "[cslb] fetch failed:",
        res.status,
        await res.text().catch(() => ""),
      );
      return { rows: [], nextOffset: null };
    }
    raw = await res.text();
  } catch (e) {
    console.error("[cslb] fetch threw:", e);
    return { rows: [], nextOffset: null };
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const slice = lines.slice(args.cursor, args.cursor + args.limit);
  const rows: LicensedContractor[] = [];
  for (const line of slice) {
    try {
      const parsed = parseCslbRow(JSON.parse(line) as CslbRawRow);
      if (parsed) rows.push(parsed);
    } catch {
      // Skip malformed line; CSLB bulk files occasionally have garbage.
    }
  }
  const nextOffset =
    args.cursor + slice.length < lines.length
      ? args.cursor + slice.length
      : null;
  return { rows, nextOffset };
}

class CslbSource implements LicenseBoardSource {
  readonly state = "CA";
  readonly display_name = "California CSLB";
  readonly isConfigured = CSLB_DATA_URL.length > 0;

  async fetchBatch(args: {
    since?: string | null; // unused — CSLB bulk file has no since-filter
    cursor?: string | null;
    limit?: number;
  }): Promise<{ rows: LicensedContractor[]; next_cursor: string | null }> {
    const offset = args.cursor ? parseInt(args.cursor, 10) : 0;
    const limit = Math.min(Math.max(args.limit ?? 500, 1), 5000);
    const result = await fetchCslbBatchInternal({ cursor: offset, limit });
    return {
      rows: result.rows,
      next_cursor: result.nextOffset != null ? String(result.nextOffset) : null,
    };
  }
}

export const cslbSource = new CslbSource();

// ─── State-board registry ──────────────────────────────────────────

const LICENSE_BOARD_REGISTRY: Record<string, LicenseBoardSource> = {
  CA: cslbSource,
};

export function getLicenseBoardSource(
  stateCode: string,
): LicenseBoardSource | null {
  return LICENSE_BOARD_REGISTRY[stateCode.toUpperCase()] ?? null;
}
