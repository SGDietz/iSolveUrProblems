"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

/**
 * M4.0d follow-up — Stripe Connect onboarding CTA.
 *
 * Rendered inside the contractor dashboard's "payout pending" banner.
 * Hits the contractor-self-service Connect onboarding route, which
 * creates the Express account (idempotent) and returns a fresh Stripe
 * Account Link URL. We then redirect the browser there; Stripe handles
 * banking/identity/KYC and bounces back to STRIPE_CONNECT_RETURN_URL.
 *
 * After the contractor completes onboarding, Stripe fires
 * `account.updated` to /api/webhooks/stripe with charges_enabled=true;
 * the next dashboard load shows the green "Payout ready" badge.
 */
export function ConnectOnboardButton({
  contractor_id,
}: {
  contractor_id: string;
}) {
  const t = useTranslations("contractor.dashboard.onboardingBanner");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startOnboarding() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/contractors/${contractor_id}/connect-onboard`,
        { method: "POST" },
      );
      const data = (await res.json()) as {
        onboarding_url?: string;
        error?: string;
      };
      if (!res.ok || !data.onboarding_url) {
        setError(data.error ?? t("errorGeneric"));
        return;
      }
      window.location.href = data.onboarding_url;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={startOnboarding}
        disabled={busy}
        className="self-start rounded-md bg-amber-500/90 hover:bg-amber-500 disabled:opacity-50 text-zinc-950 text-sm font-semibold px-3 py-2"
      >
        {busy ? t("onboardingSubmitting") : t("onboardingCta")}
      </button>
      {error && <p className="text-xs text-rose-300 font-mono">{error}</p>}
    </div>
  );
}
