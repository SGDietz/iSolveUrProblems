"use client";

import { useCallback, useEffect } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useAssistantSurface } from "../../lib/assistantSurface";
import { playWhoosh } from "../../lib/ui/sfx";
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
import { TodoPanel } from "./TodoPanel";
import { ContractorOnboardingPanel } from "./ContractorOnboardingPanel";

/**
 * AssistantSurface — the right-side drawer that 6 drives during voice
 * conversations (M3.0b).
 *
 * Mounted at the locale layout so it persists across navigation between
 * sibling routes (home, /contractors, /reports, etc.).
 *
 * Non-modal: the avatar UI stays interactive while the drawer is open.
 *
 * Desktop/laptop ONLY (xl:, 1280px+ — G's "desktop AND laptop"): 400px
 *          right-side panel.
 * Phone + tablet/iPad (below xl): full-width bottom sheet, 55vh tall — 6's
 *          face + shoulders stay visible above it. The iPad must behave like
 *          the phone, NOT the desktop (G iPad smoke 2026-07-03: "List should
 *          be 6 shoulders down, just like on mobile" — it was rendering as a
 *          full-height right slab cutting 6 in half at the sm: breakpoint).
 *
 * v1 is deliberately minimal — no animations beyond a CSS slide; design
 * polish (WW look) layered on later per SG Dietz "ugly is fine".
 */

export function AssistantSurface() {
  const variant = useAssistantSurface((s) => s.variant);
  const isOpen = useAssistantSurface((s) => s.isOpen);
  const dismiss = useAssistantSurface((s) => s.dismiss);
  const t = useTranslations("assistant.surface");
  const tHome = useTranslations("home");

  // Cards leave with a down-sweep whoosh (G via Herm 2026-07-01). The drawer's
  // existing slide-out is the exit motion; per-card scatter exits need a
  // drawer-hold choreography — queued as a follow-up polish.
  const dismissWithSfx = useCallback(() => {
    try {
      playWhoosh("out");
    } catch {
      /* sound must never block dismiss */
    }
    dismiss();
  }, [dismiss]);

  // ESC key to dismiss — convention for non-modal overlays.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") dismissWithSfx();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, dismissWithSfx]);

  if (!variant) return null;

  // CONTRACTOR RESULTS = a stage-bounded chest sheet, not a viewport drawer.
  // G screenshot 2026-07-04: desktop/laptop/iPad all need the same rule — the
  // contractor box sits ONLY over the centered avatar frame (inside the blue
  // bounds he marked), never across the workshop letterbox margins. Keep this
  // separate from the generic summary/picks drawer because contractor cards are
  // the live search result surface G is positioning on 6.
  if (variant.kind === "contractors") {
    return (
      <aside
        aria-hidden={!isOpen}
        aria-label={t("ariaLabel")}
        className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center"
        style={{ paddingBottom: "var(--stage-bottom)" }}
      >
        <div
          className={
            "flex flex-col w-[var(--stage-width)] max-w-[96vw] " +
            "h-[calc(var(--stage-height)*0.43)] max-h-[48vh] " +
            "rounded-t-2xl border-2 border-b-0 border-[#e0aa62]/60 bg-[#241406]/95 " +
            "text-[#f3d9b0] shadow-[inset_0_2px_14px_rgba(0,0,0,0.62),0_0_30px_rgba(224,170,98,0.34)] backdrop-blur brand-scroll " +
            "transition-transform duration-200 ease-out " +
            (isOpen
              ? "pointer-events-auto translate-y-0"
              : "pointer-events-none translate-y-[calc(100%_+_var(--stage-bottom))]")
          }
        >
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#e0aa62]/30 px-3 py-2">
            <p className="brand-grad-text text-[10px] uppercase tracking-[0.18em]">
              {labelForVariant(variant.kind, t)}
            </p>
            <button
              type="button"
              onClick={dismissWithSfx}
              className="rounded-md border border-[#e0aa62]/40 bg-[#3a2108]/40 px-2 py-1 text-xs text-[#e0aa62] hover:bg-[#4a2a0c]/60"
              aria-label={t("close")}
            >
              ✕
            </button>
          </header>
          <div className="brand-scroll flex-1 overflow-y-auto px-3 py-2">
            <ContractorsPanel
              hits={variant.hits}
              totalConsidered={variant.total_considered}
              compact
            />
          </div>
          {/* Legal line stays inside the avatar-bounded sheet so the footer also
              stops spanning outside 6's box. */}
          <Link
            href="/terms"
            target="_blank"
            className="brand-grad-text block shrink-0 border-t border-[#e0aa62]/30 px-3 py-1.5 text-center text-[9px] whitespace-nowrap transition-opacity hover:opacity-90"
          >
            {tHome("footer")}
          </Link>
        </div>
      </aside>
    );
  }

  // LIST = THE BOTTOM HALF OF 6'S AVATAR FRAME, on his chest (G 2026-07-03:
  // "I want to see the list on your chest… all the boxes gone… Ours will be
  // the bottom half of the screen"). Important desktop nuance: "screen" here
  // means the locked 9:16 avatar stage, NOT the whole browser viewport. The
  // stage can be letterboxed on desktop, so anchor width/height/bottom to the
  // shared --stage-* variables from globals.css; otherwise the list box drifts
  // below/outside 6's body on wide desktop windows.
  // Prompt pills + Camera/Video/Gallery already hide while any surface is open
  // ("all the boxes gone"). The amber chest styling keeps it reading as "on
  // 6's chest," NOT the generic drawer — contractor results have their own
  // slimmer stage-bounded sheet above. Every other panel keeps the sheet/drawer
  // idiom untouched.
  // iSolve-original UI: aiASAP has no on-screen list to copy.
  if (variant.kind === "todo") {
    return (
      <aside
        aria-hidden={!isOpen}
        aria-label={t("ariaLabel")}
        className="pointer-events-none fixed inset-0 z-50 flex items-end justify-center"
        style={{ paddingBottom: "var(--stage-bottom)" }}
      >
        <div
          className={
            "flex flex-col w-[var(--stage-width)] max-w-[96vw] " +
            "h-[calc(var(--stage-height)*0.5)] max-h-[55vh] " +
            "rounded-t-2xl border-2 border-b-0 border-[#f1c477] bg-[#140c05]/95 " +
            "text-[#f3d9b0] shadow-[inset_0_2px_14px_rgba(0,0,0,0.6),0_0_30px_rgba(241,196,119,0.45)] " +
            "transition-transform duration-200 ease-out " +
            (isOpen
              ? "pointer-events-auto translate-y-0"
              : "pointer-events-none translate-y-[calc(100%_+_var(--stage-bottom))]")
          }
        >
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[#e0aa62]/30 px-4 py-3">
            <p className="brand-grad-text text-[11px] uppercase tracking-[0.18em]">
              {labelForVariant(variant.kind, t)}
            </p>
            <button
              type="button"
              onClick={dismissWithSfx}
              className="rounded-md border border-[#e0aa62]/40 bg-[#3a2108]/40 px-2 py-1 text-xs text-[#e0aa62] hover:bg-[#4a2a0c]/60"
              aria-label={t("close")}
            >
              ✕
            </button>
          </header>
          <div className="brand-scroll flex-1 overflow-y-auto px-4 py-3">
            <TodoPanel payload={variant.payload} />
          </div>
          {/* Legal line stays visible while the sheet is up — same rule as
              the contractor sheet (G Droid smoke 2026-07-02), Herm TASK_104. */}
          <Link
            href="/terms"
            target="_blank"
            className="brand-grad-text block shrink-0 border-t border-[#e0aa62]/30 px-4 py-2 text-center text-[10px] whitespace-nowrap transition-opacity hover:opacity-90"
          >
            {tHome("footer")}
          </Link>
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-hidden={!isOpen}
      aria-label={t("ariaLabel")}
      className={
        // Outer container — fixed position, doesn't push page content.
        // xl+ (desktop/laptop): right-side drawer. Below xl (phone+iPad):
        // bottom sheet.
        "pointer-events-none fixed inset-0 z-50 flex " +
        "items-end justify-end xl:items-stretch"
      }
    >
      <div
        className={
          // The drawer panel itself.
          "pointer-events-auto flex flex-col bg-[#241406]/95 backdrop-blur brand-scroll " +
          "border-[#e0aa62]/40 text-[#f3d9b0] shadow-2xl " +
          "w-full xl:w-[400px] " +
          // Sheet capped at 55vh so 6's FACE stays visible above the cards
          // (G Droid smoke 2026-07-02: "I can't see your face, Six... kind of
          // chin down, like your neck down"). This holds on phone AND iPad —
          // only xl+ (real desktop/laptop) gets the full-height side drawer
          // (G iPad smoke 2026-07-03: "6 shoulders down, just like on mobile").
          "h-[55vh] xl:h-full " +
          "rounded-t-2xl xl:rounded-none " +
          "border-t xl:border-t-0 xl:border-l " +
          "transition-transform duration-200 ease-out " +
          (isOpen
            ? "translate-y-0 xl:translate-x-0"
            : "translate-y-full xl:translate-y-0 xl:translate-x-full")
        }
      >
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-[#e0aa62]/30">
          <p className="brand-grad-text text-[11px] uppercase tracking-[0.18em]">
            {labelForVariant(variant.kind, t)}
          </p>
          <button
            type="button"
            onClick={dismissWithSfx}
            className="rounded-md border border-[#e0aa62]/40 bg-[#3a2108]/40 px-2 py-1 text-xs text-[#e0aa62] hover:bg-[#4a2a0c]/60"
            aria-label={t("close")}
          >
            ✕
          </button>
        </header>

        <div className="brand-scroll flex-1 overflow-y-auto px-4 py-4">
          {/* contractors never reach the generic drawer — they early-return as
              the avatar-bounded chest sheet above. */}
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
          {/* todo never reaches the drawer — it early-returns as the chest
              panel above (G Droid ride 2026-07-03). */}
          {variant.kind === "contractorOnboarding" && (
            <ContractorOnboardingPanel payload={variant.payload} />
          )}
        </div>

        {/* Legal line stays visible while the sheet is up (G Droid smoke
            2026-07-02: "for legal reasons you probably still have to have the
            copyright... privacy at the bottom") — same full brand footer as
            the page, which the sheet otherwise covers. */}
        <Link
          href="/terms"
          target="_blank"
          className="brand-grad-text block shrink-0 border-t border-[#e0aa62]/30 px-4 py-2 text-center text-[10px] whitespace-nowrap transition-opacity hover:opacity-90"
        >
          {tHome("footer")}
        </Link>
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
    | "todo"
    | "contractorOnboarding"
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
    case "todo":
      return t("variant.todo");
    case "contractorOnboarding":
      return t("variant.contractorOnboarding");
    case "recurring":
      return t("variant.recurring");
  }
}
