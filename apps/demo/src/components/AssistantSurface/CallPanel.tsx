"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import {
  useAssistantSurface,
  type CallPayload,
  type CallTranscriptLine,
} from "../../lib/assistantSurface";

/**
 * M3.1 — Live phone-call panel.
 *
 * Polls /api/calls/[id] every 3s while the call is dialing or
 * in-progress to update the transcript + status. Stops polling on a
 * terminal status. The polling endpoint is intentionally cheap (one
 * row lookup + a recent-transcripts query).
 */
export function CallPanel({ payload }: { payload: CallPayload }) {
  const t = useTranslations("assistant.surface.call");
  const showCall = useAssistantSurface((s) => s.showCall);
  const isLive =
    payload.status === "queued" ||
    payload.status === "dialing" ||
    payload.status === "in_progress";
  const lastRefreshed = useRef(0);

  useEffect(() => {
    if (!isLive) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function tick() {
      if (cancelled) return;
      const now = Date.now();
      // Coalesce — don't refresh more often than every 2s.
      if (now - lastRefreshed.current < 2000) {
        timer = setTimeout(tick, 2000);
        return;
      }
      lastRefreshed.current = now;
      try {
        const res = await fetch(`/api/calls/${payload.call_id}`);
        if (res.ok) {
          const next = (await res.json()) as CallPayload;
          if (!cancelled) showCall(next);
        }
      } catch {
        /* ignore — next tick will retry */
      }
      if (!cancelled) timer = setTimeout(tick, 3000);
    }
    timer = setTimeout(tick, 3000);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isLive, payload.call_id, showCall]);

  const toneClass =
    payload.status === "in_progress"
      ? "text-emerald-300"
      : payload.status === "completed"
        ? "text-zinc-400"
        : payload.status === "failed" ||
            payload.status === "no_answer" ||
            payload.status === "busy" ||
            payload.status === "cancelled"
          ? "text-rose-300"
          : "text-amber-300";

  async function hangUp() {
    await fetch(`/api/calls/${payload.call_id}/end`, { method: "POST" }).catch(
      () => null,
    );
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <header className="flex items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h3 className="font-semibold text-emerald-300">
            {payload.mode === "go_between" ? t("titleGoBetween") : t("title")}
          </h3>
          {payload.mode === "go_between" && (
            <span className="text-[10px] uppercase tracking-wide font-mono px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300">
              {t("modeBadgeGoBetween")}
            </span>
          )}
        </div>
        <span
          className={
            "text-[10px] uppercase tracking-wide font-mono " + toneClass
          }
        >
          {t(`status.${payload.status}`)}
        </span>
      </header>

      <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[11px] uppercase tracking-wide text-zinc-500">
            {t("contractorLabel")}
          </span>
          <span className="font-semibold text-zinc-100">
            {payload.contractor_name ?? "—"}
          </span>
        </div>
        {payload.contractor_phone && (
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-[11px] uppercase tracking-wide text-zinc-500">
              {t("contractorPhoneLabel")}
            </span>
            <span className="font-mono text-xs text-zinc-300">
              {payload.contractor_phone}
            </span>
          </div>
        )}
      </div>

      <ul className="flex flex-col gap-1.5 max-h-[40vh] overflow-y-auto">
        {payload.transcript.length === 0 ? (
          <li className="text-xs text-zinc-500 italic">
            {isLive ? t("waitingTranscript") : t("noTranscript")}
          </li>
        ) : (
          payload.transcript.map((line) => (
            <TranscriptLine key={line.id} line={line} t={t} />
          ))
        )}
      </ul>

      {payload.recording_signed_url && (
        <a
          href={payload.recording_signed_url}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-md bg-zinc-800 hover:bg-zinc-700 text-zinc-100 text-xs px-3 py-2 text-center"
        >
          {t("downloadRecording")}
        </a>
      )}

      {isLive && (
        <button
          type="button"
          onClick={hangUp}
          className="rounded-md bg-rose-500/90 hover:bg-rose-500 text-zinc-950 text-sm font-semibold px-3 py-2"
        >
          {t("hangUpCta")}
        </button>
      )}

      {!isLive && payload.estimate_id && (
        <div className="text-[11px] text-zinc-400">
          {t("estimateReady", { id: payload.estimate_id.slice(0, 8) })}
        </div>
      )}
    </div>
  );
}

function TranscriptLine({
  line,
  t,
}: {
  line: CallTranscriptLine;
  t: (k: string) => string;
}) {
  const alignClass =
    line.speaker === "user"
      ? "self-end bg-emerald-900/20 border-emerald-900/40"
      : line.speaker === "six"
        ? "bg-amber-900/20 border-amber-900/40"
        : line.speaker === "system"
          ? "bg-zinc-950/60 border-zinc-800/60 text-zinc-500 italic"
          : "bg-zinc-900/60 border-zinc-800";
  return (
    <li
      className={
        "rounded-md border px-3 py-1.5 max-w-[90%] " + alignClass
      }
    >
      <div className="text-[9px] uppercase tracking-wide text-zinc-500">
        {t(`speaker.${line.speaker}`)}
      </div>
      <p className="text-zinc-100 leading-snug whitespace-pre-wrap">
        {line.text}
      </p>
    </li>
  );
}
