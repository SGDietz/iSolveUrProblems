"use client";

import { useTranslations } from "next-intl";
import type { RecommendationCard } from "../../lib/assistantSurface";

function priceTierGlyph(tier: number | null): string {
  if (!tier || tier < 1) return "—";
  return "$".repeat(Math.min(4, Math.max(1, tier)));
}

export function PicksPanel({
  picks,
  preferenceFacts,
}: {
  picks: RecommendationCard[];
  preferenceFacts: string[];
}) {
  const t = useTranslations("assistant.surface.picks");

  if (picks.length === 0) {
    return <p className="text-sm text-zinc-400">{t("empty")}</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {preferenceFacts.length > 0 && (
        <p className="text-[11px] text-zinc-500">
          {t("basedOn")} {preferenceFacts.slice(0, 3).join(" · ")}
        </p>
      )}
      <ol className="flex flex-col gap-2">
        {picks.map((p, i) => (
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
            <p className="text-sm text-zinc-200">{p.reason}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}
