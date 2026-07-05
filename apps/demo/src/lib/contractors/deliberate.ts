import { recallFacts } from "../memory";
import { recommendContractors } from "./recommend";
import type {
  ComparePayload,
  RecommendationCard,
} from "../assistantSurface";

/**
 * M3.8 — Decision-support deliberation engine.
 *
 * Layers on top of M2.4 `recommendContractors` to handle the conversational
 * back-and-forth where a homeowner refines their preferences over multiple
 * voice turns:
 *   - "I can't decide"           → returns top 2 with differentiators
 *   - "only locally-owned ones"  → re-ranks with the added filter
 *   - "closer than 5 km"         → tightens distance, re-ranks
 *   - "not that one"             → excludes a specific contractor, re-ranks
 *
 * Server-side state: NONE. The client passes the accumulated constraints
 * each turn, so the conversation can run multi-turn without sticky state.
 * (Stickiness lives implicitly in the surface snapshot the client maintains.)
 */

export type DeliberateConstraints = {
  /** Hard filters that have been accumulated across turns. */
  locally_owned?: boolean;
  same_day?: boolean;
  min_rating?: number;
  max_price_tier?: 1 | 2 | 3 | 4;
  max_distance_km?: number;
  /** Contractor IDs the user has rejected in this conversation. */
  exclude_ids?: string[];
};

export type DeliberateInput = {
  user_id: string | null;
  category: string;
  /** REQUIRED — the caller must resolve a real ranking center (user coords or
   *  inferred from the visible list) or ask for city/ZIP. No Austin fail-open. */
  near: { lat: number; lng: number };
  /** False when the center was inferred from the visible list, not the user's
   *  own coords — then we never speak a distance. */
  distance_known?: boolean;
  constraints: DeliberateConstraints;
  /**
   * Optional — the picks the user is currently looking at. Used to pick
   * differentiators that are meaningful relative to what's on screen.
   */
  current_pick_ids?: string[];
};

export type DeliberateResult = {
  ok: true;
  payload: ComparePayload;
  /** All the constraints that ended up applied (echoed back for next turn). */
  constraints_applied: DeliberateConstraints;
} | {
  ok: false;
  reason: string;
};

const MAX_PICKS = 2;

/**
 * Build a short human-readable "headline" for each pick describing
 * what makes it distinctive vs the other. Used by both the brain
 * (in narration) and the panel (visible to user).
 */
function buildHeadlines(picks: RecommendationCard[]): string[] {
  if (picks.length < 2) return picks.map(() => "");
  const [a, b] = picks;
  const out: string[] = ["", ""];

  // For each card, identify 1-2 things it has that the other doesn't (or
  // does better on).
  const headline = (
    self: RecommendationCard,
    other: RecommendationCard,
  ): string => {
    const bits: string[] = [];
    if (
      self.rating_avg != null &&
      other.rating_avg != null &&
      self.rating_avg > other.rating_avg + 0.1
    ) {
      bits.push(`higher rated (${self.rating_avg.toFixed(1)})`);
    }
    if (
      self.distance_km > 0 &&
      other.distance_km > 0 &&
      self.distance_km < other.distance_km - 0.5
    ) {
      bits.push(`closer (${self.distance_km.toFixed(1)} km)`);
    }
    if (self.locally_owned && !other.locally_owned) {
      bits.push("locally owned");
    }
    if (self.same_day_flag && !other.same_day_flag) {
      bits.push("same-day available");
    }
    if (
      self.price_tier != null &&
      other.price_tier != null &&
      self.price_tier < other.price_tier
    ) {
      bits.push("lower priced");
    }
    if (
      self.licensed_flag &&
      !other.licensed_flag
    ) {
      bits.push("licensed");
    }
    if (bits.length === 0) bits.push("comparable on most factors");
    return bits.slice(0, 3).join(", ");
  };

  out[0] = headline(a, b);
  out[1] = headline(b, a);
  return out;
}

/** Render the active constraints as user-friendly chips (e.g. "locally owned · same-day"). */
function renderActiveConstraints(c: DeliberateConstraints): string[] {
  const out: string[] = [];
  if (c.locally_owned) out.push("locally owned");
  if (c.same_day) out.push("same-day");
  if (c.min_rating != null) out.push(`≥ ${c.min_rating} stars`);
  if (c.max_price_tier != null) {
    out.push(`≤ ${"$".repeat(c.max_price_tier)}`);
  }
  if (c.max_distance_km != null) out.push(`≤ ${c.max_distance_km} km`);
  if (c.exclude_ids && c.exclude_ids.length > 0) {
    out.push(`excluding ${c.exclude_ids.length} prior`);
  }
  return out;
}

export async function deliberate(
  input: DeliberateInput,
): Promise<DeliberateResult> {
  const near = input.near;
  const c = input.constraints;

  // Pull memory preferences (M1.2) — best-effort, never blocks.
  let preference_facts: string[] = [];
  if (input.user_id) {
    try {
      const facts = await recallFacts({
        userId: input.user_id,
        query: input.category,
      });
      preference_facts = facts
        .filter((f) => f.kind === "preference")
        .map((f) => f.content)
        .slice(0, 3);
    } catch {
      // ignore
    }
  }

  const rec = await recommendContractors({
    userId: input.user_id,
    distance_known: input.distance_known,
    searchInput: {
      category: input.category,
      near,
      radius_km: c.max_distance_km ?? 25,
      min_rating: c.min_rating,
      max_price_tier: c.max_price_tier,
      locally_owned: c.locally_owned,
      same_day: c.same_day,
    },
  });

  if (rec.error || rec.picks.length === 0) {
    return { ok: false, reason: rec.error ?? "no picks matched the constraints" };
  }

  // Apply exclude_ids
  const excluded = new Set(c.exclude_ids ?? []);
  const filtered = rec.picks.filter((p) => !excluded.has(p.contractor_id));

  // Take top N picks
  const topPicks: RecommendationCard[] = filtered
    .slice(0, MAX_PICKS)
    .map((p) => ({
      id: p.contractor_id,
      name: p.name,
      rating_avg: p.rating_avg,
      rating_count: p.rating_count,
      distance_km: p.distance_km,
      price_tier: p.price_tier,
      locally_owned: p.locally_owned,
      same_day_flag: p.same_day_flag,
      licensed_flag: p.licensed_flag,
      phone: p.phone,
      website: p.website,
      score: p.score,
      reason: p.reason,
    }));

  if (topPicks.length === 0) {
    return {
      ok: false,
      reason: "every match was excluded by prior 'not that one' refinements",
    };
  }

  const payload: ComparePayload = {
    picks: topPicks,
    headlines: buildHeadlines(topPicks),
    active_constraints: renderActiveConstraints(c),
    preference_facts,
    state: {
      category: input.category,
      constraints: {
        locally_owned: c.locally_owned,
        same_day: c.same_day,
        min_rating: c.min_rating,
        max_price_tier: c.max_price_tier,
        max_distance_km: c.max_distance_km,
        exclude_ids: c.exclude_ids,
      },
    },
  };

  return {
    ok: true,
    payload,
    constraints_applied: c,
  };
}
