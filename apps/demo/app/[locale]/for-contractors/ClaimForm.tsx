"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

/**
 * M4.0c — Profile claim form.
 *
 * Strongest path: user enters a state license number. Backend resolves
 * to a contractor row directly and auto-approves (license match is a
 * strong signal — only the license-holder knows their number).
 *
 * Fallback path: user searches by business name on a separate route
 * and picks their profile — TODO post-v1. v1 ships license-number-only.
 *
 * After auto-approval: redirect to /contractor/dashboard.
 * After pending_review: show admin-review message + sign out / wait.
 */

const STATES = [
  { code: "CA", name: "California" },
  // Future: { code: "TX", name: "Texas" }, etc.
];

export default function ClaimForm() {
  const t = useTranslations("forContractors.claim");
  const router = useRouter();
  const [licenseNumber, setLicenseNumber] = useState("");
  const [licenseState, setLicenseState] = useState("CA");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingReview, setPendingReview] = useState<{
    contractor_id: string;
    reasons: string[];
  } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    setPendingReview(null);
    try {
      const res = await fetch("/api/contractors/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          license_number: licenseNumber.trim(),
          license_issuing_state: licenseState,
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        contractor_id?: string;
        status?: "claimed" | "pending_review";
        reasons?: string[];
        error?: string;
      };
      if (!res.ok) {
        setError(data.error ?? t("errorGeneric"));
        return;
      }
      if (data.status === "claimed") {
        router.push("/contractor/dashboard");
      } else if (data.status === "pending_review") {
        setPendingReview({
          contractor_id: data.contractor_id ?? "",
          reasons: data.reasons ?? [],
        });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  if (pendingReview) {
    return (
      <div className="rounded-lg border border-amber-900/60 bg-amber-950/30 p-4 flex flex-col gap-2">
        <p className="text-sm text-amber-200 font-semibold">{t("pending.title")}</p>
        <p className="text-sm text-zinc-200">{t("pending.blurb")}</p>
        {pendingReview.reasons.length > 0 && (
          <p className="text-xs text-zinc-400">
            {t("pending.reasonsLabel")}: {pendingReview.reasons.join(", ")}
          </p>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-zinc-200">{t("stateLabel")}</span>
        <select
          value={licenseState}
          onChange={(e) => setLicenseState(e.target.value)}
          className="rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-100"
          disabled={busy}
        >
          {STATES.map((s) => (
            <option key={s.code} value={s.code}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-zinc-200">{t("licenseLabel")}</span>
        <input
          type="text"
          value={licenseNumber}
          onChange={(e) => setLicenseNumber(e.target.value)}
          placeholder={t("licensePlaceholder")}
          inputMode="numeric"
          autoComplete="off"
          className="rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-zinc-100"
          disabled={busy}
          required
          minLength={3}
          maxLength={20}
        />
        <span className="text-xs text-zinc-500">{t("licenseHelper")}</span>
      </label>
      <button
        type="submit"
        disabled={busy || licenseNumber.trim().length < 3}
        className="rounded-md bg-emerald-500/90 hover:bg-emerald-500 disabled:opacity-50 text-zinc-950 text-sm font-semibold px-4 py-2.5"
      >
        {busy ? t("submitting") : t("submitCta")}
      </button>
      {error && <p className="text-xs text-rose-300 font-mono">{error}</p>}
    </form>
  );
}
