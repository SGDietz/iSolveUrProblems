"use client";

import { useTranslations } from "next-intl";
import { useAssistantSurface } from "../../lib/assistantSurface";
import type { TodoPayload } from "../../lib/assistantSurface";
import { TODO_TEXT_SIZE_CLASSES } from "../../lib/uiSize";

// SUP #5 (G ride 2026-07-07 16:53: "there should be an x if somebody wants
// to close that item"): a tapped ✕ rides the SAME machinery as the spoken
// command — the context provider hears this event and runs "remove number N"
// through the normal transcript → orchestrator path, so guest transient and
// signed-in lists both use the already-tested remove handler.
function dispatchTodoRemoveTap(position: number) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent("isolve:synthetic-user-utterance", {
      detail: {
        source: "todo-remove-tap",
        text: `remove number ${position}`,
      },
    }),
  );
}

/**
 * Visible list panel (Herm TASK_082 — lists were voice-only; G: "I want
 * those pillboxes to go down"). Shows the target list's OPEN items in the
 * same spoken order 6 reads them ("check off number two" resolves against
 * this numbering), plus a one-line confirmation of what just changed.
 */
export function TodoPanel({
  payload,
  compact = false,
}: {
  payload: TodoPayload;
  compact?: boolean;
}) {
  const t = useTranslations("assistant.surface.todo");
  const changed = payload.changed;
  const rootText = compact ? "text-xs" : "text-sm";
  const rootGap = compact ? "gap-2" : "gap-3";
  const noticePad = compact ? "px-3 py-1.5" : "px-3 py-2";
  const noticeText = compact ? "text-[11px]" : "text-xs";
  const listGap = compact ? "gap-2" : "gap-1";
  const itemPad = compact ? "px-3 py-2" : "px-3 py-1.5";
  // SUP #22 ("make the text bigger"): the compact sheet's item text follows
  // the voice-set size level; default level renders the same 0.9rem as
  // before, so nothing moves until the user asks (#1.5).
  const todoTextSizeLevel = useAssistantSurface((s) => s.todoTextSizeLevel);
  const scaledItemText =
    TODO_TEXT_SIZE_CLASSES[todoTextSizeLevel] ?? TODO_TEXT_SIZE_CLASSES[1];
  const itemText = compact ? scaledItemText : "text-xs";
  const numberSize = compact ? "h-5 w-5 text-[10px]" : "h-5 w-5 text-[10px]";
  const summary = changed?.added?.length
    ? t("summaryAdded", { items: changed.added.join(", ") })
    : changed?.completed?.length
      ? t("summaryCompleted", { items: changed.completed.join(", ") })
      : changed?.removed?.length
        ? t("summaryRemoved", { items: changed.removed.join(", ") })
        : typeof changed?.cleared === "number"
          ? t("summaryCleared", { count: changed.cleared })
          : changed?.already_there?.length
            ? t("summaryAlready", { items: changed.already_there.join(", ") })
            : null;

  return (
    // Brand restyle (G live-ride 2026-07-06: "now they should be all brand
    // colors, there's yellow here... there's white" — this panel was still
    // plain Tailwind zinc/amber-300 instead of the gold-amber gradient every
    // other surface uses). Same card language as ContractorsPanel. The list
    // NAME now lives only in AssistantSurface's outer header bar — this inner
    // title was a redundant duplicate ("that's redundant... under it, it says
    // your list" — G live-ride 2026-07-06); keep just the open-count here.
    <div className={`flex flex-col ${rootGap} ${rootText}`}>
      <div className="flex justify-start">
        <p className="brand-grad-text text-[10px] font-semibold">
          {t("showingCount", { count: payload.items.length })}
        </p>
      </div>

      {payload.persistence_note && (
        // Guest-list honesty banner (G live smoke 2026-07-04): the list is
        // VISIBLE but not saved — loud, above everything else, brand gold.
        // Warmer/more saturated tone (G 2026-07-06: "the whites are too
        // white") — pale cream read as near-white on this dark background.
        <div className={`rounded-xl border border-[#e0aa62]/60 bg-gradient-to-b from-[#4a2a0c]/70 to-[#241406]/70 ${noticePad} ${noticeText} font-semibold text-[#f1c477]`}>
          {payload.persistence_note}
        </div>
      )}

      {summary && (
        <div className={`rounded-xl border border-[#e0aa62]/40 bg-gradient-to-b from-[#341d07]/80 to-[#130a03]/80 ${noticePad} ${noticeText} text-[#f1c477]/90`}>
          {summary}
        </div>
      )}

      {payload.items.length > 0 ? (
        <ol className={`flex flex-col ${listGap}`}>
          {payload.items.map((item, idx) => (
            <li
              key={item.id}
              className={`flex items-center gap-2 rounded-2xl border-2 border-[#e0aa62]/85 bg-gradient-to-b from-[#341d07]/95 to-[#130a03]/95 ${itemPad} ${itemText} shadow-[inset_0_1px_10px_rgba(255,255,255,0.10),0_10px_28px_rgba(0,0,0,0.5)] backdrop-blur-[3px]`}
            >
              <span className={`flex ${numberSize} shrink-0 items-center justify-center rounded-full border border-[#e0aa62]/40 font-mono text-[#f1c477]`}>
                {idx + 1}
              </span>
              <span className="min-w-0 flex-1 truncate text-[#f1c477]">{item.title}</span>
              <button
                type="button"
                aria-label={`Remove number ${idx + 1}`}
                title={`Remove number ${idx + 1}`}
                onClick={() => dispatchTodoRemoveTap(idx + 1)}
                className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-[#e0aa62]/50 bg-[#3a2108]/70 text-[11px] font-bold leading-none text-[#f1c477]/90 shadow-[inset_0_1px_6px_rgba(255,255,255,0.08)] transition hover:border-[#ffe9c2]/80 hover:text-[#ffe9c2] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#ffe9c2]"
              >
                ×
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <div className="rounded-xl border border-dashed border-[#e0aa62]/30 px-3 py-3 text-xs text-[#e8b96a]/60">
          {t("empty")}
        </div>
      )}
    </div>
  );
}
