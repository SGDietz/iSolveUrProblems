import type { ContractorSourceAdapter } from "./types";

/**
 * Source registry. Selects which adapter to use based on env.
 *
 * G's order 2026-07-02: **real data and real scraping ONLY, everywhere,
 * forever** — the mock adapter, the `CONTRACTOR_DATA_SOURCE=mock` choice,
 * and the ALLOW_MOCK_CONTRACTORS escape hatch are all GONE (they existed
 * only to demo without a vendor; the 750 mock DB rows were purged the same
 * night, archived to Scheduled/account_wipe_archive/). Live scraping runs
 * through contractors/liveFind.ts (Outscraper); this registry is for future
 * BULK sources (e.g. a scheduled refresher). No entry configured = throw,
 * in every environment — dev included. Real or nothing.
 */
const REGISTRY: Record<string, ContractorSourceAdapter> = {
  // Intentionally empty until a real bulk source lands (e.g. "outscraper").
};

export function getContractorSource(): ContractorSourceAdapter {
  const choice = (process.env.CONTRACTOR_DATA_SOURCE ?? "").toLowerCase();
  const adapter = choice ? REGISTRY[choice] : undefined;
  if (adapter?.isConfigured) return adapter;
  throw new Error(
    choice
      ? `Contractor data source "${choice}" is not configured. Real contractors or nothing — there is no mock fallback.`
      : "No contractor data source configured. Real contractors or nothing — there is no mock fallback.",
  );
}

export type { ContractorSourceAdapter };
