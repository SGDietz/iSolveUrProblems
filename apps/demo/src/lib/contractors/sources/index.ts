import { mockAdapter } from "./mock";
import { serpapiAdapter } from "./serpapi";
import type { ContractorSourceAdapter } from "./types";

/**
 * Source registry. Selects which adapter to use based on env.
 *
 * Today's options:
 *   CONTRACTOR_DATA_SOURCE=mock     → mockAdapter (default — works without vendor)
 *   CONTRACTOR_DATA_SOURCE=serpapi  → serpapiAdapter (M4.0b — requires SERPAPI_API_KEY)
 *
 * Note: M4.0a license-board ingestion is NOT a search-time adapter —
 * it's a bulk ETL source (see ./licenseBoard.ts + ./cslb.ts), called by
 * the admin sync route rather than registered here.
 *
 * Adding a new search-time source is a 2-line change: import + registry
 * entry. The orchestrator + every downstream feature (M2.2 search, M2.3
 * summarizer, M2.4 recommendation) is source-agnostic.
 */
const REGISTRY: Record<string, ContractorSourceAdapter> = {
  mock: mockAdapter,
  serpapi: serpapiAdapter,
};

export function getContractorSource(): ContractorSourceAdapter {
  const choice = (process.env.CONTRACTOR_DATA_SOURCE ?? "mock").toLowerCase();
  const adapter = REGISTRY[choice];
  if (adapter && adapter.isConfigured) return adapter;
  // Fall back to mock so dev never breaks waiting on vendor keys.
  return mockAdapter;
}

export { mockAdapter };
export type { ContractorSourceAdapter };
