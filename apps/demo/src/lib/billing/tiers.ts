import {
  STRIPE_PRICE_BRONZE,
  STRIPE_PRICE_GOLD,
  STRIPE_PRICE_SILVER,
} from "../../../app/api/secrets";

/**
 * M4.1 — Tier definitions and gating helpers.
 *
 * Tier hierarchy (Q4.1a — Bert sets final pricing):
 *   free   < bronze < silver < gold
 *
 * Feature gates (referenced by M4.2 / M4.3 / M4.5 / M4.7 / M4.6 etc.):
 *   - basic_dashboard      → free+
 *   - same_day_priority    → bronze+
 *   - checklist_agent      → bronze+
 *   - photo_log            → bronze+
 *   - crew_marketplace     → silver+
 *   - backup_dispatcher    → silver+
 *   - recurring_jobs       → silver+
 *   - cv_labeling          → gold
 *   - coaching_nudges      → gold
 *   - featured_card_slot   → gold
 */

export type Tier = "free" | "bronze" | "silver" | "gold";

const TIER_RANK: Record<Tier, number> = {
  free: 0,
  bronze: 1,
  silver: 2,
  gold: 3,
};

export function tierAtLeast(current: Tier, required: Tier): boolean {
  return TIER_RANK[current] >= TIER_RANK[required];
}

export type TierFeatureGate =
  | "basic_dashboard"
  | "same_day_priority"
  | "checklist_agent"
  | "photo_log"
  | "crew_marketplace"
  | "backup_dispatcher"
  | "recurring_jobs"
  | "cv_labeling"
  | "coaching_nudges"
  | "featured_card_slot";

const FEATURE_GATES: Record<TierFeatureGate, Tier> = {
  basic_dashboard:    "free",
  same_day_priority:  "bronze",
  checklist_agent:    "bronze",
  photo_log:          "bronze",
  crew_marketplace:   "silver",
  backup_dispatcher:  "silver",
  recurring_jobs:     "silver",
  cv_labeling:        "gold",
  coaching_nudges:    "gold",
  featured_card_slot: "gold",
};

export function tierUnlocks(current: Tier, feature: TierFeatureGate): boolean {
  return tierAtLeast(current, FEATURE_GATES[feature]);
}

/**
 * Map a Stripe Price ID back to our tier label. Used by the webhook
 * when a `customer.subscription.created/updated` lands — Stripe sends
 * us the Price ID, we resolve our internal tier.
 */
export function tierFromPriceId(priceId: string | null | undefined): Tier {
  if (!priceId) return "free";
  if (priceId === STRIPE_PRICE_BRONZE) return "bronze";
  if (priceId === STRIPE_PRICE_SILVER) return "silver";
  if (priceId === STRIPE_PRICE_GOLD) return "gold";
  return "free";
}

/**
 * Map a tier label to the Stripe Price ID configured in env. Returns
 * null for `free` (no Stripe object) and for tiers that don't have a
 * Price ID set yet (Bert hasn't created them in the dashboard).
 */
export function priceIdForTier(tier: Tier): string | null {
  switch (tier) {
    case "bronze":
      return STRIPE_PRICE_BRONZE || null;
    case "silver":
      return STRIPE_PRICE_SILVER || null;
    case "gold":
      return STRIPE_PRICE_GOLD || null;
    case "free":
    default:
      return null;
  }
}

/** Statuses that count as "currently has access". */
const ACTIVE_STATUSES = new Set([
  "active",
  "trialing",
  // Past-due gives the contractor a grace period to fix payment without
  // immediately yanking features. Stripe Billing recommends this.
  "past_due",
]);

export function isActiveStatus(status: string | null | undefined): boolean {
  return !!status && ACTIVE_STATUSES.has(status);
}
