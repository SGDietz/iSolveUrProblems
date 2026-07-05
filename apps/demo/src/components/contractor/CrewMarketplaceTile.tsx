"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import type {
  CrewInvitationView,
  CrewRequestRow,
  CrewResponseWithInvitee,
} from "../../lib/crew/types";

/**
 * M4.2 — Crew marketplace dashboard tile.
 *
 * Three sections:
 *   1. "Find help" form — pick category, needed_at, radius, scope.
 *      POST /api/crew/requests → returns { request, fanout }.
 *   2. Outgoing requests — the contractor's own open requests + per-
 *      response summary (invitee names, status).
 *   3. Incoming invitations — other contractors have invited THIS
 *      contractor to help on their jobs. Accept / decline actions.
 *
 * Tier gate: silver+ (crew_marketplace). When gated we render just the
 * upsell state; the parent decides whether to mount us at all.
 */

const CATEGORIES = [
  "plumber",
  "electrician",
  "hvac",
  "roofer",
  "landscaper",
  "painter",
  "handyman",
  "general",
  "carpenter",
  "flooring",
  "appliance",
  "cleaning",
  "pest",
  "garage_door",
  "window",
];

type OutgoingRequest = {
  request: CrewRequestRow;
  responses: CrewResponseWithInvitee[];
};

type Props = {
  gated: boolean;
  initial_outgoing: OutgoingRequest[];
  initial_incoming: CrewInvitationView[];
};

export function CrewMarketplaceTile(props: Props) {
  const t = useTranslations("contractor.dashboard.crew");
  const [gated] = useState(props.gated);
  const [outgoing, setOutgoing] = useState(props.initial_outgoing);
  const [incoming, setIncoming] = useState(props.initial_incoming);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [neededAt, setNeededAt] = useState(defaultNeededAt());
  const [radiusKm, setRadiusKm] = useState(40);
  const [scope, setScope] = useState("");

  const defaultDateTimeLocalMin = useMemo(
    () => new Date(Date.now() + 15 * 60 * 1000).toISOString().slice(0, 16),
    [],
  );

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const iso = new Date(neededAt).toISOString();
      const res = await fetch("/api/crew/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          needed_at: iso,
          radius_km: radiusKm,
          scope: scope.trim() || undefined,
        }),
      });
      const data = (await res.json()) as {
        request?: CrewRequestRow;
        fanout?: {
          request_id: string;
          invited: Array<{
            contractor_id: string;
            name: string;
            email: string | null;
            delivered: boolean;
            rank_score: number;
            distance_km: number | null;
          }>;
        };
        error?: string;
      };
      if (!res.ok || !data.request) {
        if (data.error === "tier_gate") setError(t("errorTier"));
        else setError(data.error ?? t("errorGeneric"));
        return;
      }
      const responses: CrewResponseWithInvitee[] = (data.fanout?.invited ?? []).map(
        (i) => ({
          id: `${data.request!.id}:${i.contractor_id}`,
          crew_request_id: data.request!.id,
          invitee_contractor_id: i.contractor_id,
          rank_score: i.rank_score,
          distance_km: i.distance_km,
          status: "invited" as const,
          notification_row_id: null,
          responded_at: null,
          context: {},
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          invitee_name: i.name,
          invitee_city: null,
          invitee_state: null,
          invitee_phone: null,
          invitee_email: i.email,
        }),
      );
      setOutgoing((prev) => [
        { request: data.request!, responses },
        ...prev,
      ]);
      setScope("");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  async function respond(response_id: string, action: "accept" | "decline") {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/crew/responses/${response_id}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json()) as {
        row?: { status: string };
        filled?: boolean;
        reason?: string;
        error?: string;
      };
      if (!res.ok) {
        setError(
          data.reason === "already_filled" ? t("errorAlreadyFilled") : data.error ?? t("errorGeneric"),
        );
        // Even on already_filled the server marked the row as
        // declined; sync UI so it doesn't keep offering Accept.
        setIncoming((prev) =>
          prev.map((inv) =>
            inv.id === response_id ? { ...inv, status: "declined" } : inv,
          ),
        );
        return;
      }
      setIncoming((prev) =>
        prev.map((inv) =>
          inv.id === response_id
            ? {
                ...inv,
                status: action === "accept" ? "accepted" : "declined",
                responded_at: new Date().toISOString(),
              }
            : inv,
        ),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : t("errorGeneric"));
    } finally {
      setBusy(false);
    }
  }

  if (gated) {
    return (
      <section className="rounded-lg border border-amber-900/40 bg-zinc-950/40 p-4 flex flex-col gap-2 text-sm">
        <header className="flex items-baseline justify-between">
          <h2 className="text-lg font-semibold text-zinc-100">{t("title")}</h2>
          <span className="text-[11px] uppercase tracking-wide text-amber-300">
            {t("gatedBadge")}
          </span>
        </header>
        <p className="text-xs text-zinc-400">{t("gatedBlurb")}</p>
      </section>
    );
  }

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-950/40 p-4 flex flex-col gap-4 text-sm">
      <header className="flex items-baseline justify-between">
        <h2 className="text-lg font-semibold text-zinc-100">{t("title")}</h2>
        <span className="text-[11px] uppercase tracking-wide text-emerald-300">
          {t("silverPlus")}
        </span>
      </header>

      {/* Form */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">
            {t("form.category")}
          </span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100"
            disabled={busy}
          >
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">
            {t("form.neededAt")}
          </span>
          <input
            type="datetime-local"
            value={neededAt}
            min={defaultDateTimeLocalMin}
            onChange={(e) => setNeededAt(e.target.value)}
            className="rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100"
            disabled={busy}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">
            {t("form.radiusKm")}
          </span>
          <input
            type="number"
            min={1}
            max={200}
            value={radiusKm}
            onChange={(e) => setRadiusKm(parseInt(e.target.value, 10) || 40)}
            className="rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100"
            disabled={busy}
          />
        </label>
        <label className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-[11px] uppercase tracking-wider text-zinc-500">
            {t("form.scope")}
          </span>
          <textarea
            rows={2}
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            placeholder={t("form.scopePlaceholder")}
            className="rounded-md bg-zinc-950 border border-zinc-800 px-3 py-2 text-sm text-zinc-100"
            disabled={busy}
            maxLength={500}
          />
        </label>
      </div>
      <button
        type="button"
        onClick={submit}
        disabled={busy || !neededAt || !category}
        className="self-start rounded-md bg-amber-500/90 hover:bg-amber-500 disabled:opacity-50 text-zinc-950 text-sm font-semibold px-4 py-2"
      >
        {busy ? t("form.submitting") : t("form.submitCta")}
      </button>
      {error && <p className="text-xs text-rose-300 font-mono">{error}</p>}

      {/* Outgoing */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm uppercase tracking-wider text-zinc-500">
          {t("outgoing.title")}{" "}
          <span className="text-zinc-600">({outgoing.length})</span>
        </h3>
        {outgoing.length === 0 ? (
          <p className="text-xs italic text-zinc-500">{t("outgoing.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {outgoing.map((o) => (
              <li
                key={o.request.id}
                className="rounded border border-zinc-800 bg-zinc-950/60 p-2 flex flex-col gap-1"
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-sm font-semibold text-zinc-100 capitalize">
                    {o.request.category.replace(/_/g, " ")}
                  </span>
                  <span
                    className={
                      "text-[10px] uppercase font-mono " +
                      (o.request.status === "filled"
                        ? "text-emerald-300"
                        : o.request.status === "open"
                          ? "text-amber-300"
                          : "text-zinc-500")
                    }
                  >
                    {t(`outgoing.status.${o.request.status}`)}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500 font-mono">
                  {new Date(o.request.needed_at).toLocaleString()} ·{" "}
                  {o.request.radius_km} km
                </p>
                {o.request.scope && (
                  <p className="text-xs text-zinc-300">{o.request.scope}</p>
                )}
                <ul className="text-[11px] text-zinc-400 mt-1 flex flex-col gap-0.5">
                  {o.responses.map((r) => (
                    <li key={r.id} className="flex items-baseline gap-2">
                      <span className="w-3 h-3 rounded-full inline-block"
                        style={{
                          background:
                            r.status === "accepted"
                              ? "#22c55e"
                              : r.status === "declined"
                                ? "#71717a"
                                : "#facc15",
                        }}
                      />
                      <span className="flex-1">
                        {r.invitee_name}
                        {r.invitee_city ? ` · ${r.invitee_city}` : ""}
                      </span>
                      <span className="text-[10px] uppercase text-zinc-500">
                        {t(`outgoing.responseStatus.${r.status}`)}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Incoming */}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm uppercase tracking-wider text-zinc-500">
          {t("incoming.title")}{" "}
          <span className="text-zinc-600">({incoming.length})</span>
        </h3>
        {incoming.length === 0 ? (
          <p className="text-xs italic text-zinc-500">{t("incoming.empty")}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {incoming.map((inv) => (
              <li
                key={inv.id}
                className="rounded border border-zinc-800 bg-zinc-950/60 p-2 flex flex-col gap-1"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-semibold text-zinc-100">
                    {inv.requester_name}
                  </span>
                  <span className="text-[10px] uppercase font-mono text-zinc-500">
                    {t(`incoming.status.${inv.status}`)}
                  </span>
                </div>
                <p className="text-[11px] text-zinc-500 font-mono capitalize">
                  {inv.request.category.replace(/_/g, " ")} ·{" "}
                  {new Date(inv.request.needed_at).toLocaleString()}
                </p>
                {inv.request.scope && (
                  <p className="text-xs text-zinc-300">{inv.request.scope}</p>
                )}
                {inv.status === "invited" && (
                  <div className="flex gap-2 mt-1">
                    <button
                      type="button"
                      onClick={() => respond(inv.id, "accept")}
                      disabled={busy}
                      className="rounded-md bg-emerald-500/90 hover:bg-emerald-500 disabled:opacity-50 text-zinc-950 text-xs font-semibold px-3 py-1"
                    >
                      {t("incoming.acceptCta")}
                    </button>
                    <button
                      type="button"
                      onClick={() => respond(inv.id, "decline")}
                      disabled={busy}
                      className="rounded-md bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-zinc-300 text-xs px-3 py-1"
                    >
                      {t("incoming.declineCta")}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function defaultNeededAt(): string {
  // 2 hours from now, rounded to nearest 15 min, in local datetime-local format.
  const d = new Date(Date.now() + 2 * 3600 * 1000);
  d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
