import { getSupabaseAdminConfig } from "../supabaseAdmin";

/**
 * M4.0c — Contractor profile claim.
 *
 * Q4.0c (layered verification):
 *
 *   Strong signals (auto-approve when any one matches):
 *     - Email match: the authenticated user's email == contractor.email
 *     - License-number match: the user provides a license number that
 *       maps to a contractor row in a state where we've ingested
 *       license-board data
 *
 *   Medium signal (auto-approve when paired with email OR phone match):
 *     - Owner name match: the user's full_name == contractor.scraped_payload.owner_name
 *
 *   Weak signal (pending_review):
 *     - Anything else (e.g. just a contractor_id with no other proof)
 *
 * Q4.0d gate: a successful claim sets users.role='contractor' AND
 * users.contractor_id, but Stripe Connect onboarding still requires
 * admin approval before payouts are enabled (already true via M2.5's
 * stripe_charges_enabled gate).
 */

type ContractorClaimRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  license_number: string | null;
  license_issuing_state: string | null;
  claim_status: "unclaimed" | "pending_review" | "claimed" | "rejected";
  claimed_by_user_id: string | null;
  scraped_payload: Record<string, unknown>;
};

type ClaimerProfile = {
  id: string;
  email: string | null;
  full_name: string | null;
  phone: string | null;
};

export type ClaimOutcome =
  | { kind: "auto_approved"; contractor_id: string }
  | { kind: "pending_review"; contractor_id: string; reasons: string[] }
  | { kind: "rejected"; reason: string }
  | { kind: "invalid"; reason: string };

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

async function fetchClaimer(userId: string): Promise<ClaimerProfile | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/users?id=eq.${encodeURIComponent(userId)}&select=id,email,full_name,phone&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as ClaimerProfile[];
  return rows[0] ?? null;
}

async function fetchContractorByLicense(args: {
  license_number: string;
  state: string;
}): Promise<ContractorClaimRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const qs = new URLSearchParams();
  qs.set("license_number", `eq.${args.license_number}`);
  qs.set("license_issuing_state", `eq.${args.state}`);
  qs.set(
    "select",
    "id,name,email,phone,license_number,license_issuing_state,claim_status,claimed_by_user_id,scraped_payload",
  );
  qs.set("limit", "1");
  const res = await fetch(`${url}/rest/v1/contractors?${qs.toString()}`, {
    headers: adminHeaders(serviceRoleKey),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as ContractorClaimRow[];
  return rows[0] ?? null;
}

async function fetchContractorById(
  id: string,
): Promise<ContractorClaimRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(id)}&select=id,name,email,phone,license_number,license_issuing_state,claim_status,claimed_by_user_id,scraped_payload&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as ContractorClaimRow[];
  return rows[0] ?? null;
}

function normalizeEmail(s: string | null | undefined): string {
  return (s ?? "").trim().toLowerCase();
}

function matchScore(args: {
  claimer: ClaimerProfile;
  contractor: ContractorClaimRow;
}): { score: "strong" | "medium" | "weak"; reasons: string[] } {
  const reasons: string[] = [];
  let strong = 0;

  if (
    args.contractor.email &&
    args.claimer.email &&
    normalizeEmail(args.contractor.email) === normalizeEmail(args.claimer.email)
  ) {
    strong += 1;
    reasons.push("email match");
  }

  // License-number match is strong by construction — we already lookup
  // by license_number when license was provided. Caller can mark this
  // when it's the lookup path.

  let medium = 0;
  const ownerName =
    typeof args.contractor.scraped_payload?.owner_name === "string"
      ? (args.contractor.scraped_payload.owner_name as string).trim().toLowerCase()
      : null;
  if (
    ownerName &&
    args.claimer.full_name &&
    args.claimer.full_name.trim().toLowerCase() === ownerName
  ) {
    medium += 1;
    reasons.push("owner-name match");
  }
  if (
    args.contractor.phone &&
    args.claimer.phone &&
    args.contractor.phone === args.claimer.phone
  ) {
    medium += 1;
    reasons.push("phone match");
  }

  if (strong >= 1) return { score: "strong", reasons };
  if (medium >= 2) return { score: "strong", reasons };
  if (medium === 1) return { score: "medium", reasons };
  return { score: "weak", reasons };
}

async function recordAttempt(args: {
  contractor_id: string | null;
  attempted_by_user_id: string;
  signals: Record<string, unknown>;
  outcome: "auto_approved" | "pending_review" | "rejected" | "invalid";
  reason?: string;
}): Promise<void> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  await fetch(`${url}/rest/v1/contractor_claim_attempts`, {
    method: "POST",
    headers: { ...adminHeaders(serviceRoleKey), Prefer: "return=minimal" },
    body: JSON.stringify([
      {
        contractor_id: args.contractor_id,
        attempted_by_user_id: args.attempted_by_user_id,
        signals: args.signals,
        outcome: args.outcome,
        reason: args.reason ?? null,
      },
    ]),
  }).catch(() => null);
}

async function markContractorClaimed(args: {
  contractor_id: string;
  user_id: string;
  status: "claimed" | "pending_review";
}): Promise<boolean> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const patch: Record<string, unknown> = {
    claim_status: args.status,
    claimed_by_user_id: args.user_id,
  };
  if (args.status === "claimed") {
    patch.claimed_at = new Date().toISOString();
  }
  const res = await fetch(
    `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(args.contractor_id)}`,
    {
      method: "PATCH",
      headers: { ...adminHeaders(serviceRoleKey), Prefer: "return=minimal" },
      body: JSON.stringify(patch),
    },
  );
  return res.ok;
}

async function linkUserToContractor(args: {
  user_id: string;
  contractor_id: string;
}): Promise<boolean> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/users?id=eq.${encodeURIComponent(args.user_id)}`,
    {
      method: "PATCH",
      headers: { ...adminHeaders(serviceRoleKey), Prefer: "return=minimal" },
      body: JSON.stringify({
        role: "contractor",
        contractor_id: args.contractor_id,
      }),
    },
  );
  return res.ok;
}

/**
 * Top-level claim attempt.
 *
 * Resolves the contractor row in priority order:
 *   1. By license_number + state (strong signal regardless of other matches)
 *   2. By explicit contractor_id (the user picked from a search result)
 *
 * Then applies the layered match logic.
 */
export async function attemptClaim(args: {
  user_id: string;
  contractor_id?: string | null;
  license_number?: string | null;
  license_issuing_state?: string | null;
}): Promise<ClaimOutcome> {
  const claimer = await fetchClaimer(args.user_id);
  if (!claimer) {
    return { kind: "invalid", reason: "claimer profile not found" };
  }

  let contractor: ContractorClaimRow | null = null;
  let licenseLookup = false;

  if (args.license_number && args.license_issuing_state) {
    contractor = await fetchContractorByLicense({
      license_number: args.license_number.trim(),
      state: args.license_issuing_state.toUpperCase(),
    });
    licenseLookup = !!contractor;
  }
  if (!contractor && args.contractor_id) {
    contractor = await fetchContractorById(args.contractor_id);
  }

  if (!contractor) {
    await recordAttempt({
      contractor_id: null,
      attempted_by_user_id: args.user_id,
      signals: args,
      outcome: "invalid",
      reason: "no matching contractor row",
    });
    return {
      kind: "invalid",
      reason: "no matching contractor row found — check license number / state",
    };
  }

  // Already claimed by someone else?
  if (
    contractor.claim_status === "claimed" &&
    contractor.claimed_by_user_id !== null &&
    contractor.claimed_by_user_id !== args.user_id
  ) {
    await recordAttempt({
      contractor_id: contractor.id,
      attempted_by_user_id: args.user_id,
      signals: args,
      outcome: "rejected",
      reason: "already claimed by another user",
    });
    return {
      kind: "rejected",
      reason:
        "this contractor profile has already been claimed. If you believe this is in error, contact support.",
    };
  }

  // Re-claim by the same user — idempotent success.
  if (
    contractor.claim_status === "claimed" &&
    contractor.claimed_by_user_id === args.user_id
  ) {
    await linkUserToContractor({
      user_id: args.user_id,
      contractor_id: contractor.id,
    });
    return { kind: "auto_approved", contractor_id: contractor.id };
  }

  const { score, reasons } = matchScore({ claimer, contractor });
  // License lookup is itself a strong signal — the user proved they
  // know the license number, which is a per-business credential.
  const finalScore = licenseLookup ? "strong" : score;
  const finalReasons = licenseLookup
    ? ["license-number match", ...reasons]
    : reasons;

  if (finalScore === "strong") {
    const a = await markContractorClaimed({
      contractor_id: contractor.id,
      user_id: args.user_id,
      status: "claimed",
    });
    const b = await linkUserToContractor({
      user_id: args.user_id,
      contractor_id: contractor.id,
    });
    if (!a || !b) {
      return { kind: "invalid", reason: "claim persist failed; try again" };
    }
    await recordAttempt({
      contractor_id: contractor.id,
      attempted_by_user_id: args.user_id,
      signals: { ...args, reasons: finalReasons },
      outcome: "auto_approved",
    });
    return { kind: "auto_approved", contractor_id: contractor.id };
  }

  // Medium / weak → pending_review (admin will approve manually)
  await markContractorClaimed({
    contractor_id: contractor.id,
    user_id: args.user_id,
    status: "pending_review",
  });
  await recordAttempt({
    contractor_id: contractor.id,
    attempted_by_user_id: args.user_id,
    signals: { ...args, reasons: finalReasons },
    outcome: "pending_review",
  });
  return {
    kind: "pending_review",
    contractor_id: contractor.id,
    reasons: finalReasons,
  };
}
