"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import type {
  AppointmentChecklistRow,
  ChecklistItem,
} from "../../lib/appointments/checklist";

/**
 * M4.3 — Pre-departure checklist tile (per upcoming appointment).
 *
 * Vision ¶24: "rarely forget a tool or the right materials."
 *
 * States:
 *   1. Tier gated (free)  → upsell row, no items
 *   2. Not yet generated  → "Generate" CTA (manual trigger before cron fires)
 *   3. Generated, items   → grouped check-off UI
 *
 * Tier gating happens server-side at generation time; this component
 * trusts the `gated` prop the dashboard hands in.
 */

type Props = {
  appointment_id: string;
  scheduled_at: string;
  agenda: string;
  initial_row: AppointmentChecklistRow | null;
  gated: boolean;
};

function groupByKind(items: ChecklistItem[]) {
  return {
    tool: items.filter((i) => i.kind === "tool"),
    material: items.filter((i) => i.kind === "material"),
    confirmation: items.filter((i) => i.kind === "confirmation"),
  };
}

export function ChecklistTile(props: Props) {
  const t = useTranslations("contractor.dashboard.checklist");
  const [row, setRow] = useState(props.initial_row);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  async function generate(force: boolean) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/appointments/${props.appointment_id}/checklist`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ force }),
        },
      );
      const data = (await res.json()) as {
        row?: AppointmentChecklistRow;
        error?: string;
      };
      if (!res.ok || !data.row) {
        setError(data.error ?? t("errorGeneric"));
        return;
      }
      startTransition(() => setRow(data.row!));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(item: ChecklistItem) {
    if (busy || !row) return;
    const nextChecked = !item.checked_at;
    // Optimistic.
    const optimistic: AppointmentChecklistRow = {
      ...row,
      items: row.items.map((i) =>
        i.id === item.id
          ? {
              ...i,
              checked_at: nextChecked ? new Date().toISOString() : null,
            }
          : i,
      ),
    };
    setRow(optimistic);
    try {
      const res = await fetch(
        `/api/appointments/${props.appointment_id}/checklist/check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ item_id: item.id, checked: nextChecked }),
        },
      );
      const data = (await res.json()) as {
        row?: AppointmentChecklistRow;
        error?: string;
      };
      if (!res.ok || !data.row) {
        setError(data.error ?? t("errorGeneric"));
        setRow(row); // revert
        return;
      }
      setRow(data.row);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errorGeneric"));
      setRow(row); // revert
    }
  }

  const when = new Date(props.scheduled_at).toLocaleString();

  if (props.gated) {
    return (
      <section className="rounded-lg border border-amber-900/40 bg-zinc-950/40 p-3 flex flex-col gap-1.5 text-sm">
        <header className="flex items-baseline justify-between">
          <h3 className="font-semibold text-zinc-100">{t("title")}</h3>
          <span className="text-[11px] uppercase tracking-wide text-amber-300">
            {t("gatedBadge")}
          </span>
        </header>
        <p className="text-xs text-zinc-400">{t("gatedBlurb")}</p>
      </section>
    );
  }

  if (!row) {
    return (
      <section className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 flex flex-col gap-1.5 text-sm">
        <header className="flex items-baseline justify-between">
          <h3 className="font-semibold text-zinc-100">{t("title")}</h3>
          <span className="text-[11px] text-zinc-500 font-mono">{when}</span>
        </header>
        <p className="text-xs text-zinc-500">{t("notYetBlurb")}</p>
        <button
          type="button"
          onClick={() => generate(false)}
          disabled={busy}
          className="self-start rounded-md bg-amber-500/90 hover:bg-amber-500 disabled:opacity-50 text-zinc-950 text-xs font-semibold px-3 py-1.5 mt-1"
        >
          {busy ? t("generating") : t("generateCta")}
        </button>
        {error && <p className="text-xs text-rose-300 font-mono">{error}</p>}
      </section>
    );
  }

  const buckets = groupByKind(row.items);
  const doneCount = row.items.filter((i) => i.checked_at).length;

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 flex flex-col gap-2 text-sm">
      <header className="flex items-baseline justify-between gap-2">
        <h3 className="font-semibold text-zinc-100">
          {t("title")}{" "}
          <span className="text-xs text-zinc-500 font-normal">
            ({doneCount}/{row.items.length})
          </span>
        </h3>
        <span className="text-[11px] text-zinc-500 font-mono">{when}</span>
      </header>

      <Bucket
        label={t("bucket.tool")}
        items={buckets.tool}
        onToggle={toggle}
        busy={busy}
      />
      <Bucket
        label={t("bucket.material")}
        items={buckets.material}
        onToggle={toggle}
        busy={busy}
      />
      <Bucket
        label={t("bucket.confirmation")}
        items={buckets.confirmation}
        onToggle={toggle}
        busy={busy}
      />

      <div className="flex items-baseline justify-between pt-1 border-t border-zinc-900">
        <button
          type="button"
          onClick={() => generate(true)}
          disabled={busy}
          className="text-[11px] text-zinc-500 hover:text-zinc-300 underline"
        >
          {busy ? t("regenerating") : t("regenerateCta")}
        </button>
        <span className="text-[10px] text-zinc-600 font-mono">
          {t("generatedBy", { model: row.model ?? "?" })}
        </span>
      </div>
      {error && <p className="text-xs text-rose-300 font-mono">{error}</p>}
    </section>
  );
}

function Bucket({
  label,
  items,
  onToggle,
  busy,
}: {
  label: string;
  items: ChecklistItem[];
  onToggle: (i: ChecklistItem) => void;
  busy: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <p className="text-[11px] uppercase tracking-wider text-zinc-500">
        {label}
      </p>
      <ul className="flex flex-col gap-0.5">
        {items.map((i) => {
          const done = !!i.checked_at;
          return (
            <li key={i.id}>
              <label
                className={
                  "flex items-center gap-2 cursor-pointer select-none " +
                  (done ? "text-zinc-500 line-through" : "text-zinc-200")
                }
              >
                <input
                  type="checkbox"
                  checked={done}
                  disabled={busy}
                  onChange={() => onToggle(i)}
                  className="accent-amber-500"
                />
                <span className="text-sm">{i.text}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
