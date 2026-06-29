"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { useAssistantSurface } from "../../lib/assistantSurface";
import { ContractorsPanel } from "./ContractorsPanel";
import { SummaryPanel } from "./SummaryPanel";
import { PicksPanel } from "./PicksPanel";
import { PickResultPanel } from "./PickResultPanel";
import { ComparePanel } from "./ComparePanel";
import { AppointmentPanel } from "./AppointmentPanel";
import { ContractPanel } from "./ContractPanel";
import { DisputePanel } from "./DisputePanel";
import { CallPanel } from "./CallPanel";
import { EstimatePanel } from "./EstimatePanel";
import { RecurringJobPanel } from "./RecurringJobPanel";

/**
 * AssistantSurface — the right-side drawer that 6 drives during voice
 * conversations (M3.0b).
 *
 * Mounted at the locale layout so it persists across navigation between
 * sibling routes (home, /contractors, /reports, etc.).
 *
 * Non-modal: the avatar UI stays interactive while the drawer is open.
 *
 * Desktop: 400px right-side panel.
 * Mobile:  full-width bottom sheet (~80vh tall).
 *
 * v1 is deliberately minimal — no animations beyond a CSS slide; design
 * polish (WW look) layered on later per SG Dietz "ugly is fine".
 */

export function AssistantSurface() {
  const variant = useAssistantSurface((s) => s.variant);
  const isOpen = useAssistantSurface((s) => s.isOpen);
  const dismiss = useAssistantSurface((s) => s.dismiss);
  const t = useTranslations("assistant.surface");

  // ESC key to dismiss — convention for non-modal overlays.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, dismiss]);

  if (!variant) return null;

  return (
    <aside
      aria-hidden={!isOpen}
      aria-label={t("ariaLabel")}
      className={
        // Outer container — fixed position, doesn't push page content.
        // Desktop: right-side drawer. Mobile: bottom sheet.
        "pointer-events-none fixed inset-0 z-50 flex " +
        "items-end justify-end sm:items-stretch"
      }
    >
      <div
        className={
          // The drawer panel itself.
          "pointer-events-auto flex flex-col bg-[#241406]/95 backdrop-blur brand-scroll " +
          "border-[#e0aa62]/40 text-[#f3d9b0] shadow-2xl " +
          "w-full sm:w-[400px] " +
          "h-[80vh] sm:h-full " +
          "rounded-t-2xl sm:rounded-none " +
          "border-t sm:border-t-0 sm:border-l " +
          "transition-transform duration-200 ease-out " +
          (isOpen
            ? "translate-y-0 sm:translate-x-0"
            : "translate-y-full sm:translate-y-0 sm:translate-x-full")
        }
      >
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[#e0aa62]/30">
          <p className="brand-grad-text text-[11px] uppercase tracking-[0.18em]">
            {labelForVariant(variant.kind, t)}
          </p>
          <button
            type="button"
            onClick={dismiss}
            className="rounded-md border border-[#e0aa62]/40 bg-[#3a2108]/40 px-2 py-1 text-xs text-[#e0aa62] hover:bg-[#4a2a0c]/60"
            aria-label={t("close")}
          >
            ✕
          </button>
        </header>

        <div className="brand-scroll flex-1 overflow-y-auto px-4 py-4">
          {variant.kind === "contractors" && (
            <ContractorsPanel
              hits={variant.hits}
              totalConsidered={variant.total_considered}
            />
          )}
          {variant.kind === "summary" && (
            <SummaryPanel payload={variant.payload} cached={variant.cached} />
          )}
          {variant.kind === "picks" && (
            <PicksPanel
              picks={variant.picks}
              preferenceFacts={variant.preference_facts}
            />
          )}
          {variant.kind === "pickResult" && (
            <PickResultPanel payload={variant.payload} />
          )}
          {variant.kind === "compare" && (
            <ComparePanel payload={variant.payload} />
          )}
          {variant.kind === "appointment" && (
            <AppointmentPanel payload={variant.payload} />
          )}
          {variant.kind === "contract" && (
            <ContractPanel payload={variant.payload} />
          )}
          {variant.kind === "dispute" && (
            <DisputePanel payload={variant.payload} />
          )}
          {variant.kind === "call" && (
            <CallPanel payload={variant.payload} />
          )}
          {variant.kind === "estimate" && (
            <EstimatePanel payload={variant.payload} />
          )}
          {variant.kind === "recurring" && (
            <RecurringJobPanel payload={variant.payload} />
          )}
        </div>
      </div>
    </aside>
  );
}

function labelForVariant(
  kind:
    | "contractors"
    | "summary"
    | "picks"
    | "pickResult"
    | "compare"
    | "appointment"
    | "contract"
    | "dispute"
    | "call"
    | "estimate"
    | "recurring",
  t: (key: string) => string,
): string {
  switch (kind) {
    case "contractors":
      return t("variant.contractors");
    case "summary":
      return t("variant.summary");
    case "picks":
      return t("variant.picks");
    case "pickResult":
      return t("variant.pickResult");
    case "compare":
      return t("variant.compare");
    case "appointment":
      return t("variant.appointment");
    case "contract":
      return t("variant.contract");
    case "dispute":
      return t("variant.dispute");
    case "call":
      return t("variant.call");
    case "estimate":
      return t("variant.estimate");
    case "recurring":
      return t("variant.recurring");
  }
}
