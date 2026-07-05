"use client";

import { useCallback, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { notFound } from "next/navigation";

// No default coords (G's reality doctrine 2026-06-30): the search must use
// the user's real location or nothing — never a prefilled Austin center.
// Empty inputs hit the existing locationRequired guard on submit.

type Hit = {
  id: string;
  source: string;
  name: string;
  phone: string | null;
  website: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  categories: string[];
  price_tier: number | null;
  licensed_flag: boolean | null;
  same_day_flag: boolean | null;
  locally_owned: boolean | null;
  rating_avg: number | null;
  rating_count: number | null;
  distance_km: number;
  score: number;
};

type SearchResponse = {
  hits: Hit[];
  total_considered: number;
  error?: string;
};

type SummaryPayload = {
  summary: string;
  strengths_md: string;
  weaknesses_md: string;
  sample_quotes: Array<{ quote: string; rating: number | null }>;
  generated_at?: string;
};

type SummaryResponse = {
  cached?: boolean;
  summary?: SummaryPayload;
  error?: string;
};

type SummaryState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: SummaryPayload; cached: boolean }
  | { status: "error"; message: string };

type RecommendPick = {
  contractor_id: string;
  name: string;
  rating_avg: number | null;
  rating_count: number | null;
  distance_km: number;
  price_tier: number | null;
  locally_owned: boolean | null;
  same_day_flag: boolean | null;
  licensed_flag: boolean | null;
  phone: string | null;
  website: string | null;
  reason: string;
  score: number;
  has_summary: boolean;
};

type RecommendResponse = {
  picks: RecommendPick[];
  considered: number;
  preference_facts: string[];
  error?: string;
};

type RecommendState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; data: RecommendResponse }
  | { status: "error"; message: string };

type PickPersonResult = {
  contractor_id: string;
  name: string;
  channel: string | null;
  delivered: boolean;
  error?: string;
};

type PickResponse = {
  winner: PickPersonResult | null;
  losers: PickPersonResult[];
  total_sent: number;
  total_failed: number;
  error?: string;
};

type PickStatus =
  | { status: "idle" }
  | { status: "loading"; contractor_id: string }
  | { status: "done"; data: PickResponse }
  | { status: "error"; message: string };

type HireStatus =
  | { status: "idle" }
  | { status: "loading"; contractor_id: string }
  | { status: "error"; message: string };

function priceTierGlyph(tier: number | null): string {
  if (!tier || tier < 1) return "—";
  return "$".repeat(Math.min(4, Math.max(1, tier)));
}

export default function SearchClient(props: {
  categories: string[];
  initialCategory: string | null;
}) {
  // Domain guard mirrors the server production guard (hook-free wrapper, same
  // belt-and-suspenders as dev/cards + dev/surface): this debug surface's bare
  // tel:/pick/hire controls must never reach the real domain even if env
  // mirroring changes later (Herm TASK_090).
  const onProdDomain =
    typeof window !== "undefined" &&
    /(^|\.)isolveurproblems\.ai$/i.test(window.location.hostname);
  if (process.env.NEXT_PUBLIC_VERCEL_ENV === "production" || onProdDomain) {
    notFound();
  }
  return <SearchClientInner {...props} />;
}

function SearchClientInner({
  categories,
  initialCategory,
}: {
  categories: string[];
  initialCategory: string | null;
}) {
  const t = useTranslations("contractors");

  const [category, setCategory] = useState<string>(
    initialCategory ?? categories[0],
  );
  const [lat, setLat] = useState<string>("");
  const [lng, setLng] = useState<string>("");
  const [radiusKm, setRadiusKm] = useState<string>("25");
  const [minRating, setMinRating] = useState<string>("4.5");
  const [maxPriceTier, setMaxPriceTier] = useState<string>("");
  const [locallyOwned, setLocallyOwned] = useState<boolean>(false);
  const [sameDay, setSameDay] = useState<boolean>(false);

  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [totalConsidered, setTotalConsidered] = useState<number>(0);

  // Per-card summary state — keyed by contractor id. Lazy-fetched on
  // first expand and cached in memory for the session.
  const [summaries, setSummaries] = useState<Record<string, SummaryState>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const [recommend, setRecommend] = useState<RecommendState>({
    status: "idle",
  });

  const [pick, setPick] = useState<PickStatus>({ status: "idle" });
  const [hire, setHire] = useState<HireStatus>({ status: "idle" });

  const runRecommend = useCallback(async () => {
    const latNum = parseFloat(lat);
    const lngNum = parseFloat(lng);
    const radiusNum = parseFloat(radiusKm) || 25;
    const minRatingNum = parseFloat(minRating);
    const priceNum = maxPriceTier ? parseInt(maxPriceTier, 10) : undefined;

    if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
      setRecommend({
        status: "error",
        message: t("locationRequired"),
      });
      return;
    }

    setRecommend({ status: "loading" });
    try {
      const res = await fetch("/api/contractors/recommend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          near: { lat: latNum, lng: lngNum },
          radius_km: radiusNum,
          min_rating: Number.isNaN(minRatingNum) ? undefined : minRatingNum,
          max_price_tier: priceNum,
          locally_owned: locallyOwned || undefined,
          same_day: sameDay || undefined,
        }),
      });
      const data = (await res.json()) as RecommendResponse;
      if (!res.ok || data.error) {
        setRecommend({
          status: "error",
          message: data.error ?? `Failed (${res.status})`,
        });
      } else {
        setRecommend({ status: "ready", data });
      }
    } catch (err) {
      setRecommend({
        status: "error",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }, [
    category,
    lat,
    lng,
    radiusKm,
    minRating,
    maxPriceTier,
    locallyOwned,
    sameDay,
    t,
  ]);

  const hireContractor = useCallback(
    async (winnerId: string) => {
      const latNum = parseFloat(lat);
      const lngNum = parseFloat(lng);
      const radiusNum = parseFloat(radiusKm) || 25;
      const minRatingNum = parseFloat(minRating);
      const priceNum = maxPriceTier ? parseInt(maxPriceTier, 10) : undefined;
      if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
        setHire({ status: "error", message: t("locationRequired") });
        return;
      }

      const raw =
        typeof window !== "undefined"
          ? window.prompt(t("payment.amountPrompt"), "500")
          : "500";
      if (raw === null) return;
      const dollars = parseFloat(raw);
      if (Number.isNaN(dollars) || dollars < 1) {
        setHire({
          status: "error",
          message: t("payment.amountInvalid"),
        });
        return;
      }
      const amountCents = Math.round(dollars * 100);

      setHire({ status: "loading", contractor_id: winnerId });
      try {
        const res = await fetch("/api/contracts/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            winner_id: winnerId,
            category,
            amount_cents: amountCents,
            search: {
              category,
              near: { lat: latNum, lng: lngNum },
              radius_km: radiusNum,
              min_rating: Number.isNaN(minRatingNum) ? undefined : minRatingNum,
              max_price_tier: priceNum,
              locally_owned: locallyOwned || undefined,
              same_day: sameDay || undefined,
            },
          }),
        });
        const data = (await res.json()) as {
          checkout_url?: string;
          error?: string;
        };
        if (res.status === 401) {
          setHire({
            status: "error",
            message: t("picker.signInRequired"),
          });
          return;
        }
        if (res.status === 503) {
          setHire({
            status: "error",
            message:
              data.error ?? t("payment.notConfigured"),
          });
          return;
        }
        if (res.status === 409) {
          setHire({
            status: "error",
            message:
              data.error ?? t("payment.contractorNotOnboarded"),
          });
          return;
        }
        if (!res.ok || !data.checkout_url) {
          setHire({
            status: "error",
            message: data.error ?? `Failed (${res.status})`,
          });
          return;
        }
        window.location.href = data.checkout_url;
      } catch (err) {
        setHire({
          status: "error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
    [
      category,
      lat,
      lng,
      radiusKm,
      minRating,
      maxPriceTier,
      locallyOwned,
      sameDay,
      t,
    ],
  );

  const pickContractor = useCallback(
    async (winnerId: string) => {
      const latNum = parseFloat(lat);
      const lngNum = parseFloat(lng);
      const radiusNum = parseFloat(radiusKm) || 25;
      const minRatingNum = parseFloat(minRating);
      const priceNum = maxPriceTier ? parseInt(maxPriceTier, 10) : undefined;
      if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
        setPick({ status: "error", message: t("locationRequired") });
        return;
      }
      const confirmed =
        typeof window !== "undefined"
          ? window.confirm(t("picker.confirm"))
          : true;
      if (!confirmed) return;

      setPick({ status: "loading", contractor_id: winnerId });
      try {
        const res = await fetch("/api/contractors/pick", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            winner_id: winnerId,
            category,
            search: {
              category,
              near: { lat: latNum, lng: lngNum },
              radius_km: radiusNum,
              min_rating: Number.isNaN(minRatingNum) ? undefined : minRatingNum,
              max_price_tier: priceNum,
              locally_owned: locallyOwned || undefined,
              same_day: sameDay || undefined,
            },
          }),
        });
        const data = (await res.json()) as PickResponse;
        if (res.status === 401) {
          setPick({
            status: "error",
            message: t("picker.signInRequired"),
          });
          return;
        }
        if (!res.ok || data.error) {
          setPick({
            status: "error",
            message: data.error ?? `Failed (${res.status})`,
          });
          return;
        }
        setPick({ status: "done", data });
      } catch (err) {
        setPick({
          status: "error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    },
    [
      category,
      lat,
      lng,
      radiusKm,
      minRating,
      maxPriceTier,
      locallyOwned,
      sameDay,
      t,
    ],
  );

  const toggleSummary = useCallback(
    async (id: string) => {
      const alreadyOpen = expanded[id] === true;
      setExpanded((prev) => ({ ...prev, [id]: !alreadyOpen }));
      if (alreadyOpen) return;
      if (summaries[id]?.status === "ready") return;

      setSummaries((prev) => ({ ...prev, [id]: { status: "loading" } }));
      try {
        const res = await fetch(`/api/contractors/${id}/summary`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const data = (await res.json()) as SummaryResponse;
        if (!res.ok || data.error || !data.summary) {
          setSummaries((prev) => ({
            ...prev,
            [id]: {
              status: "error",
              message: data.error ?? `Failed (${res.status})`,
            },
          }));
        } else {
          setSummaries((prev) => ({
            ...prev,
            [id]: {
              status: "ready",
              data: data.summary as SummaryPayload,
              cached: data.cached === true,
            },
          }));
        }
      } catch (err) {
        setSummaries((prev) => ({
          ...prev,
          [id]: {
            status: "error",
            message: err instanceof Error ? err.message : "Unknown error",
          },
        }));
      }
    },
    [expanded, summaries],
  );

  const useMyLocation = useCallback(() => {
    if (!navigator.geolocation) {
      setError(t("noGeolocation"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLat(pos.coords.latitude.toFixed(5));
        setLng(pos.coords.longitude.toFixed(5));
      },
      () => setError(t("geolocationDenied")),
    );
  }, [t]);

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setLoading(true);
      setError(null);
      setHits(null);

      const latNum = parseFloat(lat);
      const lngNum = parseFloat(lng);
      const radiusNum = parseFloat(radiusKm) || 25;
      const minRatingNum = parseFloat(minRating);
      const priceNum = maxPriceTier ? parseInt(maxPriceTier, 10) : undefined;

      if (Number.isNaN(latNum) || Number.isNaN(lngNum)) {
        setError(t("locationRequired"));
        setLoading(false);
        return;
      }

      try {
        const res = await fetch("/api/contractors/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            category,
            near: { lat: latNum, lng: lngNum },
            radius_km: radiusNum,
            min_rating: Number.isNaN(minRatingNum) ? undefined : minRatingNum,
            max_price_tier: priceNum,
            locally_owned: locallyOwned || undefined,
            same_day: sameDay || undefined,
          }),
        });
        const data = (await res.json()) as SearchResponse;
        if (!res.ok || data.error) {
          setError(data.error ?? `Search failed (${res.status})`);
        } else {
          setHits(data.hits);
          setTotalConsidered(data.total_considered);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unknown error");
      } finally {
        setLoading(false);
      }
    },
    [
      category,
      lat,
      lng,
      radiusKm,
      minRating,
      maxPriceTier,
      locallyOwned,
      sameDay,
      t,
    ],
  );

  const summary = useMemo(() => {
    if (hits == null) return null;
    if (hits.length === 0) return t("noResults");
    return t("resultsCount", {
      shown: hits.length,
      considered: totalConsidered,
    });
  }, [hits, totalConsidered, t]);

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={onSubmit}
        className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 flex flex-col gap-4"
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-zinc-400 uppercase tracking-wide">
              {t("filters.category")}
            </span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm"
            >
              {categories.map((slug) => (
                <option key={slug} value={slug}>
                  {t(`categoryName.${slug}`)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs">
            <span className="text-zinc-400 uppercase tracking-wide">
              {t("filters.radius")}
            </span>
            <input
              type="number"
              min={1}
              max={200}
              step={1}
              value={radiusKm}
              onChange={(e) => setRadiusKm(e.target.value)}
              className="bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm"
            />
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-zinc-400 uppercase tracking-wide">
              {t("filters.lat")}
            </span>
            <input
              type="text"
              value={lat}
              onChange={(e) => setLat(e.target.value)}
              className="bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm font-mono"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-zinc-400 uppercase tracking-wide">
              {t("filters.lng")}
            </span>
            <input
              type="text"
              value={lng}
              onChange={(e) => setLng(e.target.value)}
              className="bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm font-mono"
            />
          </label>
          <button
            type="button"
            onClick={useMyLocation}
            className="rounded-md bg-zinc-800 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
          >
            {t("filters.useMyLocation")}
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-zinc-400 uppercase tracking-wide">
              {t("filters.minRating")}
            </span>
            <input
              type="number"
              min={0}
              max={5}
              step={0.1}
              value={minRating}
              onChange={(e) => setMinRating(e.target.value)}
              className="bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs">
            <span className="text-zinc-400 uppercase tracking-wide">
              {t("filters.maxPriceTier")}
            </span>
            <select
              value={maxPriceTier}
              onChange={(e) => setMaxPriceTier(e.target.value)}
              className="bg-zinc-950 border border-zinc-700 rounded px-3 py-2 text-sm"
            >
              <option value="">{t("filters.priceAny")}</option>
              <option value="1">$</option>
              <option value="2">$$</option>
              <option value="3">$$$</option>
              <option value="4">$$$$</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={locallyOwned}
              onChange={(e) => setLocallyOwned(e.target.checked)}
            />
            {t("filters.locallyOwned")}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={sameDay}
              onChange={(e) => setSameDay(e.target.checked)}
            />
            {t("filters.sameDay")}
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={loading}
            className="rounded-md bg-amber-400 text-zinc-900 px-4 py-2 text-sm font-medium disabled:opacity-60"
          >
            {loading ? t("searching") : t("search")}
          </button>
          <button
            type="button"
            onClick={runRecommend}
            disabled={recommend.status === "loading"}
            className="rounded-md border border-amber-400/60 text-amber-300 px-4 py-2 text-sm font-medium hover:bg-amber-400/10 disabled:opacity-60"
          >
            {recommend.status === "loading"
              ? t("recommend.thinking")
              : t("recommend.getPicks")}
          </button>
          {summary && <span className="text-sm text-zinc-400">{summary}</span>}
        </div>

        {error && (
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
            {error}
          </div>
        )}
      </form>

      <RecommendPanel
        state={recommend}
        pick={pick}
        hire={hire}
        onPick={pickContractor}
        onHire={hireContractor}
      />
      <HireErrorPanel hire={hire} />
      <PickResultPanel pick={pick} />

      {hits && hits.length > 0 && (
        <ul className="flex flex-col gap-3">
          {hits.map((hit) => (
            <li
              key={hit.id}
              className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4 flex flex-col gap-2"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">{hit.name}</h2>
                <div className="text-xs text-zinc-400 font-mono">
                  {hit.rating_avg != null
                    ? `★ ${hit.rating_avg.toFixed(1)}`
                    : "★ —"}
                  {hit.rating_count != null ? ` (${hit.rating_count})` : ""}
                  {" · "}
                  {hit.distance_km.toFixed(1)} km
                  {" · "}
                  {priceTierGlyph(hit.price_tier)}
                </div>
              </div>
              <div className="text-xs text-zinc-400">
                {[hit.address, hit.city, hit.state, hit.zip]
                  .filter(Boolean)
                  .join(", ")}
              </div>
              <div className="flex flex-wrap gap-2 text-[11px]">
                {hit.licensed_flag && (
                  <span className="rounded bg-emerald-500/15 text-emerald-300 px-2 py-0.5">
                    {t("badge.licensed")}
                  </span>
                )}
                {hit.same_day_flag && (
                  <span className="rounded bg-sky-500/15 text-sky-300 px-2 py-0.5">
                    {t("badge.sameDay")}
                  </span>
                )}
                {hit.locally_owned && (
                  <span className="rounded bg-amber-500/15 text-amber-300 px-2 py-0.5">
                    {t("badge.locallyOwned")}
                  </span>
                )}
                <span className="rounded bg-zinc-800 text-zinc-300 px-2 py-0.5">
                  {t("badge.score", { score: (hit.score * 100).toFixed(0) })}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-300 mt-1">
                {hit.phone && (
                  <a
                    href={`tel:${hit.phone}`}
                    className="underline hover:text-amber-300"
                  >
                    {hit.phone}
                  </a>
                )}
                {hit.website && (
                  <a
                    href={hit.website}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline hover:text-amber-300"
                  >
                    {t("openWebsite")}
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => toggleSummary(hit.id)}
                  className="ml-auto rounded-md bg-zinc-800 px-3 py-1 text-xs text-zinc-200 hover:bg-zinc-700"
                >
                  {expanded[hit.id]
                    ? t("summary.hide")
                    : t("summary.tellMeMore")}
                </button>
                <button
                  type="button"
                  onClick={() => pickContractor(hit.id)}
                  disabled={
                    pick.status === "loading" &&
                    pick.contractor_id === hit.id
                  }
                  className="rounded-md bg-emerald-500/20 border border-emerald-400/40 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-60"
                >
                  {pick.status === "loading" && pick.contractor_id === hit.id
                    ? t("picker.notifying")
                    : t("picker.pickThis")}
                </button>
                <button
                  type="button"
                  onClick={() => hireContractor(hit.id)}
                  disabled={
                    hire.status === "loading" &&
                    hire.contractor_id === hit.id
                  }
                  className="rounded-md bg-amber-400 text-zinc-900 px-3 py-1 text-xs font-medium hover:bg-amber-300 disabled:opacity-60"
                >
                  {hire.status === "loading" && hire.contractor_id === hit.id
                    ? t("payment.starting")
                    : t("payment.hireAndPay")}
                </button>
              </div>

              {expanded[hit.id] && (
                <SummaryPanel state={summaries[hit.id]} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function priceTierGlyphLocal(tier: number | null): string {
  if (!tier || tier < 1) return "—";
  return "$".repeat(Math.min(4, Math.max(1, tier)));
}

function RecommendPanel({
  state,
  pick,
  hire,
  onPick,
  onHire,
}: {
  state: RecommendState;
  pick: PickStatus;
  hire: HireStatus;
  onPick: (id: string) => void;
  onHire: (id: string) => void;
}) {
  const t = useTranslations("contractors");

  if (state.status === "idle") return null;

  if (state.status === "loading") {
    return (
      <div className="rounded-lg border border-amber-400/40 bg-amber-400/5 p-4 text-sm text-amber-200">
        {t("recommend.loading")}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
        {t("recommend.error")}: {state.message}
      </div>
    );
  }

  const { picks, preference_facts } = state.data;
  if (picks.length === 0) {
    return (
      <div className="rounded-lg border border-amber-400/30 bg-zinc-900/40 p-4 text-sm text-zinc-300">
        {t("recommend.empty")}
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-amber-400/40 bg-amber-400/5 p-4 flex flex-col gap-3">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm uppercase tracking-[0.18em] text-amber-300">
          {t("recommend.title")}
        </h2>
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">
          {t("recommend.subtitle", { count: picks.length })}
        </span>
      </header>

      {preference_facts.length > 0 && (
        <p className="text-[11px] text-zinc-500">
          {t("recommend.basedOn")} {preference_facts.slice(0, 3).join(" · ")}
        </p>
      )}

      <ol className="flex flex-col gap-2">
        {picks.map((p, i) => (
          <li
            key={p.contractor_id}
            className="rounded-md bg-zinc-950/50 border border-zinc-800 p-3 flex flex-col gap-1.5"
          >
            <div className="flex items-baseline justify-between gap-2">
              <div className="flex items-baseline gap-2">
                <span className="text-amber-300 font-mono text-xs">
                  #{i + 1}
                </span>
                <span className="font-semibold">{p.name}</span>
              </div>
              <div className="text-xs text-zinc-400 font-mono">
                {p.rating_avg != null ? `★ ${p.rating_avg.toFixed(1)}` : "★ —"}
                {p.rating_count != null ? ` (${p.rating_count})` : ""}
                {" · "}
                {p.distance_km.toFixed(1)} km
                {" · "}
                {priceTierGlyphLocal(p.price_tier)}
              </div>
            </div>
            <p className="text-sm text-zinc-200">{p.reason}</p>
            <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
              {p.phone && (
                <a
                  href={`tel:${p.phone}`}
                  className="underline hover:text-amber-300"
                >
                  {p.phone}
                </a>
              )}
              {p.website && (
                <a
                  href={p.website}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="underline hover:text-amber-300"
                >
                  {t("openWebsite")}
                </a>
              )}
              <button
                type="button"
                onClick={() => onPick(p.contractor_id)}
                disabled={
                  pick.status === "loading" &&
                  pick.contractor_id === p.contractor_id
                }
                className="ml-auto rounded-md bg-emerald-500/20 border border-emerald-400/40 px-3 py-1 text-xs text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-60"
              >
                {pick.status === "loading" &&
                pick.contractor_id === p.contractor_id
                  ? t("picker.notifying")
                  : t("picker.pickThis")}
              </button>
              <button
                type="button"
                onClick={() => onHire(p.contractor_id)}
                disabled={
                  hire.status === "loading" &&
                  hire.contractor_id === p.contractor_id
                }
                className="rounded-md bg-amber-400 text-zinc-900 px-3 py-1 text-xs font-medium hover:bg-amber-300 disabled:opacity-60"
              >
                {hire.status === "loading" &&
                hire.contractor_id === p.contractor_id
                  ? t("payment.starting")
                  : t("payment.hireAndPay")}
              </button>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

function HireErrorPanel({ hire }: { hire: HireStatus }) {
  const t = useTranslations("contractors");
  if (hire.status !== "error") return null;
  return (
    <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
      {t("payment.error")}: {hire.message}
    </div>
  );
}

function PickResultPanel({ pick }: { pick: PickStatus }) {
  const t = useTranslations("contractors");

  if (pick.status === "idle" || pick.status === "loading") return null;

  if (pick.status === "error") {
    return (
      <div className="rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-sm text-rose-200">
        {t("picker.error")}: {pick.message}
      </div>
    );
  }

  const { data } = pick;
  return (
    <div className="rounded-lg border border-emerald-400/40 bg-emerald-400/5 p-4 flex flex-col gap-3">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm uppercase tracking-[0.18em] text-emerald-300">
          {t("picker.title")}
        </h2>
        <span className="text-[10px] uppercase tracking-wide text-zinc-500">
          {t("picker.summary", {
            sent: data.total_sent,
            failed: data.total_failed,
          })}
        </span>
      </header>

      {data.winner && (
        <div className="rounded-md bg-zinc-950/50 border border-zinc-800 p-3 flex flex-col gap-1">
          <div className="text-[11px] uppercase tracking-wide text-emerald-300">
            {t("picker.winnerLabel")}
          </div>
          <div className="flex items-baseline justify-between gap-2">
            <span className="font-semibold">{data.winner.name}</span>
            <span className="text-xs text-zinc-400 font-mono">
              {data.winner.channel ?? "—"} ·{" "}
              {data.winner.delivered
                ? t("picker.delivered")
                : t("picker.failed")}
            </span>
          </div>
          {data.winner.error && (
            <div className="text-[11px] text-rose-300">
              {data.winner.error}
            </div>
          )}
        </div>
      )}

      {data.losers.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="text-[11px] uppercase tracking-wide text-amber-300">
            {t("picker.losersLabel", { count: data.losers.length })}
          </div>
          <ul className="flex flex-col gap-1">
            {data.losers.map((l) => (
              <li
                key={l.contractor_id}
                className="rounded-md bg-zinc-950/40 border border-zinc-800/60 px-3 py-1.5 flex items-center justify-between gap-2 text-xs"
              >
                <span className="truncate">{l.name}</span>
                <span className="text-zinc-400 font-mono shrink-0">
                  {l.channel ?? "—"} ·{" "}
                  {l.delivered ? t("picker.delivered") : t("picker.failed")}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SummaryPanel({ state }: { state: SummaryState | undefined }) {
  const t = useTranslations("contractors");

  if (!state || state.status === "idle") return null;

  if (state.status === "loading") {
    return (
      <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-400">
        {t("summary.loading")}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="mt-2 rounded-md border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200">
        {state.message}
      </div>
    );
  }

  const { data, cached } = state;
  return (
    <div className="mt-2 rounded-md border border-zinc-800 bg-zinc-950/60 p-3 flex flex-col gap-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="text-zinc-200">{data.summary}</p>
        <span className="text-[10px] uppercase tracking-wide text-zinc-500 shrink-0">
          {cached ? t("summary.cached") : t("summary.fresh")}
        </span>
      </div>

      {data.strengths_md.trim() !== "" && (
        <div>
          <h3 className="text-[11px] uppercase tracking-wide text-emerald-300 mb-1">
            {t("summary.strengths")}
          </h3>
          <pre className="whitespace-pre-wrap text-xs text-zinc-300 font-sans">
            {data.strengths_md}
          </pre>
        </div>
      )}

      {data.weaknesses_md.trim() !== "" && (
        <div>
          <h3 className="text-[11px] uppercase tracking-wide text-rose-300 mb-1">
            {t("summary.weaknesses")}
          </h3>
          <pre className="whitespace-pre-wrap text-xs text-zinc-300 font-sans">
            {data.weaknesses_md}
          </pre>
        </div>
      )}

      {data.sample_quotes.length > 0 && (
        <div>
          <h3 className="text-[11px] uppercase tracking-wide text-zinc-400 mb-1">
            {t("summary.sampleQuotes")}
          </h3>
          <ul className="flex flex-col gap-1.5">
            {data.sample_quotes.map((q, i) => (
              <li
                key={i}
                className="text-xs text-zinc-300 border-l-2 border-zinc-700 pl-2"
              >
                <span className="text-zinc-500 mr-1">
                  {q.rating != null ? `★${q.rating}` : "—"}
                </span>
                "{q.quote}"
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
