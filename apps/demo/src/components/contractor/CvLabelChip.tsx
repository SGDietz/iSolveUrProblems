"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { CvLabelRow } from "../../lib/vision";

/**
 * M4.6 — Sticky "identify this" / confirm-or-correct chip.
 *
 * Rendered inline on each photo entry in JobLogCapture (gold-tier
 * contractors only — non-gold contractors will get 402 from the
 * classify route and the chip surfaces the tier gate as a hint).
 *
 * Flow:
 *   1. On mount, GET the latest cv_label for this entry. If already
 *      confirmed, render the confirmed label with a checkmark and stop.
 *   2. If a pending prediction exists, render label + yes/no.
 *   3. If no prediction yet, render an "Identify" button.
 *   4. "No" reveals a small text input for the corrected label.
 */

type Props = {
  appointment_id: string;
  entry_id: string;
};

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "predicted"; row: CvLabelRow }
  | { kind: "correcting"; row: CvLabelRow; input: string }
  | { kind: "confirmed"; row: CvLabelRow }
  | { kind: "gated" }
  | { kind: "error"; message: string };

export function CvLabelChip(props: Props) {
  const t = useTranslations("contractor.jobLog.cv");
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [busy, setBusy] = useState(false);

  const classifyUrl = `/api/jobs/${props.appointment_id}/log/${props.entry_id}/classify`;
  const confirmUrl = `${classifyUrl}/confirm`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(classifyUrl);
        if (cancelled) return;
        if (res.status === 402) {
          setPhase({ kind: "gated" });
          return;
        }
        if (!res.ok) {
          setPhase({ kind: "idle" });
          return;
        }
        const data = (await res.json()) as { row: CvLabelRow | null };
        if (!data.row) {
          setPhase({ kind: "idle" });
          return;
        }
        if (data.row.confirmed_label) {
          setPhase({ kind: "confirmed", row: data.row });
        } else {
          setPhase({ kind: "predicted", row: data.row });
        }
      } catch {
        if (!cancelled) setPhase({ kind: "idle" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [classifyUrl]);

  async function runClassify() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(classifyUrl, { method: "POST" });
      const data = (await res.json()) as {
        row?: CvLabelRow;
        error?: string;
      };
      if (res.status === 402) {
        setPhase({ kind: "gated" });
        return;
      }
      if (!res.ok || !data.row) {
        setPhase({
          kind: "error",
          message: data.error ?? t("errorGeneric"),
        });
        return;
      }
      setPhase({ kind: "predicted", row: data.row });
    } catch (e) {
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : t("errorGeneric"),
      });
    } finally {
      setBusy(false);
    }
  }

  async function submitConfirm(args: {
    row: CvLabelRow;
    correct: boolean;
    corrected_label?: string;
  }) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(confirmUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cv_label_id: args.row.id,
          correct: args.correct,
          corrected_label: args.corrected_label,
        }),
      });
      const data = (await res.json()) as {
        row?: CvLabelRow;
        error?: string;
      };
      if (!res.ok || !data.row) {
        setPhase({
          kind: "error",
          message: data.error ?? t("errorGeneric"),
        });
        return;
      }
      setPhase({ kind: "confirmed", row: data.row });
    } catch (e) {
      setPhase({
        kind: "error",
        message: e instanceof Error ? e.message : t("errorGeneric"),
      });
    } finally {
      setBusy(false);
    }
  }

  if (phase.kind === "loading") {
    return (
      <p className="text-[11px] text-zinc-500 italic">{t("loading")}</p>
    );
  }
  if (phase.kind === "gated") {
    return (
      <p className="text-[11px] text-zinc-500 italic">{t("tierGate")}</p>
    );
  }
  if (phase.kind === "idle") {
    return (
      <button
        type="button"
        onClick={runClassify}
        disabled={busy}
        className="self-start rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-200 text-[11px] px-2 py-1 font-semibold"
      >
        {busy ? t("classifying") : t("identifyCta")}
      </button>
    );
  }
  if (phase.kind === "predicted") {
    return (
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline gap-2 text-[11px]">
          <span className="text-zinc-400">{t("predictedLabel")}</span>
          <span className="font-semibold text-amber-200">
            {phase.row.predicted_label}
          </span>
          <span className="text-zinc-500 font-mono">
            {t(`confidence.${phase.row.predicted_confidence}`)}
          </span>
        </div>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() =>
              submitConfirm({ row: phase.row, correct: true })
            }
            disabled={busy}
            className="rounded-md bg-emerald-500/90 hover:bg-emerald-500 disabled:opacity-50 text-zinc-950 text-[11px] px-2 py-1 font-semibold"
          >
            {t("yesCta")}
          </button>
          <button
            type="button"
            onClick={() =>
              setPhase({ kind: "correcting", row: phase.row, input: "" })
            }
            disabled={busy}
            className="rounded-md bg-rose-500/90 hover:bg-rose-500 disabled:opacity-50 text-zinc-950 text-[11px] px-2 py-1 font-semibold"
          >
            {t("noCta")}
          </button>
        </div>
      </div>
    );
  }
  if (phase.kind === "correcting") {
    return (
      <form
        className="flex flex-wrap items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!phase.input.trim()) return;
          submitConfirm({
            row: phase.row,
            correct: false,
            corrected_label: phase.input.trim(),
          });
        }}
      >
        <input
          type="text"
          value={phase.input}
          onChange={(e) =>
            setPhase({ ...phase, input: e.target.value })
          }
          placeholder={t("correctionPlaceholder")}
          maxLength={60}
          className="rounded-md bg-zinc-950 border border-zinc-800 text-[11px] text-zinc-100 px-2 py-1 focus:outline-none focus:border-amber-500"
        />
        <button
          type="submit"
          disabled={busy || !phase.input.trim()}
          className="rounded-md bg-amber-500/90 hover:bg-amber-500 disabled:opacity-50 text-zinc-950 text-[11px] px-2 py-1 font-semibold"
        >
          {t("saveCorrectionCta")}
        </button>
      </form>
    );
  }
  if (phase.kind === "confirmed") {
    return (
      <p className="text-[11px] text-emerald-300">
        {t("confirmedPrefix")}{" "}
        <span className="font-semibold">{phase.row.confirmed_label}</span>
      </p>
    );
  }
  return (
    <p className="text-[11px] text-rose-300 font-mono break-all">
      {phase.message}
    </p>
  );
}
