import { OPENAI_API_KEY } from "../../../app/api/secrets";
import { getSupabaseAdminConfig } from "../supabaseAdmin";
import { searchContractors, type ContractorSearchInput } from "./search";
import { getContractorSummary } from "./summaryStore";
import type { ContractorSummaryRow } from "./summaryStore";
import type { ContractorSearchHit } from "./search";

/**
 * 6's recommendation engine (M2.4 — Vision ¶11).
 *
 * Algorithmic score blend (Q2.4a weights):
 *   - rating          × 0.35  (with review-count confidence damping)
 *   - review sentiment × 0.25  (heuristic from cached M2.3 summary)
 *   - distance        × 0.20
 *   - price match     × 0.10  (if user has a price preference)
 *   - licensed        × 0.10
 *
 * Personalization (Q2.4b): pull M1.2 memory facts of kind 'preference'
 * for signed-in users and tilt weights / hard-filters accordingly
 * ("locally-owned", "same-day", "cheap", "quality").
 *
 * LLM reasoning pass: top-5 algorithmic picks are handed to gpt-4o-mini
 * (JSON mode) which picks the final 3 and writes a 1-line reason each.
 * If the LLM call fails, we fall back to templated reasons over the
 * top-3 by algorithmic score.
 */

const RECOMMEND_MODEL = "gpt-4o-mini";

const W_RATING = 0.35;
const W_SENTIMENT = 0.25;
const W_DISTANCE = 0.2;
const W_PRICE = 0.1;
const W_LICENSED = 0.1;

const PICKS = 3;
const ALGO_TOP_N = 5;

export type RecommendInput = {
  userId: string | null;
  searchInput: ContractorSearchInput;
  /**
   * Whether the user's location is actually known. When false (we fell back to
   * a default center because no city was given), we NEVER expose or speak a
   * distance — a defaulted distance is a fake fact (Herm TASK_063 #3).
   */
  distance_known?: boolean;
};

export type RecommendationPick = {
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
  /** Composite score on [0,1]. */
  score: number;
  /** 1-line natural-language reason from the LLM (or templated fallback). */
  reason: string;
  /** Was a cached M2.3 summary available for this contractor? */
  has_summary: boolean;
};

export type RecommendResult = {
  picks: RecommendationPick[];
  considered: number;
  preference_facts: string[];
  error?: string;
};

type PreferenceFact = { content: string };

async function fetchPreferenceFacts(
  userId: string,
): Promise<PreferenceFact[]> {
  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return [];
  }
  try {
    const res = await fetch(
      `${url}/rest/v1/user_memory_facts?user_id=eq.${userId}` +
        `&kind=eq.preference&select=content&order=created_at.desc&limit=20`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        cache: "no-store",
      },
    );
    if (!res.ok) return [];
    return (await res.json()) as PreferenceFact[];
  } catch {
    return [];
  }
}

type PreferenceBias = {
  /** Tilt the search filters before fetching candidates. */
  apply: (input: ContractorSearchInput) => ContractorSearchInput;
  /** Additive score adjustment per candidate, on top of the base score. */
  bonus: (hit: ContractorSearchHit) => number;
  /** Short human-readable summary of what tilted things, for the LLM context. */
  notes: string[];
};

function deriveBias(prefs: PreferenceFact[]): PreferenceBias {
  const blob = prefs.map((p) => p.content.toLowerCase()).join(" | ");
  const notes: string[] = [];
  const wantsLocal = /\b(local|locally[- ]owned|small business|mom[- ]and[- ]pop)\b/.test(blob);
  const wantsSameDay = /\b(same[- ]day|today|urgent|asap|emergency)\b/.test(blob);
  const wantsCheap = /\b(cheap|afford|budget|inexpensive|low[- ]cost)\b/.test(blob);
  const wantsQuality = /\b(quality|best|top[- ]rated|highly rated|reputable)\b/.test(blob);
  if (wantsLocal) notes.push("prefers locally-owned");
  if (wantsSameDay) notes.push("often needs same-day");
  if (wantsCheap) notes.push("budget-conscious");
  if (wantsQuality) notes.push("quality over price");

  return {
    apply: (input) => {
      const next = { ...input };
      if (wantsLocal && next.locally_owned === undefined) {
        // Soft tilt — we still score locally-owned higher rather than
        // hard-excluding others, because a hard filter may zero out
        // the result set on small markets.
      }
      if (wantsCheap && next.max_price_tier === undefined) {
        next.max_price_tier = 2;
      }
      if (wantsQuality && (next.min_rating === undefined || next.min_rating < 4.5)) {
        next.min_rating = 4.5;
      }
      return next;
    },
    bonus: (h) => {
      let b = 0;
      if (wantsLocal && h.locally_owned) b += 0.06;
      if (wantsSameDay && h.same_day_flag) b += 0.05;
      if (wantsCheap && typeof h.price_tier === "number") {
        b += (4 - h.price_tier) * 0.015; // up to +0.045 for $
      }
      return b;
    },
    notes,
  };
}

/** Sentiment 0..1 from cached summary; neutral 0.5 if unsummarized. */
function sentimentFromSummary(s: ContractorSummaryRow | null): number {
  if (!s) return 0.5;
  const strengths = (s.strengths_md.match(/^[-*]/gm) ?? []).length;
  const weaknesses = (s.weaknesses_md.match(/^[-*]/gm) ?? []).length;
  if (strengths + weaknesses === 0) return 0.5;
  return strengths / (strengths + weaknesses);
}

function ratingScore(rating: number | null, count: number | null): number {
  const r = typeof rating === "number" ? (rating - 1) / 4 : 0;
  const conf =
    typeof count === "number" ? Math.min(1, count / 25) : 0;
  return Math.max(0, Math.min(1, r)) * (0.5 + 0.5 * conf);
}

function distanceScore(distance_km: number, radius_km: number): number {
  return Math.max(0, 1 - distance_km / Math.max(radius_km, 1));
}

function priceScore(
  priceTier: number | null,
  maxPriceTier: number | undefined,
): number {
  if (!maxPriceTier || priceTier == null) return 0.5;
  return priceTier <= maxPriceTier ? 1 : 0;
}

function licensedScore(flag: boolean | null): number {
  return flag === true ? 1 : flag === false ? 0 : 0.5;
}

function buildTemplatedReason(
  pick: RecommendationPick,
  notes: string[],
): string {
  const bits: string[] = [];
  if (pick.rating_avg != null && pick.rating_avg >= 4.5) {
    bits.push(`★ ${pick.rating_avg.toFixed(1)} from ${pick.rating_count ?? "?"} reviewers`);
  } else if (pick.rating_avg != null) {
    bits.push(`★ ${pick.rating_avg.toFixed(1)}`);
  }
  // Only state a distance we actually know (> 0). Never "0.0 km away".
  if (pick.distance_km > 0) bits.push(`${pick.distance_km.toFixed(1)} km away`);
  if (pick.locally_owned) bits.push("locally owned");
  if (pick.same_day_flag) bits.push("does same-day");
  if (pick.licensed_flag) bits.push("licensed");
  if (notes.length > 0) bits.push(`fits your preferences (${notes[0]})`);
  return bits.join(" · ");
}

type ScoredCandidate = {
  hit: ContractorSearchHit;
  summary: ContractorSummaryRow | null;
  score: number;
};

export async function recommendContractors(
  input: RecommendInput,
): Promise<RecommendResult> {
  // When location is defaulted (unknown), distance is a fake fact — never
  // expose or speak it (Herm TASK_063 #3).
  const distanceKnown = input.distance_known !== false;
  // 1. Personalization — pull preference facts (best-effort).
  const prefs = input.userId
    ? await fetchPreferenceFacts(input.userId)
    : [];
  const bias = deriveBias(prefs);

  // 2. Run search with bias-tilted filters.
  const tiltedSearchInput = bias.apply({
    ...input.searchInput,
    limit: 20,
  });
  const search = await searchContractors(tiltedSearchInput);
  if (search.error) {
    return {
      picks: [],
      considered: 0,
      preference_facts: prefs.map((p) => p.content),
      error: search.error,
    };
  }
  if (search.hits.length === 0) {
    return {
      picks: [],
      considered: 0,
      preference_facts: prefs.map((p) => p.content),
    };
  }

  // 3. Pull cached summaries in parallel (do not lazy-generate here).
  const summaries = await Promise.all(
    search.hits.map((h) =>
      getContractorSummary(h.id).catch(() => null),
    ),
  );

  // 4. Score each candidate.
  const radiusKm = tiltedSearchInput.radius_km ?? 25;
  const scored: ScoredCandidate[] = search.hits.map((hit, i) => {
    const summary = summaries[i];
    const s =
      W_RATING * ratingScore(hit.rating_avg, hit.rating_count) +
      W_SENTIMENT * sentimentFromSummary(summary) +
      W_DISTANCE * distanceScore(hit.distance_km, radiusKm) +
      W_PRICE *
        priceScore(hit.price_tier, tiltedSearchInput.max_price_tier) +
      W_LICENSED * licensedScore(hit.licensed_flag);
    return { hit, summary, score: s + bias.bonus(hit) };
  });

  scored.sort((a, b) => b.score - a.score);
  const algoTop = scored.slice(0, ALGO_TOP_N);

  // 5. Templated picks as the fallback baseline.
  const fallbackPicks: RecommendationPick[] = algoTop
    .slice(0, PICKS)
    .map((c) => {
      const baseline: RecommendationPick = {
        contractor_id: c.hit.id,
        name: c.hit.name,
        rating_avg: c.hit.rating_avg,
        rating_count: c.hit.rating_count,
        distance_km: distanceKnown ? Number(c.hit.distance_km.toFixed(2)) : 0,
        price_tier: c.hit.price_tier,
        locally_owned: c.hit.locally_owned,
        same_day_flag: c.hit.same_day_flag,
        licensed_flag: c.hit.licensed_flag,
        phone: c.hit.phone,
        website: c.hit.website,
        score: Number(c.score.toFixed(4)),
        reason: "",
        has_summary: c.summary !== null,
      };
      baseline.reason = buildTemplatedReason(baseline, bias.notes);
      return baseline;
    });

  if (!OPENAI_API_KEY || algoTop.length === 0) {
    return {
      picks: fallbackPicks,
      considered: scored.length,
      preference_facts: prefs.map((p) => p.content),
    };
  }

  // 6. LLM picks the final 3 of the top-5 and writes 1-line reasons.
  const candidatePayload = algoTop.map((c) => ({
    id: c.hit.id,
    name: c.hit.name,
    rating_avg: c.hit.rating_avg,
    rating_count: c.hit.rating_count,
    distance_km:
      distanceKnown && c.hit.distance_km > 0
        ? Number(c.hit.distance_km.toFixed(1))
        : null,
    price_tier: c.hit.price_tier,
    locally_owned: c.hit.locally_owned,
    same_day_flag: c.hit.same_day_flag,
    licensed_flag: c.hit.licensed_flag,
    summary: c.summary?.summary ?? null,
    strengths: c.summary?.strengths_md ?? null,
    weaknesses: c.summary?.weaknesses_md ?? null,
    algo_score: Number(c.score.toFixed(3)),
  }));

  const systemPrompt = `You are 6, the iSolveUrProblems assistant.
You receive 5 ranked contractor candidates and the homeowner's stated preferences.
Return a JSON object {"picks":[{"id":string,"reason":string}, ... up to 3]}.
Pick the best 3 candidates from the list (or fewer if only 1–2 stand out).
Each reason MUST be one sentence under 140 characters, written in first person ("I'd go with..." or just descriptive), and ground itself in the candidate's data — rating, distance, price, summary strengths, or the user's preference. Never invent facts not present. Never name a contractor not in the candidates list.`;

  const userPayload = {
    user_preferences: prefs.map((p) => p.content),
    derived_preferences: bias.notes,
    candidates: candidatePayload,
  };

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: RECOMMEND_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.4,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(userPayload) },
        ],
      }),
    });
    if (!res.ok) {
      console.error("recommend LLM error:", await res.text());
      return {
        picks: fallbackPicks,
        considered: scored.length,
        preference_facts: prefs.map((p) => p.content),
      };
    }
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (typeof raw !== "string") {
      return {
        picks: fallbackPicks,
        considered: scored.length,
        preference_facts: prefs.map((p) => p.content),
      };
    }
    const parsed = JSON.parse(raw) as {
      picks?: Array<{ id?: unknown; reason?: unknown }>;
    };
    if (!Array.isArray(parsed.picks)) {
      return {
        picks: fallbackPicks,
        considered: scored.length,
        preference_facts: prefs.map((p) => p.content),
      };
    }
    const byId = new Map(algoTop.map((c) => [c.hit.id, c]));
    const llmPicks: RecommendationPick[] = [];
    for (const p of parsed.picks.slice(0, PICKS)) {
      if (typeof p.id !== "string" || typeof p.reason !== "string") continue;
      const candidate = byId.get(p.id);
      if (!candidate) continue;
      const baseline: RecommendationPick = {
        contractor_id: candidate.hit.id,
        name: candidate.hit.name,
        rating_avg: candidate.hit.rating_avg,
        rating_count: candidate.hit.rating_count,
        // Same honesty rule as the fallback picks: never expose a distance we
        // don't actually know (unknown location → 0, hidden downstream).
        distance_km:
          distanceKnown && candidate.hit.distance_km > 0
            ? Number(candidate.hit.distance_km.toFixed(2))
            : 0,
        price_tier: candidate.hit.price_tier,
        locally_owned: candidate.hit.locally_owned,
        same_day_flag: candidate.hit.same_day_flag,
        licensed_flag: candidate.hit.licensed_flag,
        phone: candidate.hit.phone,
        website: candidate.hit.website,
        score: Number(candidate.score.toFixed(4)),
        reason: p.reason.slice(0, 200),
        has_summary: candidate.summary !== null,
      };
      llmPicks.push(baseline);
    }
    if (llmPicks.length === 0) {
      return {
        picks: fallbackPicks,
        considered: scored.length,
        preference_facts: prefs.map((p) => p.content),
      };
    }
    return {
      picks: llmPicks,
      considered: scored.length,
      preference_facts: prefs.map((p) => p.content),
    };
  } catch (e) {
    console.error("recommend LLM threw:", e);
    return {
      picks: fallbackPicks,
      considered: scored.length,
      preference_facts: prefs.map((p) => p.content),
    };
  }
}
