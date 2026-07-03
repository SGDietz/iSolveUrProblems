"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import type {
  JobLogEntryView,
  JobLogPhase,
} from "../../lib/jobLogs/types";
import { CvLabelChip } from "./CvLabelChip";

/**
 * M4.5 — Mobile-first capture surface.
 *
 * Single page per appointment. Three top-level buttons:
 *   - Arrival photo
 *   - In-progress photo
 *   - Completion photo
 * Each opens the device camera via `<input capture="environment">`.
 *
 * A "Note" textarea + submit lives below; videos are deferred to v1.1
 * to keep upload semantics simple in v1.
 *
 * Best-effort browser geolocation is captured per submission. Failure
 * is silent — the row just doesn't have GPS attached.
 *
 * Below the capture controls, the running timeline lists existing
 * entries in chronological order with thumbnails.
 */

type Props = {
  appointment_id: string;
  initial_entries: JobLogEntryView[];
};

const PHASES: JobLogPhase[] = ["arrival", "in_progress", "completion"];

type GeoState = {
  lat: number | null;
  lng: number | null;
  acc: number | null;
  attempted: boolean;
};

function captureGeolocation(): Promise<GeoState> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      resolve({ lat: null, lng: null, acc: null, attempted: true });
      return;
    }
    let resolved = false;
    const finish = (state: GeoState) => {
      if (resolved) return;
      resolved = true;
      resolve(state);
    };
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        finish({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          acc: pos.coords.accuracy,
          attempted: true,
        }),
      () => finish({ lat: null, lng: null, acc: null, attempted: true }),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
    );
    setTimeout(
      () => finish({ lat: null, lng: null, acc: null, attempted: true }),
      9000,
    );
  });
}

export function JobLogCapture(props: Props) {
  const t = useTranslations("contractor.jobLog");
  const [entries, setEntries] = useState(props.initial_entries);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activePhase, setActivePhase] = useState<JobLogPhase | null>(null);
  const [noteText, setNoteText] = useState("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // The single hidden file input we re-program when the contractor
  // taps a phase button. Avoids three duplicated inputs in markup.
  function triggerCaptureFor(phase: JobLogPhase) {
    if (busy || !fileInputRef.current) return;
    setActivePhase(phase);
    setError(null);
    fileInputRef.current.value = ""; // reset so re-selecting the same file refires
    fileInputRef.current.click();
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !activePhase) return;
    await upload({
      kind: file.type.startsWith("video/") ? "video" : "photo",
      phase: activePhase,
      file,
    });
    setActivePhase(null);
  }

  async function submitNote() {
    if (!noteText.trim()) return;
    await upload({ kind: "note", phase: null, caption: noteText.trim() });
    setNoteText("");
  }

  async function upload(args: {
    kind: "photo" | "video" | "note";
    phase: JobLogPhase | null;
    file?: File;
    caption?: string;
  }) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const geo = await captureGeolocation();
      const form = new FormData();
      form.set("kind", args.kind);
      if (args.phase) form.set("phase", args.phase);
      if (args.caption) form.set("caption", args.caption);
      if (args.file) form.set("file", args.file);
      if (geo.lat !== null) form.set("gps_lat", String(geo.lat));
      if (geo.lng !== null) form.set("gps_lng", String(geo.lng));
      if (geo.acc !== null) form.set("gps_acc", String(geo.acc));

      const res = await fetch(`/api/jobs/${props.appointment_id}/log`, {
        method: "POST",
        body: form,
      });
      const data = (await res.json()) as {
        row?: JobLogEntryView;
        error?: string;
        required_tier?: string;
      };
      if (!res.ok || !data.row) {
        if (data.error === "tier_gate") {
          setError(t("tierGate"));
        } else {
          setError(data.error ?? t("errorGeneric"));
        }
        return;
      }
      setEntries((prev) => [...prev, data.row!]);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-2">
        <h2 className="text-sm uppercase tracking-wider text-zinc-400">
          {t("captureHeading")}
        </h2>
        <div className="grid grid-cols-3 gap-2">
          {PHASES.map((phase) => {
            const count = entries.filter((e) => e.phase === phase).length;
            return (
              <button
                key={phase}
                type="button"
                onClick={() => triggerCaptureFor(phase)}
                disabled={busy}
                className="flex flex-col items-center justify-center rounded-lg border border-amber-700/40 bg-zinc-950 hover:bg-zinc-900 disabled:opacity-50 p-3 text-amber-200"
              >
                <span className="text-sm font-semibold">
                  {t(`phase.${phase}`)}
                </span>
                <span className="text-[11px] text-zinc-500 mt-0.5">
                  {count > 0 ? t("phaseCount", { count }) : t("phaseEmpty")}
                </span>
              </button>
            );
          })}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,video/*"
          capture="environment"
          className="hidden"
          onChange={handleFile}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm uppercase tracking-wider text-zinc-400">
          {t("noteHeading")}
        </h2>
        <textarea
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          placeholder={t("notePlaceholder")}
          rows={2}
          maxLength={500}
          disabled={busy}
          className="w-full rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-amber-500"
        />
        <button
          type="button"
          onClick={submitNote}
          disabled={busy || !noteText.trim()}
          className="self-end rounded-md bg-amber-500/90 hover:bg-amber-500 disabled:opacity-50 text-zinc-950 text-sm font-semibold px-3 py-1.5"
        >
          {busy ? t("submitting") : t("addNoteCta")}
        </button>
      </section>

      {error && (
        <p className="text-sm text-rose-300 font-mono break-all">{error}</p>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm uppercase tracking-wider text-zinc-400">
          {t("timelineHeading")}{" "}
          <span className="text-zinc-600">({entries.length})</span>
        </h2>
        {entries.length === 0 ? (
          <p className="text-sm italic text-zinc-500">{t("timelineEmpty")}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {entries.map((e) => (
              <li
                key={e.id}
                className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-2 flex gap-3"
              >
                {e.kind === "photo" && e.signed_url && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={e.signed_url}
                    alt=""
                    className="h-20 w-20 rounded object-cover flex-shrink-0 bg-zinc-900"
                  />
                )}
                {e.kind === "video" && e.signed_url && (
                  <video
                    src={e.signed_url}
                    className="h-20 w-20 rounded object-cover flex-shrink-0 bg-zinc-900"
                    muted
                    playsInline
                    controls
                  />
                )}
                {e.kind === "note" && (
                  <div className="h-20 w-20 rounded flex-shrink-0 bg-zinc-900 flex items-center justify-center text-zinc-500 text-xs">
                    {t("noteLabel")}
                  </div>
                )}
                <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                  <div className="flex items-baseline gap-2 text-[11px] text-zinc-500 font-mono">
                    <span>{new Date(e.taken_at).toLocaleString()}</span>
                    {e.phase && (
                      <span className="text-amber-300">
                        {t(`phase.${e.phase}`)}
                      </span>
                    )}
                    {e.gps_lat !== null && e.gps_lng !== null && (
                      <span>
                        {e.gps_lat.toFixed(4)}, {e.gps_lng.toFixed(4)}
                      </span>
                    )}
                  </div>
                  {e.caption && (
                    <p className="text-sm text-zinc-200 break-words">
                      {e.caption}
                    </p>
                  )}
                  {e.kind === "photo" && (
                    <CvLabelChip
                      appointment_id={props.appointment_id}
                      entry_id={e.id}
                    />
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
