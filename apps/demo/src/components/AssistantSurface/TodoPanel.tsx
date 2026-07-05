"use client";

import { useTranslations } from "next-intl";
import type { TodoPayload } from "../../lib/assistantSurface";

/**
 * Visible list panel (Herm TASK_082 — lists were voice-only; G: "I want
 * those pillboxes to go down"). Shows the target list's OPEN items in the
 * same spoken order 6 reads them ("check off number two" resolves against
 * this numbering), plus a one-line confirmation of what just changed.
 */
export function TodoPanel({ payload }: { payload: TodoPayload }) {
  const t = useTranslations("assistant.surface.todo");
  const changed = payload.changed;
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
    <div className="flex flex-col gap-3 text-sm">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold text-amber-300">{payload.list_title}</h3>
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">
          {t("openCount", { count: payload.items.length })}
        </span>
      </header>

      {payload.persistence_note && (
        // Guest-list honesty banner (G live smoke 2026-07-04): the list is
        // VISIBLE but not saved — loud, amber, above everything else.
        <div className="rounded-md border border-amber-400/50 bg-amber-950/40 px-3 py-2 text-xs font-semibold text-amber-100">
          {payload.persistence_note}
        </div>
      )}

      {summary && (
        <div className="rounded-md bg-zinc-950/50 border border-amber-800/40 px-3 py-2 text-xs text-amber-200">
          {summary}
        </div>
      )}

      {payload.items.length > 0 ? (
        <ol className="flex flex-col gap-1">
          {payload.items.map((item, idx) => (
            <li
              key={item.id}
              className="rounded-md bg-zinc-950/40 border border-zinc-800/60 px-3 py-1.5 flex items-center gap-2 text-xs"
            >
              <span className="shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-amber-400/10 text-[10px] font-mono text-amber-300">
                {idx + 1}
              </span>
              <span className="truncate">{item.title}</span>
            </li>
          ))}
        </ol>
      ) : (
        <div className="rounded-md border border-dashed border-zinc-800 px-3 py-3 text-xs text-zinc-500">
          {t("empty")}
        </div>
      )}
    </div>
  );
}
