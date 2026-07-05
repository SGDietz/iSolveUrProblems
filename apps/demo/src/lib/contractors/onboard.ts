import { createHash } from "node:crypto";
import { getSupabaseAdminConfig } from "../supabaseAdmin";
import type { ContractorCategorySlug, PriceTier } from "./types";

/**
 * Self-onboarded contractor save (TASK_061 — SUPPLY side).
 *
 * When a real trade pro tells 6 "I'm a plumber and I need work", 6 interviews
 * them by voice (no form) and this helper writes their profile into the SAME
 * `contractors` table the homeowner search reads — tagged so it's never
 * confused with scraped/mock data:
 *   source        = "self_onboarded"
 *   claim_status  = "self_registered"
 *
 * Fails closed: we refuse to write a half-empty profile. 6 must never say
 * "you're signed up" unless a real row landed with the required fields.
 */

export type ContractorOnboardingField =
  | "business_name"
  | "trade"
  | "service_area"
  | "phone_or_email"
  | "licensed"
  | "same_day"
  | "locally_owned";

export type ContractorOnboardingDraft = {
  business_name?: string;
  categories?: ContractorCategorySlug[];
  city?: string;
  state?: string;
  lat?: number;
  lng?: number;
  phone?: string;
  email?: string;
  licensed_flag?: boolean;
  same_day_flag?: boolean;
  locally_owned?: boolean;
  price_tier?: PriceTier | null;
};

export type SelfOnboardedContractorInput = ContractorOnboardingDraft & {
  session_id: string;
  user_id: string | null;
  source_text?: string;
};

export type SelfOnboardedContractorResult =
  | {
      ok: true;
      contractor_id: string;
      source_id: string;
      name: string;
    }
  | { ok: false; reason: string };

const SOURCE = "self_onboarded";
const PG_CONFLICT_TARGET = "source,source_id";

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

function compact(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function buildSourceId(input: SelfOnboardedContractorInput): string {
  const owner = input.user_id
    ? `user:${input.user_id}`
    : `session:${input.session_id}`;
  const identity =
    [
      compact(input.business_name),
      compact(input.phone),
      compact(input.email),
      compact(input.city),
      compact(input.state),
    ]
      .filter(Boolean)
      .join("|") || owner;
  return `${owner}:${stableHash(identity.toLowerCase())}`;
}

/**
 * Which REQUIRED fields are still missing. Only these four gate the save +
 * show as "Still needed" — licensed / same-day / locally-owned are OPTIONAL
 * (captured when the pro volunteers them; never a barrier to joining). Keeps
 * the panel and the save gate honest and consistent (Herm TASK_062 #6), and
 * matches the free, low-friction, people-first onboarding ethos.
 */
export function missingContractorOnboardingFields(
  draft: ContractorOnboardingDraft,
): ContractorOnboardingField[] {
  const missing: ContractorOnboardingField[] = [];
  if (!compact(draft.business_name)) missing.push("business_name");
  if (!draft.categories?.length) missing.push("trade");
  if (!compact(draft.city) && (draft.lat == null || draft.lng == null)) {
    missing.push("service_area");
  }
  if (!compact(draft.phone) && !compact(draft.email)) missing.push("phone_or_email");
  return missing;
}

export async function upsertSelfOnboardedContractor(
  input: SelfOnboardedContractorInput,
): Promise<SelfOnboardedContractorResult> {
  const businessName = compact(input.business_name);
  const categories = input.categories?.filter(Boolean) ?? [];
  const hasServiceArea =
    compact(input.city) || (input.lat != null && input.lng != null);
  const hasContact = compact(input.phone) || compact(input.email);

  if (!businessName) return { ok: false, reason: "missing business name" };
  if (categories.length === 0) return { ok: false, reason: "missing trade/category" };
  if (!hasServiceArea) return { ok: false, reason: "missing service area" };
  if (!hasContact) return { ok: false, reason: "missing phone or email" };

  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return { ok: false, reason: "supabase not configured" };
  }

  const now = new Date().toISOString();
  const sourceId = buildSourceId(input);
  const row = {
    source: SOURCE,
    source_id: sourceId,
    name: businessName,
    phone: compact(input.phone),
    website: null,
    email: compact(input.email),
    address: null,
    city: compact(input.city),
    state: compact(input.state),
    zip: null,
    lat: input.lat ?? null,
    lng: input.lng ?? null,
    categories,
    price_tier: input.price_tier ?? null,
    licensed_flag: input.licensed_flag ?? null,
    same_day_flag: input.same_day_flag ?? null,
    locally_owned: input.locally_owned ?? null,
    rating_avg: null,
    rating_count: null,
    claim_status: "self_registered",
    claimed_by_user_id: input.user_id,
    claimed_at: now,
    last_seen_at: now,
    scraped_payload: {
      source: SOURCE,
      session_id: input.session_id,
      captured_by: "voice_onboarding",
      source_text: input.source_text?.slice(0, 8000) ?? null,
      draft: input,
    },
  };

  const res = await fetch(
    `${url}/rest/v1/contractors?on_conflict=${PG_CONFLICT_TARGET}`,
    {
      method: "POST",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify([row]),
    },
  );

  if (!res.ok) {
    return {
      ok: false,
      reason: `contractors self-onboard upsert ${res.status}: ${await res.text()}`,
    };
  }

  const rows = (await res.json()) as Array<{ id: string; name: string }>;
  const inserted = rows[0];
  if (!inserted) return { ok: false, reason: "upsert returned no row" };

  return {
    ok: true,
    contractor_id: inserted.id,
    source_id: sourceId,
    name: inserted.name,
  };
}
