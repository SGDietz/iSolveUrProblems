"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  useAssistantSurface,
  type CallPayload,
} from "../../lib/assistantSurface";

/**
 * M4.9 — Start go-between mediation CTA.
 *
 * Vision ¶15: "6 will also manage the in-person meetings as the
 * go-between, live on one or both phones."
 *
 * Rendered on the homeowner side (e.g. inside a ContractorSummary card
 * or an AppointmentCard when the contractor is on-site). Prompts for
 * the homeowner's phone number, POSTs /api/calls/go-between/start,
 * then flips the assistant surface to the CallPanel so the running
 * transcript is visible while 6 mediates.
 *
 * MVP: prompts for phone via native prompt() to keep the surface tiny.
 * A v2 could pre-fill from users.phone once we're threading it.
 */
export function GoBetweenStartButton({
  contractor_id,
  contractor_name,
  contract_id,
  appointment_id,
}: {
  contractor_id: string;
  contractor_name?: string | null;
  contract_id?: string;
  appointment_id?: string;
}) {
  const t = useTranslations("assistant.surface.goBetween");
  const showCall = useAssistantSurface((s) => s.showCall);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (busy) return;
    setError(null);
    const phone = window.prompt(t("phonePrompt"), "+1");
    if (!phone) return;
    const trimmed = phone.trim();
    if (!/^\+[1-9]\d{6,14}$/.test(trimmed)) {
      setError(t("phoneInvalid"));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/calls/go-between/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contractor_id,
          to_user_phone: trimmed,
          contract_id,
          appointment_id,
        }),
      });
      const data = (await res.json()) as {
        call_id?: string;
        error?: string;
      };
      if (!res.ok || !data.call_id) {
        setError(data.error ?? t("errorGeneric"));
        return;
      }
      const payload: CallPayload = {
        call_id: data.call_id,
        status: "dialing",
        contractor_name: contractor_name ?? null,
        contractor_phone: null,
        user_phone: trimmed,
        transcript: [],
        recording_signed_url: null,
        estimate_id: null,
        started_at: null,
        ended_at: null,
        mode: "go_between",
      };
      showCall(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="self-start rounded-md bg-emerald-500/90 hover:bg-emerald-500 disabled:opacity-50 text-zinc-950 text-sm font-semibold px-3 py-2"
      >
        {busy ? t("startingCta") : t("startCta")}
      </button>
      {error && <p className="text-xs text-rose-300 font-mono">{error}</p>}
    </div>
  );
}
