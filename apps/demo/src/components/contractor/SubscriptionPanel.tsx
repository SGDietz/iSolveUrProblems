"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { Tier } from "../../lib/billing";

/**
 * M4.1 — Contractor subscription panel.
 *
 * Renders the current tier + action buttons:
 *   - On free tier: "Upgrade to Bronze / Silver / Gold" buttons
 *   - On paid tier: "Manage subscription" (Stripe Customer Portal link)
 *     + "Cancel at period end" if not already scheduled to cancel
 *
 * All flows redirect through Stripe — we never collect card data
 * directly. The dashboard state refreshes on next page load (after
 * webhooks fire).
 */

export type CurrentSubscription = {
  tier: Tier;
  status: string;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  trial_end: string | null;
};

const PAID_TIERS: Tier[] = ["bronze", "silver", "gold"];

export function SubscriptionPanel({
  contractor_id,
  current,
}: {
  contractor_id: string;
  current: CurrentSubscription;
}) {
  const t = useTranslations("contractor.subscription");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startSubscription(tier: Tier) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/contractors/${contractor_id}/subscription/start`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tier }),
        },
      );
      const data = (await res.json()) as {
        checkout_url?: string;
        error?: string;
      };
      if (!res.ok || !data.checkout_url) {
        setError(data.error ?? t("errorGeneric"));
        return;
      }
      window.location.href = data.checkout_url;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  async function openPortal() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/contractors/${contractor_id}/subscription/portal`,
        { method: "POST" },
      );
      const data = (await res.json()) as { portal_url?: string; error?: string };
      if (!res.ok || !data.portal_url) {
        setError(data.error ?? t("errorGeneric"));
        return;
      }
      window.location.href = data.portal_url;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  async function cancelSub() {
    if (busy) return;
    if (!confirm(t("cancelConfirm"))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/contractors/${contractor_id}/subscription/cancel`,
        { method: "POST" },
      );
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? t("errorGeneric"));
        return;
      }
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  const isFree = current.tier === "free";
  const isPaid = !isFree;
  const periodEndDate = current.current_period_end
    ? new Date(current.current_period_end)
    : null;
  const trialEndDate = current.trial_end ? new Date(current.trial_end) : null;
  const inTrial = current.status === "trialing";

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 flex flex-col gap-3 text-sm">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-zinc-100">
          {t("title")}{" "}
          <span className="text-xs uppercase tracking-wide text-amber-300 font-normal ml-1">
            {t(`tier.${current.tier}`)}
          </span>
        </h2>
        <span
          className={
            "text-[10px] uppercase tracking-wide font-mono " +
            (isPaid ? "text-emerald-300" : "text-zinc-500")
          }
        >
          {t(`status.${current.status}`)}
        </span>
      </header>

      {inTrial && trialEndDate && (
        <p className="text-xs text-amber-300">
          {t("trialUntil", { date: trialEndDate.toLocaleDateString() })}
        </p>
      )}
      {isPaid && current.cancel_at_period_end && periodEndDate && (
        <p className="text-xs text-rose-300">
          {t("cancelsOn", { date: periodEndDate.toLocaleDateString() })}
        </p>
      )}
      {isPaid && !current.cancel_at_period_end && periodEndDate && (
        <p className="text-xs text-zinc-400">
          {t("renewsOn", { date: periodEndDate.toLocaleDateString() })}
        </p>
      )}

      {isFree && (
        <>
          <p className="text-zinc-300">{t("upgradeBlurb")}</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {PAID_TIERS.map((tier) => (
              <button
                key={tier}
                type="button"
                onClick={() => startSubscription(tier)}
                disabled={busy}
                className="rounded-md bg-zinc-900 hover:bg-zinc-800 disabled:opacity-50 border border-amber-700/40 px-3 py-2 text-sm font-semibold text-amber-200 text-left"
              >
                <div>{t(`tier.${tier}`)}</div>
                <div className="text-[11px] text-zinc-400 font-normal">
                  {t(`tierBlurb.${tier}`)}
                </div>
              </button>
            ))}
          </div>
        </>
      )}

      {isPaid && (
        <div className="flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            onClick={openPortal}
            disabled={busy}
            className="flex-1 rounded-md bg-emerald-500/90 hover:bg-emerald-500 disabled:opacity-50 text-zinc-950 text-sm font-semibold px-3 py-2"
          >
            {t("manageCta")}
          </button>
          {!current.cancel_at_period_end && (
            <button
              type="button"
              onClick={cancelSub}
              disabled={busy}
              className="rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 text-sm px-3 py-2"
            >
              {t("cancelCta")}
            </button>
          )}
        </div>
      )}

      {error && <p className="text-xs text-rose-300 font-mono">{error}</p>}
    </section>
  );
}
