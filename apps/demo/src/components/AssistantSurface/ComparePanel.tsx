"use client";

import { useTranslations } from "next-intl";
import type { ComparePayload } from "../../lib/assistantSurface";

function priceTierGlyph(tier: number | null): string {
  if (!tier || tier < 1) return "—";
  return "$".repeat(Math.min(4, Math.max(1, tier)));
}

/**
 * M3.8 — Decision-support compare panel.
 *
 * Side-by-side cards for the top picks the deliberation engine returned.
 * Headlines per pick mirror what 6 narrates so the spoken and visual
 * surfaces feel like one conversation, not two.
 */
export function ComparePanel({ payload }: { payload: ComparePayload }) {
  const t = useTranslations("assistant.surface.compare");

  if (payload.picks.length === 0) {
    return <p className="text-sm text-zinc-400">{t("empty")}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {payload.active_constraints.length > 0 && (
        <p className="text-[11px] text-zinc-500">
          {t("activeConstraints")} {payload.active_constraints.join(" · ")}
        </p>
      )}
      {payload.preference_facts.length > 0 && (
        <p className="text-[11px] text-zinc-500">
          {t("basedOn")} {payload.preference_facts.slice(0, 3).join(" · ")}
        </p>
      )}

      <ol className="flex flex-col gap-2">
        {payload.picks.map((p, i) => (
          <li
            key={p.id}
            className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 flex flex-col gap-1.5"
          >
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-2">
                <span className="text-amber-300 font-mono text-xs">
                  #{i + 1}
                </span>
                <span className="font-semibold text-sm">{p.name}</span>
              </div>
              <span className="text-[11px] text-zinc-400 font-mono shrink-0">
                {p.rating_avg != null ? `★ ${p.rating_avg.toFixed(1)}` : "★ —"}
                {p.distance_km > 0 && ` · ${p.distance_km.toFixed(1)} km`}
                {" · "}
                {priceTierGlyph(p.price_tier)}
              </span>
            </div>
            {payload.headlines[i] && (
              <p className="text-xs text-amber-200">
                {payload.headlines[i]}
              </p>
            )}
            <p className="text-sm text-zinc-200">{p.reason}</p>
            <div className="flex flex-wrap gap-1.5 text-[10px]">
              {p.licensed_flag && (
                <span className="rounded bg-emerald-500/15 text-emerald-300 px-1.5 py-0.5">
                  {t("badge.licensed")}
                </span>
              )}
              {p.same_day_flag && (
                <span className="rounded bg-sky-500/15 text-sky-300 px-1.5 py-0.5">
                  {t("badge.sameDay")}
                </span>
              )}
              {p.locally_owned && (
                <span className="rounded bg-amber-500/15 text-amber-300 px-1.5 py-0.5">
                  {t("badge.locallyOwned")}
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
