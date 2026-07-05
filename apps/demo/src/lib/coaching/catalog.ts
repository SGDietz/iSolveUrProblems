import { getSupabaseAdminConfig } from "../supabaseAdmin";
import type { CoachingEvaluation, CoachingEventKey } from "./types";

/**
 * M4.8 — Catalog of contractor-side events that fire a positive
 * coaching nudge.
 *
 * Adding a new event = one new evaluator + a tone hint + a registry
 * entry. The cron loop is unchanged. Evaluators return null when the
 * trigger condition isn't met (don't throw — keep the cron pass alive).
 *
 * Initial v1 wires two events that are already represented in our
 * schema. The other build-order events (on-time streak, late
 * cancellation, profile incomplete) are stubbed for follow-ups when
 * the underlying signals get captured.
 */

export type CoachingEvent = {
  key: CoachingEventKey;
  toneHint: string;
  evaluate: (
    contractor_id: string,
  ) => Promise<CoachingEvaluation | null>;
};

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

// ─── Event: First 5-star review ─────────────────────────────────────
//
// Fires once, the very first time we see a 5-star review for this
// contractor. The signature is the review id, so even if more 5-star
// reviews arrive later the catalog won't re-fire "FIRST".

async function evaluateFirstFiveStarReview(
  contractor_id: string,
): Promise<CoachingEvaluation | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const qs = new URLSearchParams();
  qs.set("contractor_id", `eq.${contractor_id}`);
  qs.set("rating", "gte.5");
  qs.set("order", "reviewed_at.asc.nullslast");
  qs.set("limit", "1");
  qs.set("select", "id,reviewer_name,body,reviewed_at");
  const res = await fetch(
    `${url}/rest/v1/contractor_reviews?${qs.toString()}`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{
    id: string;
    reviewer_name: string | null;
    body: string | null;
    reviewed_at: string | null;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    signature: `review:${row.id}`,
    topic: "their first 5-star review",
    facts: {
      reviewer_name: row.reviewer_name,
      review_excerpt: row.body?.slice(0, 240) ?? null,
      reviewed_at: row.reviewed_at,
    },
  };
}

// ─── Event: 3rd repeat customer ─────────────────────────────────────
//
// Distinct paying customers with ≥3 paid contracts. Signature is the
// homeowner uuid so each new repeat customer fires once on its own.

async function evaluateThirdRepeatCustomer(
  contractor_id: string,
): Promise<CoachingEvaluation | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const qs = new URLSearchParams();
  qs.set("contractor_id", `eq.${contractor_id}`);
  qs.set("status", "eq.paid");
  qs.set("select", "user_id,paid_at");
  qs.set("order", "paid_at.asc.nullslast");
  qs.set("limit", "500");
  const res = await fetch(
    `${url}/rest/v1/contracts?${qs.toString()}`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{
    user_id: string;
    paid_at: string | null;
  }>;
  if (rows.length < 3) return null;

  // Per user, find the timestamp of their 3rd paid contract; pick the
  // user whose 3rd-paid landed most recently — that's the freshest
  // "they came back AGAIN" moment.
  const counts = new Map<string, { times: string[] }>();
  for (const r of rows) {
    const slot = counts.get(r.user_id) ?? { times: [] };
    slot.times.push(r.paid_at ?? "");
    counts.set(r.user_id, slot);
  }
  type Repeat = { user_id: string; thirdAt: string };
  const repeats: Repeat[] = [];
  for (const [user_id, slot] of counts.entries()) {
    if (slot.times.length >= 3) {
      repeats.push({ user_id, thirdAt: slot.times[2] || "" });
    }
  }
  if (repeats.length === 0) return null;
  repeats.sort((a, b) => (a.thirdAt < b.thirdAt ? 1 : -1));
  const freshest = repeats[0];
  return {
    signature: `repeat:${freshest.user_id}`,
    topic: "a homeowner has now hired them three times",
    facts: {
      homeowner_id: freshest.user_id,
      third_paid_at: freshest.thirdAt,
      total_repeat_homeowners: repeats.length,
    },
  };
}

export const COACHING_CATALOG: CoachingEvent[] = [
  {
    key: "first_five_star_review",
    toneHint:
      "Celebrate the win without being saccharine. Acknowledge real customers said real things.",
    evaluate: evaluateFirstFiveStarReview,
  },
  {
    key: "third_repeat_customer",
    toneHint:
      "Praise the durability of their reputation — repeat business is the hardest signal to fake.",
    evaluate: evaluateThirdRepeatCustomer,
  },
];

export function getCoachingEvent(
  key: CoachingEventKey,
): CoachingEvent | undefined {
  return COACHING_CATALOG.find((e) => e.key === key);
}
