/**
 * Contractor types — shared between the data layer (M2.1), search
 * (M2.2), summarizer (M2.3), and recommender (M2.4).
 */

export type ContractorCategorySlug =
  | "plumber"
  | "electrician"
  | "hvac"
  | "roofer"
  | "landscaper"
  | "painter"
  | "handyman"
  | "general"
  | "carpenter"
  | "flooring"
  | "appliance"
  | "cleaning"
  | "pest"
  | "garage_door"
  | "window";

export type PriceTier = 1 | 2 | 3 | 4; // Google-style $..$$$$

/** Where a contractor row came from / how verified it is. */
export type ContractorClaimStatus =
  | "unclaimed"
  | "self_registered"
  | "claimed"
  | "verified"
  | (string & {});

/** A row from the public.contractors table. */
export type ContractorRow = {
  id: string;
  source: string;
  source_id: string;
  name: string;
  phone: string | null;
  website: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  lat: number | null;
  lng: number | null;
  categories: string[];
  price_tier: PriceTier | null;
  licensed_flag: boolean | null;
  same_day_flag: boolean | null;
  locally_owned: boolean | null;
  rating_avg: number | null;
  rating_count: number | null;
  claim_status?: ContractorClaimStatus | null;
  claimed_by_user_id?: string | null;
  claimed_at?: string | null;
  stripe_account_id?: string | null;
  stripe_onboarding_status?: string | null;
  license_number?: string | null;
  license_state?: string | null;
  license_status?: string | null;
  last_seen_at: string;
  scraped_payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

/** A row from the public.contractor_reviews table. */
export type ContractorReviewRow = {
  id: string;
  contractor_id: string;
  source: string;
  source_review_id: string;
  rating: number | null;
  body: string | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
  scraped_payload: Record<string, unknown>;
  created_at: string;
};
