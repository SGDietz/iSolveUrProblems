import { mockEsignProvider } from "./providers/mock";
import { dropboxSignProvider } from "./providers/dropbox-sign";
import type { EsignProvider, ProviderName } from "./types";

export type {
  EsignEnvelopeStatus,
  EsignSigner,
  CreateEnvelopeInput,
  CreateEnvelopeResult,
  EsignProvider,
  ProviderName,
} from "./types";

/**
 * M3.7 — Provider registry.
 *
 * Today's options:
 *   ESIGN_PROVIDER=mock          → mockEsignProvider (default, no vendor)
 *   ESIGN_PROVIDER=dropbox_sign  → dropboxSignProvider (when key handed over)
 *
 * Selection is env-driven so swapping for a real provider is a 1-line
 * change in `.env`. The orchestrator and routes never branch on
 * provider name — they call `getEsignProvider().createEnvelope(...)`.
 */
const REGISTRY: Record<string, EsignProvider> = {
  mock: mockEsignProvider,
  dropbox_sign: dropboxSignProvider,
};

export function getEsignProvider(): EsignProvider {
  const choice = (process.env.ESIGN_PROVIDER ?? "mock").toLowerCase();
  const provider = REGISTRY[choice];
  if (provider && provider.isConfigured && choice !== "mock") return provider;
  // PRODUCTION fails CLOSED (Herm release blocker #6): a simulated e-sign
  // envelope presented to a real user is fake data — the reality doctrine
  // applies to signatures too. Real provider configured or a loud error;
  // the orchestrator/routes surface it honestly instead of pretending.
  if (process.env.VERCEL_ENV === "production") {
    throw new Error(
      "No real e-sign provider configured. Refusing the mock signer in production — real signatures or nothing.",
    );
  }
  // Dev/preview keep the mock so contract-flow WIRING stays testable without
  // vendor keys (the flow itself is simulated and says so in dev).
  return mockEsignProvider;
}

export function getProviderNameFromEnv(): ProviderName {
  const choice = (process.env.ESIGN_PROVIDER ?? "mock").toLowerCase();
  return choice === "dropbox_sign" ? "dropbox_sign" : "mock";
}
