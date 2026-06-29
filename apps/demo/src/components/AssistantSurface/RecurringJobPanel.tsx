"use client";

import { useTranslations } from "next-intl";
import type { RecurringJobPayload } from "../../lib/assistantSurface";

/**
 * M4.7 — Recurring job confirmation panel.
 *
 * Shown after 6 schedules an autopilot job. Displays the cadence in
 * plain English + the next 3 instances so the homeowner can sanity-
 * check the schedule. The cron materializes upcoming instances; this
 * panel is a one-shot confirmation surface.
 */
export function RecurringJobPanel({
  payload,
}: {
  payload: RecurringJobPayload;
}) {
  const t = useTranslations("assistant.surface.recurring");

  const formatInstance = (iso: string): string => {
    try {
      return new Date(iso).toLocaleString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: payload.timezone,
      });
    } catch {
      return iso;
    }
  };

  return (
    <div className="flex flex-col gap-3 text-sm">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold text-emerald-300">{t("title")}</h3>
        <span
          className={
            "text-[10px] uppercase tracking-wide font-mono " +
            (payload.status === "active"
              ? "text-emerald-300"
              : payload.status === "paused"
                ? "text-amber-300"
                : "text-zinc-500")
          }
        >
          {t(`status.${payload.status}`)}
        </span>
      </header>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 flex flex-col gap-1">
        <p className="text-zinc-100 font-semibold">{payload.title}</p>
        {payload.contractor_name && (
          <p className="text-xs text-zinc-400">
            {t("withLabel")} {payload.contractor_name}
          </p>
        )}
        <p className="text-sm text-amber-200">{payload.schedule_human}</p>
        {payload.agenda && payload.agenda !== payload.title && (
          <p className="text-xs text-zinc-300 italic">{payload.agenda}</p>
        )}
      </div>

      <section className="flex flex-col gap-1.5">
        <p className="text-[11px] uppercase tracking-wide text-zinc-500">
          {t("upcomingLabel")}
        </p>
        {payload.next_instances.length === 0 ? (
          <p className="text-xs text-zinc-500 italic">{t("noUpcoming")}</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {payload.next_instances.map((iso) => (
              <li
                key={iso}
                className="rounded-md bg-zinc-900/60 border border-zinc-800 px-3 py-1.5 text-sm text-zinc-100"
              >
                {formatInstance(iso)}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="text-[11px] text-zinc-500">{t("autopilotFootnote")}</p>
    </div>
  );
}
