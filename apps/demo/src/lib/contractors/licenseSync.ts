import { getSupabaseAdminConfig } from "../supabaseAdmin";
import { getLicenseBoardSource } from "./sources/cslb";
import { toContractorRow, type LicensedContractor } from "./sources/licenseBoard";

/**
 * M4.0a — License-board contractor sync orchestrator.
 *
 * Given a state code, paginates through that state's license-board
 * source and upserts every row into the `contractors` table keyed by
 * (source, source_id) where source = `license_board:<STATE>` and
 * source_id = license number.
 *
 * Dedupe behavior:
 *   - Rows already present (matching unique key) are UPDATED with the
 *     latest license metadata (status, expiry, classifications)
 *   - Rows in `contractors` from OTHER sources (e.g. SerpAPI) with the
 *     same `phone` value are linked but not merged in v1 — the
 *     contractor will appear in search results from both sources. v1.1
 *     adds a unifying step.
 */

export type LicenseSyncProgress = {
  state: string;
  source_display_name: string;
  fetched: number;
  upserted: number;
  skipped: number;
  next_cursor: string | null;
  duration_ms: number;
};

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

async function upsertContractorsBatch(
  rows: LicensedContractor[],
): Promise<{ upserted: number; skipped: number }> {
  if (rows.length === 0) return { upserted: 0, skipped: 0 };
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const payload = rows.map(toContractorRow);
  const res = await fetch(
    `${url}/rest/v1/contractors?on_conflict=source,source_id`,
    {
      method: "POST",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    console.error(
      "[license-sync] upsert failed:",
      res.status,
      await res.text().catch(() => ""),
    );
    return { upserted: 0, skipped: rows.length };
  }
  return { upserted: rows.length, skipped: 0 };
}

/**
 * Run one batch of license-board sync. Returns a continuation cursor
 * for the next call. Caller is responsible for re-invoking until
 * `next_cursor` is null.
 */
export async function syncLicenseBoardBatch(args: {
  state: string;
  cursor?: string | null;
  limit?: number;
  since?: string | null;
}): Promise<LicenseSyncProgress | { error: string }> {
  const source = getLicenseBoardSource(args.state);
  if (!source) {
    return { error: `no license-board source registered for state ${args.state}` };
  }
  if (!source.isConfigured) {
    return {
      error: `license-board source for ${args.state} not configured (env missing)`,
    };
  }

  const startedAt = Date.now();
  const { rows, next_cursor } = await source.fetchBatch({
    cursor: args.cursor ?? null,
    limit: args.limit ?? 500,
    since: args.since ?? null,
  });
  const { upserted, skipped } = await upsertContractorsBatch(rows);
  return {
    state: source.state,
    source_display_name: source.display_name,
    fetched: rows.length,
    upserted,
    skipped,
    next_cursor,
    duration_ms: Date.now() - startedAt,
  };
}
