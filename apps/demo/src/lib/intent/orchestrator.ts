import {
  searchContractors,
  getContractorSummary,
  getContractorWithReviews,
  isSummaryStale,
  summarizeReviews,
  upsertContractorSummary,
  recommendContractors,
  deliberate,
  type DeliberateConstraints,
} from "../contractors";
import {
  createAppointment,
  rescheduleAppointment,
  cancelAppointment,
  listUpcomingAppointments,
  findRecentUnfulfilledAppointment,
  declareNoShowAndDispatch,
  type AppointmentRow,
} from "../appointments";
import { getSupabaseAdminConfig } from "../supabaseAdmin";
import { classifyIntent } from "./classify";
import { DEFAULT_CENTER } from "./slots";
import {
  wrapAppointmentCancelled,
  wrapAppointmentRescheduled,
  wrapAppointmentScheduled,
  wrapAppointmentsList,
  wrapCallPlaced,
  wrapContractorsResult,
  wrapDeliberateOpen,
  wrapDeliberateRefine,
  wrapDisputeOpened,
  wrapDraftContract,
  wrapEstimateReady,
  wrapFallback,
  wrapGoBetweenStarted,
  wrapNoShowDispatched,
  wrapPickResult,
  wrapRecommendationsResult,
  wrapRecurringScheduled,
  wrapSummaryResult,
} from "./contextInjector";
import {
  createRecurringJob,
  expandInstances,
  type RecurringJobRow,
} from "../recurring";
import {
  getActiveTierForContractor,
  tierUnlocks,
} from "../billing";
import { executeBook } from "./bookHandler";
import {
  insertContract,
  setContractEsign,
  computePlatformFeeCents,
  getContractorStripeRow,
} from "../payments";
import {
  getEsignProvider,
  getProviderNameFromEnv,
} from "../esign";
import {
  appendDisputeMessage,
  createDispute,
  decideMediatorAction,
  getDisputeById,
  listDisputeMessages,
  notifyAdminEscalation,
  patchDispute,
  setDisputeStatus,
  type DisputeMessageRow,
  type DisputeRow,
} from "../disputes";
import {
  createCall,
  createCallLeg,
  createEstimate,
  extractLineItems,
  getCallById,
  isTwilioVoiceConfigured,
  patchCall,
  setCallStatus,
  signCallRecordingUrl,
} from "../calls";
import { getRecentTranscriptForSession } from "../transcripts/store";
import type {
  AppointmentCard,
  CallPayload,
  CallTranscriptLine,
  ContractPayload,
  DisputePayload,
  DisputeThreadMessage,
  EstimatePayload,
  RecurringJobPayload,
} from "../assistantSurface";
import type {
  ContractorCard,
  RecommendationCard,
  SummaryPayload,
  SurfaceVariant,
} from "../assistantSurface";
import type {
  ContractorRef,
  IntentClassification,
  IntentSlots,
} from "./types";

/**
 * M3.0e — Intent orchestrator.
 *
 * Pipeline:
 *   text → classifyIntent() → run matching backend → build SurfaceVariant
 *        + contextMessage → return both to caller (the client uses
 *        them to update the drawer + send via session.message()).
 *
 * Surface snapshot:
 *   The client passes the IDs of contractors currently displayed in the
 *   drawer (in display order) so we can resolve "the first one" /
 *   "Acme" / "#2" references on the server.
 *
 * Failure modes:
 *   - No intent match → returns { kind: "none" }
 *   - Intent matched but slots insufficient → returns a "fallback"
 *     context message asking the user to clarify, no surface update
 *   - Intent matched + backend returned something → full action
 */

export type SurfaceSnapshot = {
  kind:
    | "contractors"
    | "summary"
    | "picks"
    | "pickResult"
    | "compare"
    | "appointment"
    | "contract"
    | "dispute"
    | "call"
    | "estimate"
    | "recurring"
    | null;
  /** Ordered as displayed in the drawer. Empty for non-list variants. */
  contractorIds: string[];
  /**
   * Carryover state when current surface is the deliberation compare panel.
   * Lets multi-turn refinement accumulate constraints without losing the
   * category or previous filters.
   */
  deliberation?: {
    category: string;
    constraints: DeliberateConstraints;
  };
};

export type OrchestratorInput = {
  text: string;
  session_id: string;
  user_id: string | null;
  /** Optional snapshot of what the drawer currently shows. */
  currentSurface?: SurfaceSnapshot;
  /** Request origin (e.g. "https://app.example.com") — used by features
   *  that need to deep-link back (e.g. dispute escalation emails). */
  app_origin?: string | null;
  /**
   * IANA timezone of the homeowner (e.g. "America/New_York"). Used by
   * M3.4 datetime parsing so "tomorrow at 10am" lands at 10am in the
   * user's wall clock, not 10am UTC. Pulled from the client by the
   * transcripts/append route (browser Intl.DateTimeFormat) and
   * threaded here.
   */
  tz?: string | null;
};

export type OrchestratorOutput =
  | { kind: "none"; reason: string }
  | {
      kind: "action";
      classification: IntentClassification;
      variant?: SurfaceVariant;
      contextMessage?: string;
      debug?: Record<string, unknown>;
    };

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Resolve a contractor ref (ordinal / name) to a contractor row.
 * Ordinals come from the drawer snapshot the client passed in. Names
 * trigger a database lookup.
 */
async function resolveContractorRef(args: {
  ref: ContractorRef;
  snapshot?: SurfaceSnapshot;
}): Promise<{ id: string; name: string } | null> {
  if (args.ref.type === "ordinal") {
    const ids = args.snapshot?.contractorIds ?? [];
    const idx = args.ref.position - 1;
    if (idx < 0 || idx >= ids.length) return null;
    const id = ids[idx];
    // Pull just the row to get the canonical name back.
    const row = await fetchContractorById(id);
    return row;
  }
  // Name resolution: ILIKE on contractors.name; take highest-rated match.
  return findContractorByName(args.ref.name);
}

async function fetchContractorById(
  id: string,
): Promise<{ id: string; name: string } | null> {
  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return null;
  }
  const res = await fetch(
    `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(
      id,
    )}&select=id,name&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ id: string; name: string }>;
  return rows[0] ?? null;
}

async function findContractorByName(
  name: string,
): Promise<{ id: string; name: string } | null> {
  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return null;
  }
  const qs = new URLSearchParams();
  qs.set("select", "id,name");
  qs.set("name", `ilike.%${name}%`);
  qs.set("order", "rating_avg.desc.nullslast");
  qs.set("limit", "1");
  const res = await fetch(`${url}/rest/v1/contractors?${qs.toString()}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ id: string; name: string }>;
  return rows[0] ?? null;
}

function contractorRowToCard(c: {
  id: string;
  name: string;
  rating_avg: number | null;
  rating_count: number | null;
  distance_km?: number;
  price_tier: number | null;
  locally_owned: boolean | null;
  same_day_flag: boolean | null;
  licensed_flag: boolean | null;
  phone: string | null;
  website: string | null;
  score?: number;
}): ContractorCard {
  return {
    id: c.id,
    name: c.name,
    rating_avg: c.rating_avg,
    rating_count: c.rating_count,
    distance_km: c.distance_km ?? 0,
    price_tier: c.price_tier,
    locally_owned: c.locally_owned,
    same_day_flag: c.same_day_flag,
    licensed_flag: c.licensed_flag,
    phone: c.phone,
    website: c.website,
    score: c.score,
  };
}

// ─── Per-intent handlers ────────────────────────────────────────────

async function handleFindContractor(args: {
  slots: IntentSlots;
}): Promise<{ variant: SurfaceVariant; contextMessage: string }> {
  const category = args.slots.category ?? "general";
  const near = args.slots.location ?? DEFAULT_CENTER;
  const result = await searchContractors({
    category,
    near,
    radius_km: 25,
    min_rating: args.slots.filters?.min_rating,
    max_price_tier: args.slots.filters?.max_price_tier,
    locally_owned: args.slots.filters?.locally_owned,
    same_day: args.slots.filters?.same_day,
    limit: 10,
  });
  const hits: ContractorCard[] = result.hits.map(contractorRowToCard);
  return {
    variant: {
      kind: "contractors",
      hits,
      total_considered: result.total_considered,
    },
    contextMessage: wrapContractorsResult({
      category,
      location_text: args.slots.location_text,
      hits,
    }),
  };
}

async function handleTellMeMore(args: {
  slots: IntentSlots;
  snapshot?: SurfaceSnapshot;
}): Promise<
  | { variant: SurfaceVariant; contextMessage: string }
  | { contextMessage: string }
> {
  if (!args.slots.contractor_ref) {
    return {
      contextMessage: wrapFallback(
        "user wanted details but didn't say which contractor",
      ),
    };
  }
  const resolved = await resolveContractorRef({
    ref: args.slots.contractor_ref,
    snapshot: args.snapshot,
  });
  if (!resolved) {
    return {
      contextMessage: wrapFallback(
        `couldn't identify the contractor (${
          args.slots.contractor_ref.type === "name"
            ? "name: " + args.slots.contractor_ref.name
            : "no list on screen"
        })`,
      ),
    };
  }

  // Pull the cached summary OR lazy-generate (matches M2.3's behavior).
  const existing = await getContractorSummary(resolved.id).catch(() => null);
  const data = await getContractorWithReviews(resolved.id).catch(() => null);
  if (!data) {
    return {
      contextMessage: wrapFallback(`no reviews on file for ${resolved.name}`),
    };
  }
  const stale = isSummaryStale({
    existing,
    currentReviewCount: data.reviews.length,
  });
  let payload: SummaryPayload | null = null;
  let cached = false;
  if (existing && !stale) {
    payload = {
      contractor_id: resolved.id,
      contractor_name: resolved.name,
      summary: existing.summary,
      strengths_md: existing.strengths_md,
      weaknesses_md: existing.weaknesses_md,
      sample_quotes: existing.sample_quotes,
    };
    cached = true;
  } else {
    const fresh = await summarizeReviews({
      contractorName: resolved.name,
      reviews: data.reviews,
    });
    if (!fresh.ok) {
      return {
        contextMessage: wrapFallback(
          `couldn't summarize ${resolved.name} (${fresh.reason})`,
        ),
      };
    }
    await upsertContractorSummary({
      contractorId: resolved.id,
      summary: fresh.summary,
    }).catch(() => undefined);
    payload = {
      contractor_id: resolved.id,
      contractor_name: resolved.name,
      summary: fresh.summary.summary,
      strengths_md: fresh.summary.strengths_md,
      weaknesses_md: fresh.summary.weaknesses_md,
      sample_quotes: fresh.summary.sample_quotes,
    };
  }
  return {
    variant: { kind: "summary", payload, cached },
    contextMessage: wrapSummaryResult({
      contractor_name: resolved.name,
      payload,
    }),
  };
}

async function handleRecommend(args: {
  slots: IntentSlots;
  user_id: string | null;
  snapshot?: SurfaceSnapshot;
}): Promise<
  | { variant: SurfaceVariant; contextMessage: string }
  | { contextMessage: string }
> {
  // If we have a current contractor list, use its category from the snapshot
  // (best-effort) — otherwise fall back to "general" + default center.
  const category = args.slots.category ?? "general";
  const near = args.slots.location ?? DEFAULT_CENTER;
  const result = await recommendContractors({
    userId: args.user_id,
    searchInput: {
      category,
      near,
      radius_km: 25,
      min_rating: 4.5,
    },
  });
  if (result.picks.length === 0) {
    return {
      contextMessage: wrapFallback(
        "no recommendations could be produced (engine returned empty)",
      ),
    };
  }
  const picks: RecommendationCard[] = result.picks.map((p) => ({
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
  return {
    variant: {
      kind: "picks",
      picks,
      preference_facts: result.preference_facts,
    },
    contextMessage: wrapRecommendationsResult({
      picks,
      preference_facts: result.preference_facts,
    }),
  };
}

/**
 * If no category is on the user's lips, look it up from whatever's on
 * screen. Used by deliberate_open when the first utterance is "I can't
 * decide" with no prior compare state.
 */
async function inferCategoryFromSnapshot(
  snapshot?: SurfaceSnapshot,
): Promise<string> {
  if (snapshot?.deliberation?.category) return snapshot.deliberation.category;
  if (!snapshot?.contractorIds?.length) return "general";
  const firstId = snapshot.contractorIds[0];
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const res = await fetch(
      `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(
        firstId,
      )}&select=categories&limit=1`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        cache: "no-store",
      },
    );
    if (!res.ok) return "general";
    const rows = (await res.json()) as Array<{ categories: string[] | null }>;
    return rows[0]?.categories?.[0] ?? "general";
  } catch {
    return "general";
  }
}

async function handleDeliberateOpen(args: {
  slots: IntentSlots;
  user_id: string | null;
  snapshot?: SurfaceSnapshot;
}): Promise<
  | { variant: SurfaceVariant; contextMessage: string }
  | { contextMessage: string }
> {
  const category =
    args.slots.category ??
    (await inferCategoryFromSnapshot(args.snapshot));
  const near = args.slots.location ?? DEFAULT_CENTER;
  const result = await deliberate({
    user_id: args.user_id,
    category,
    near,
    constraints: args.snapshot?.deliberation?.constraints ?? {},
    current_pick_ids: args.snapshot?.contractorIds,
  });
  if (!result.ok) {
    return {
      contextMessage: wrapFallback(`deliberate_open: ${result.reason}`),
    };
  }
  return {
    variant: { kind: "compare", payload: result.payload },
    contextMessage: wrapDeliberateOpen({ payload: result.payload }),
  };
}

async function handleDeliberateRefine(args: {
  slots: IntentSlots;
  user_id: string | null;
  snapshot?: SurfaceSnapshot;
}): Promise<
  | { variant: SurfaceVariant; contextMessage: string }
  | { contextMessage: string }
> {
  const prior = args.snapshot?.deliberation;
  const category =
    prior?.category ?? (await inferCategoryFromSnapshot(args.snapshot));
  const priorConstraints = prior?.constraints ?? {};
  const newFilters = args.slots.filters ?? {};

  // Merge filters — new values take precedence.
  const merged: DeliberateConstraints = {
    ...priorConstraints,
    ...(newFilters.locally_owned !== undefined && {
      locally_owned: newFilters.locally_owned,
    }),
    ...(newFilters.same_day !== undefined && {
      same_day: newFilters.same_day,
    }),
    ...(newFilters.min_rating !== undefined && {
      min_rating: newFilters.min_rating,
    }),
    ...(newFilters.max_price_tier !== undefined && {
      max_price_tier: newFilters.max_price_tier,
    }),
    ...(newFilters.max_distance_km !== undefined && {
      max_distance_km: newFilters.max_distance_km,
    }),
  };

  // Handle "not that one" — resolve exclude_ref and append to exclude_ids
  if (args.slots.exclude_ref) {
    let toExclude: string | null = null;
    if (
      args.slots.exclude_ref.type === "ordinal" &&
      args.snapshot?.contractorIds
    ) {
      const idx = args.slots.exclude_ref.position - 1;
      toExclude = args.snapshot.contractorIds[idx] ?? null;
    } else if (args.slots.exclude_ref.type === "name") {
      const found = await findContractorByName(args.slots.exclude_ref.name);
      toExclude = found?.id ?? null;
    }
    if (toExclude) {
      merged.exclude_ids = [
        ...(merged.exclude_ids ?? []),
        toExclude,
      ];
    }
  }

  // Describe what changed in human terms — used by the wrapper for narration.
  const changedBits: string[] = [];
  if (newFilters.locally_owned) changedBits.push("locally owned only");
  if (newFilters.same_day) changedBits.push("same-day only");
  if (newFilters.min_rating != null)
    changedBits.push(`min rating ${newFilters.min_rating}`);
  if (newFilters.max_price_tier != null)
    changedBits.push(`under ${"$".repeat(newFilters.max_price_tier)}`);
  if (newFilters.max_distance_km != null)
    changedBits.push(`within ${newFilters.max_distance_km} km`);
  if (args.slots.exclude_ref) changedBits.push("excluding the prior one");
  const changed = changedBits.join(", ") || "constraints unchanged";

  const result = await deliberate({
    user_id: args.user_id,
    category,
    constraints: merged,
    current_pick_ids: args.snapshot?.contractorIds,
  });
  if (!result.ok) {
    return {
      contextMessage: wrapFallback(
        `refinement (${changed}) returned no candidates`,
      ),
    };
  }
  return {
    variant: { kind: "compare", payload: result.payload },
    contextMessage: wrapDeliberateRefine({
      payload: result.payload,
      changed,
    }),
  };
}

async function handleBook(args: {
  slots: IntentSlots;
  snapshot?: SurfaceSnapshot;
  user_id: string | null;
}): Promise<
  | { variant: SurfaceVariant; contextMessage: string }
  | { contextMessage: string }
> {
  if (!args.slots.contractor_ref) {
    return {
      contextMessage: wrapFallback(
        "user wanted to book but didn't say which contractor",
      ),
    };
  }
  const resolved = await resolveContractorRef({
    ref: args.slots.contractor_ref,
    snapshot: args.snapshot,
  });
  if (!resolved) {
    return {
      contextMessage: wrapFallback(
        "couldn't identify the contractor to book",
      ),
    };
  }

  const { payload } = await executeBook({
    winner_id: resolved.id,
    winner_name: resolved.name,
    candidate_ids: args.snapshot?.contractorIds ?? [],
    user_id: args.user_id,
  });

  return {
    variant: { kind: "pickResult", payload },
    contextMessage: wrapPickResult({
      winner_name: resolved.name,
      loser_count: payload.losers.length,
      delivered_count: payload.total_sent,
      failed_count: payload.total_failed,
    }),
  };
}

// ─── Appointment helpers ────────────────────────────────────────────

function appointmentRowToCard(
  row: AppointmentRow,
  contractorName: string | null = null,
): AppointmentCard {
  const d = new Date(row.scheduled_at);
  const whenText = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  // Use "today" / "tomorrow" if applicable for nicer narration.
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const isTomorrow =
    d.getFullYear() === tomorrow.getFullYear() &&
    d.getMonth() === tomorrow.getMonth() &&
    d.getDate() === tomorrow.getDate();
  const friendlyTime = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  const friendlyWhen = sameDay
    ? `today at ${friendlyTime}`
    : isTomorrow
      ? `tomorrow at ${friendlyTime}`
      : whenText;
  return {
    id: row.id,
    contractor_id: row.contractor_id,
    contractor_name: contractorName,
    scheduled_at: row.scheduled_at,
    scheduled_when_text: friendlyWhen,
    duration_minutes: row.duration_minutes,
    agenda: row.agenda,
    status: row.status,
  };
}

async function fetchContractorNameSafe(
  contractorId: string | null,
): Promise<string | null> {
  if (!contractorId) return null;
  const row = await fetchContractorById(contractorId).catch(() => null);
  return row?.name ?? null;
}

/**
 * Resolve which contractor a fresh schedule_appointment refers to. We
 * look at the current surface — if the user just booked someone, that's
 * who the appointment is with. Otherwise null (homeowner appointment
 * with no specific contractor).
 */
function resolveAppointmentContractor(
  snapshot?: SurfaceSnapshot,
): string | null {
  if (!snapshot?.contractorIds?.length) return null;
  return snapshot.contractorIds[0] ?? null;
}

async function handleScheduleAppointment(args: {
  slots: IntentSlots;
  user_id: string | null;
  snapshot?: SurfaceSnapshot;
}): Promise<
  | { variant: SurfaceVariant; contextMessage: string }
  | { contextMessage: string }
> {
  if (!args.user_id) {
    return {
      contextMessage: wrapFallback(
        "scheduling requires sign-in — appointments are user-scoped",
      ),
    };
  }
  if (!args.slots.when) {
    return {
      contextMessage: wrapFallback(
        "couldn't extract a date/time from the request",
      ),
    };
  }
  const contractorId = resolveAppointmentContractor(args.snapshot);
  const row = await createAppointment({
    user_id: args.user_id,
    contractor_id: contractorId,
    scheduled_at: args.slots.when.iso_utc,
    duration_minutes: 60,
    agenda: args.slots.agenda ?? "",
    context: { intake: "voice", matched_phrase: args.slots.when.phrase },
  });
  if (!row) {
    return {
      contextMessage: wrapFallback(
        "appointment insert failed — see server logs",
      ),
    };
  }
  const contractorName = await fetchContractorNameSafe(contractorId);
  const card = appointmentRowToCard(row, contractorName);
  return {
    variant: {
      kind: "appointment",
      payload: { appointments: [card], intent_kind: "scheduled" },
    },
    contextMessage: wrapAppointmentScheduled({ appointment: card }),
  };
}

async function handleRescheduleAppointment(args: {
  slots: IntentSlots;
  user_id: string | null;
  snapshot?: SurfaceSnapshot;
}): Promise<
  | { variant: SurfaceVariant; contextMessage: string }
  | { contextMessage: string }
> {
  if (!args.user_id) {
    return { contextMessage: wrapFallback("reschedule requires sign-in") };
  }
  if (!args.slots.when) {
    return {
      contextMessage: wrapFallback(
        "couldn't extract a new date/time from the request",
      ),
    };
  }
  // Resolve which appointment to reschedule — pick the next upcoming.
  // v1: simplest possible heuristic. v2 lets user say which by name/time.
  const upcoming = await listUpcomingAppointments({
    user_id: args.user_id,
    limit: 1,
  });
  if (upcoming.length === 0) {
    return {
      contextMessage: wrapFallback("no upcoming appointment to reschedule"),
    };
  }
  const target = upcoming[0];
  const row = await rescheduleAppointment({
    appointment_id: target.id,
    user_id: args.user_id,
    new_scheduled_at: args.slots.when.iso_utc,
    reason: "voice reschedule",
  });
  if (!row) {
    return {
      contextMessage: wrapFallback("reschedule update failed — see server logs"),
    };
  }
  const contractorName = await fetchContractorNameSafe(row.contractor_id);
  const card = appointmentRowToCard(row, contractorName);
  return {
    variant: {
      kind: "appointment",
      payload: { appointments: [card], intent_kind: "rescheduled" },
    },
    contextMessage: wrapAppointmentRescheduled({ appointment: card }),
  };
}

async function handleCancelAppointment(args: {
  user_id: string | null;
}): Promise<
  | { variant: SurfaceVariant; contextMessage: string }
  | { contextMessage: string }
> {
  if (!args.user_id) {
    return { contextMessage: wrapFallback("cancel requires sign-in") };
  }
  const upcoming = await listUpcomingAppointments({
    user_id: args.user_id,
    limit: 1,
  });
  if (upcoming.length === 0) {
    return {
      contextMessage: wrapFallback("no upcoming appointment to cancel"),
    };
  }
  const target = upcoming[0];
  const row = await cancelAppointment({
    appointment_id: target.id,
    user_id: args.user_id,
    reason: "voice cancel",
  });
  if (!row) {
    return {
      contextMessage: wrapFallback("cancel update failed — see server logs"),
    };
  }
  const contractorName = await fetchContractorNameSafe(row.contractor_id);
  const card = appointmentRowToCard(row, contractorName);
  return {
    variant: {
      kind: "appointment",
      payload: { appointments: [card], intent_kind: "cancelled" },
    },
    contextMessage: wrapAppointmentCancelled({ appointment: card }),
  };
}

/**
 * M4.4 — Handle "they didn't show" from the homeowner. Resolves the
 * target appointment (most recent one still in scheduled/rescheduled,
 * within the last 4 hours), flips it to no_show, and fans out an urgent
 * dispatch to same-day contractors nearby. Idempotent via the CAS in
 * declareNoShowAndDispatch.
 */
async function handleReportNoShow(args: {
  user_id: string | null;
  raw_text: string;
}): Promise<
  | { variant: SurfaceVariant; contextMessage: string }
  | { contextMessage: string }
> {
  if (!args.user_id) {
    return { contextMessage: wrapFallback("no-show reports require sign-in") };
  }
  const target = await findRecentUnfulfilledAppointment({
    user_id: args.user_id,
  });
  if (!target) {
    return {
      contextMessage: wrapFallback(
        "no recent appointment found to flag as no-show",
      ),
    };
  }
  const result = await declareNoShowAndDispatch({
    appointment_id: target.id,
    trigger: "homeowner_report",
    reasonContext: {
      reported_by_user_id: args.user_id,
      via: "voice_intent",
      raw_text: args.raw_text,
      reported_at: new Date().toISOString(),
    },
  });
  const contractorName = await fetchContractorNameSafe(target.contractor_id);
  const card = appointmentRowToCard(target, contractorName);
  const invited_count = result.invited.filter((i) => i.delivered).length;
  return {
    variant: {
      kind: "appointment",
      payload: { appointments: [card], intent_kind: "no_show" },
    },
    contextMessage: wrapNoShowDispatched({
      appointment: card,
      invited_count,
      skipped_reason: result.skipped_reason,
    }),
  };
}

async function handleViewAppointments(args: {
  user_id: string | null;
}): Promise<
  | { variant: SurfaceVariant; contextMessage: string }
  | { contextMessage: string }
> {
  if (!args.user_id) {
    return {
      contextMessage: wrapFallback("viewing requires sign-in"),
    };
  }
  const rows = await listUpcomingAppointments({
    user_id: args.user_id,
    limit: 10,
  });
  const cards: AppointmentCard[] = await Promise.all(
    rows.map(async (r) =>
      appointmentRowToCard(r, await fetchContractorNameSafe(r.contractor_id)),
    ),
  );
  return {
    variant: {
      kind: "appointment",
      payload: { appointments: cards, intent_kind: "list" },
    },
    contextMessage: wrapAppointmentsList({ appointments: cards }),
  };
}

// ─── Contract drafter (M3.7) ────────────────────────────────────────

const PLATFORM_FEE_PERCENT_FOR_DRAFT = (() => {
  const raw = process.env.PLATFORM_FEE_PERCENT;
  const n = raw != null ? parseFloat(raw) : NaN;
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 5;
})();
const PLATFORM_CURRENCY_FOR_DRAFT = (
  process.env.PLATFORM_CURRENCY || "usd"
).toLowerCase();

const MIN_DRAFT_AMOUNT_CENTS = 100;
const MAX_DRAFT_AMOUNT_CENTS = 5_000_000;

async function fetchHomeownerName(
  userId: string,
): Promise<{ name: string; email: string | null }> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const res = await fetch(
      `${url}/rest/v1/users?id=eq.${encodeURIComponent(
        userId,
      )}&select=email,full_name&limit=1`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        cache: "no-store",
      },
    );
    if (!res.ok) return { name: "Homeowner", email: null };
    const rows = (await res.json()) as Array<{
      email: string | null;
      full_name: string | null;
    }>;
    const row = rows[0];
    return {
      name: row?.full_name ?? "Homeowner",
      email: row?.email ?? null,
    };
  } catch {
    return { name: "Homeowner", email: null };
  }
}

function buildContractBody(args: {
  homeownerName: string;
  contractorName: string;
  scope: string;
  amountCents: number;
  currency: string;
  platformFeeCents: number;
}): string {
  const dollars = (args.amountCents / 100).toFixed(2);
  const feeDollars = (args.platformFeeCents / 100).toFixed(2);
  const c = args.currency.toUpperCase();
  return [
    `WORK AGREEMENT`,
    ``,
    `Between: ${args.homeownerName} ("Homeowner")`,
    `And:     ${args.contractorName} ("Contractor")`,
    ``,
    `Scope of Work:`,
    args.scope,
    ``,
    `Total Compensation: ${dollars} ${c}`,
    `Platform Fee (deducted): ${feeDollars} ${c} (iSolveUrProblems)`,
    ``,
    `Both parties agree that:`,
    `  - Work will be performed in a workmanlike manner.`,
    `  - Payment will be released through the iSolveUrProblems platform.`,
    `  - Disputes will be handled per the iSolveUrProblems Terms of Service.`,
    `  - This agreement is enforceable as a written contract upon both signatures.`,
    ``,
    `By signing below, both parties acknowledge and agree to these terms.`,
  ].join("\n");
}

async function handleDraftContract(args: {
  slots: IntentSlots;
  user_id: string | null;
  snapshot?: SurfaceSnapshot;
}): Promise<
  | { variant: SurfaceVariant; contextMessage: string }
  | { contextMessage: string }
> {
  if (!args.user_id) {
    return {
      contextMessage: wrapFallback(
        "drafting a contract requires sign-in (contracts are user-scoped)",
      ),
    };
  }

  // Resolve the contractor — prefer the explicit slot ref, fall back to
  // whatever's at the top of the current surface (the post-deliberation
  // / post-booking flow naturally lands here).
  let contractorRef = args.slots.contractor_ref;
  if (!contractorRef && args.snapshot?.contractorIds?.length) {
    contractorRef = { type: "ordinal", position: 1 };
  }
  if (!contractorRef) {
    return {
      contextMessage: wrapFallback(
        "user wanted a contract but no contractor on screen and no name said",
      ),
    };
  }
  const resolved = await resolveContractorRef({
    ref: contractorRef,
    snapshot: args.snapshot,
  });
  if (!resolved) {
    return {
      contextMessage: wrapFallback(
        "couldn't identify the contractor for the contract",
      ),
    };
  }

  // Amount + scope must be present for v1.
  const amountCents = args.slots.amount_cents;
  if (
    typeof amountCents !== "number" ||
    !Number.isInteger(amountCents) ||
    amountCents < MIN_DRAFT_AMOUNT_CENTS ||
    amountCents > MAX_DRAFT_AMOUNT_CENTS
  ) {
    return {
      contextMessage: wrapFallback(
        "no clear dollar amount in the request — ask the user to say the price",
      ),
    };
  }
  const scope = args.slots.scope?.trim();
  if (!scope) {
    return {
      contextMessage: wrapFallback(
        "no scope phrase in the request — ask the user what the contract should cover",
      ),
    };
  }

  // Pull contractor row for name + email (uses the M2.5 helper).
  const contractor = await getContractorStripeRow(resolved.id).catch(
    () => null,
  );
  if (!contractor) {
    return {
      contextMessage: wrapFallback(
        "contractor row lookup failed during contract draft",
      ),
    };
  }

  const homeowner = await fetchHomeownerName(args.user_id);
  const platformFeeCents = computePlatformFeeCents(
    amountCents,
    PLATFORM_FEE_PERCENT_FOR_DRAFT,
  );

  let contractRow;
  try {
    contractRow = await insertContract({
      user_id: args.user_id,
      contractor_id: resolved.id,
      category: "general",
      amount_cents: amountCents,
      platform_fee_cents: platformFeeCents,
      currency: PLATFORM_CURRENCY_FOR_DRAFT,
      candidate_ids: args.snapshot?.contractorIds ?? [],
      context: { source: "m3.7_voice_draft", scope },
    });
  } catch (e) {
    return {
      contextMessage: wrapFallback(
        `contract insert failed: ${e instanceof Error ? e.message : "unknown"}`,
      ),
    };
  }

  const docBody = buildContractBody({
    homeownerName: homeowner.name,
    contractorName: contractor.name,
    scope,
    amountCents,
    currency: PLATFORM_CURRENCY_FOR_DRAFT,
    platformFeeCents,
  });

  const provider = getEsignProvider();
  const env = await provider.createEnvelope({
    contract_id: contractRow.id,
    title: `Work agreement — ${contractor.name}`,
    body: docBody,
    signers: [
      { role: "user", name: homeowner.name, email: homeowner.email },
      {
        role: "contractor",
        name: contractor.name,
        email: contractor.email,
      },
    ],
    return_url: "",
  });

  if (!env.ok) {
    return {
      contextMessage: wrapFallback(`esign provider failed: ${env.error}`),
    };
  }

  try {
    await setContractEsign({
      contract_id: contractRow.id,
      user_id: args.user_id,
      esign_provider: getProviderNameFromEnv(),
      esign_envelope_id: env.envelope_id,
      esign_envelope_status: env.status,
      esign_signing_url_user: env.signing_url_by_role.user,
      esign_signing_url_contractor: env.signing_url_by_role.contractor,
      scope,
      stamp_signed_now: env.status === "signed",
    });
  } catch (e) {
    return {
      contextMessage: wrapFallback(
        `contract esign patch failed: ${e instanceof Error ? e.message : "unknown"}`,
      ),
    };
  }

  const payload: ContractPayload = {
    contract_id: contractRow.id,
    contractor_name: contractor.name,
    scope,
    amount_cents: amountCents,
    platform_fee_cents: platformFeeCents,
    currency: PLATFORM_CURRENCY_FOR_DRAFT,
    envelope: {
      provider: getProviderNameFromEnv(),
      envelope_id: env.envelope_id,
      status: env.status,
      signing_url_user: env.signing_url_by_role.user,
      signing_url_contractor: env.signing_url_by_role.contractor,
    },
  };

  return {
    variant: { kind: "contract", payload },
    contextMessage: wrapDraftContract({ payload }),
  };
}

// ─── Dispute mediator (M3.9) ────────────────────────────────────────

function disputeMessageToThread(row: DisputeMessageRow): DisputeThreadMessage {
  const proposed = (
    row.context as { proposed_resolution?: DisputeThreadMessage["proposed_resolution"] }
  )?.proposed_resolution;
  return {
    id: row.id,
    sender: row.sender,
    body: row.body,
    kind: row.kind,
    created_at: row.created_at,
    proposed_resolution: proposed,
  };
}

async function disputeToPayload(args: {
  dispute: DisputeRow;
}): Promise<DisputePayload> {
  const messages = await listDisputeMessages(args.dispute.id);
  let contractorName: string | null = null;
  if (args.dispute.contractor_id) {
    const row = await fetchContractorById(args.dispute.contractor_id).catch(
      () => null,
    );
    contractorName = row?.name ?? null;
  }
  return {
    dispute_id: args.dispute.id,
    status: args.dispute.status,
    complaint: args.dispute.complaint,
    disputed_amount_cents: args.dispute.disputed_amount_cents,
    contractor_name: contractorName,
    contract_id: args.dispute.contract_id,
    messages: messages.map(disputeMessageToThread),
  };
}

async function handleFileDispute(args: {
  slots: IntentSlots;
  user_id: string | null;
  snapshot?: SurfaceSnapshot;
  raw_text: string;
  app_origin?: string | null;
}): Promise<
  | { variant: SurfaceVariant; contextMessage: string }
  | { contextMessage: string }
> {
  if (!args.user_id) {
    return {
      contextMessage: wrapFallback(
        "filing a dispute requires sign-in (threads are user-scoped)",
      ),
    };
  }

  const complaint =
    args.slots.complaint?.trim() ||
    args.raw_text.trim();
  if (!complaint) {
    return {
      contextMessage: wrapFallback(
        "no complaint text — ask the user what the problem is",
      ),
    };
  }

  // Optional contractor pin — explicit ref OR top of current surface.
  let contractorId: string | null = null;
  if (args.slots.contractor_ref) {
    const resolved = await resolveContractorRef({
      ref: args.slots.contractor_ref,
      snapshot: args.snapshot,
    });
    contractorId = resolved?.id ?? null;
  } else if (args.snapshot?.contractorIds?.length) {
    contractorId = args.snapshot.contractorIds[0] ?? null;
  }

  const dispute = await createDispute({
    user_id: args.user_id,
    contract_id: null,
    contractor_id: contractorId,
    complaint,
    disputed_amount_cents: args.slots.amount_cents ?? null,
    context: { source: "m3.9_voice_intake" },
  });
  if (!dispute) {
    return {
      contextMessage: wrapFallback("dispute insert failed — see server logs"),
    };
  }

  // Record the opening user message verbatim.
  await appendDisputeMessage({
    dispute_id: dispute.id,
    sender: "user",
    body: complaint,
    kind: "message",
  });

  // Mediator opens with its first reply (or escalation if rules trip).
  const decision = await decideMediatorAction({
    dispute,
    thread: [],
    contract: null,
    latestUserMessage: complaint,
  });

  if (decision.kind === "escalate") {
    await appendDisputeMessage({
      dispute_id: dispute.id,
      sender: "mediator",
      body: decision.body,
      kind: "escalation_notice",
      context: { reason: decision.reason },
    });
    await setDisputeStatus(dispute.id, "escalated", {
      kind: "human_escalation",
      summary: decision.reason,
    });
  } else {
    await appendDisputeMessage({
      dispute_id: dispute.id,
      sender: "mediator",
      body: decision.body,
      kind: decision.message_kind,
      context: decision.proposed_resolution
        ? { proposed_resolution: decision.proposed_resolution }
        : {},
    });
    await patchDispute(dispute.id, {
      status: "awaiting_user",
      mediator_turn_count: 1,
    });
  }

  const refreshed = (await getDisputeById(dispute.id)) ?? dispute;
  if (decision.kind === "escalate") {
    await notifyAdminEscalation({
      dispute: refreshed,
      reason: decision.reason,
      app_origin: args.app_origin ?? null,
    });
  }
  const payload = await disputeToPayload({ dispute: refreshed });

  return {
    variant: { kind: "dispute", payload },
    contextMessage: wrapDisputeOpened({ payload }),
  };
}

// ─── Phone call + estimate (M3.1 / M3.6) ────────────────────────────

const E164_RE = /^\+[1-9]\d{6,14}$/;

async function fetchUserPhone(userId: string): Promise<string | null> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const res = await fetch(
      `${url}/rest/v1/users?id=eq.${encodeURIComponent(userId)}&select=phone&limit=1`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        cache: "no-store",
      },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ phone: string | null }>;
    return rows[0]?.phone ?? null;
  } catch {
    return null;
  }
}

async function fetchContractorPhone(
  contractorId: string,
): Promise<string | null> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const res = await fetch(
      `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(
        contractorId,
      )}&select=phone&limit=1`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        cache: "no-store",
      },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ phone: string | null }>;
    return rows[0]?.phone ?? null;
  } catch {
    return null;
  }
}

async function handlePlaceCall(args: {
  slots: IntentSlots;
  user_id: string | null;
  snapshot?: SurfaceSnapshot;
}): Promise<
  | { variant: SurfaceVariant; contextMessage: string }
  | { contextMessage: string }
> {
  if (!isTwilioVoiceConfigured()) {
    return {
      contextMessage: wrapFallback(
        "phone calling is not configured — Twilio Voice env vars are missing",
      ),
    };
  }
  if (!args.user_id) {
    return {
      contextMessage: wrapFallback(
        "placing a call requires sign-in (we need the homeowner's phone)",
      ),
    };
  }
  if (!args.slots.contractor_ref) {
    return {
      contextMessage: wrapFallback(
        "user wanted to call but didn't say which contractor",
      ),
    };
  }
  const resolved = await resolveContractorRef({
    ref: args.slots.contractor_ref,
    snapshot: args.snapshot,
  });
  if (!resolved) {
    return {
      contextMessage: wrapFallback(
        "couldn't identify the contractor to call",
      ),
    };
  }

  const [userPhone, contractorPhone] = await Promise.all([
    fetchUserPhone(args.user_id),
    fetchContractorPhone(resolved.id),
  ]);
  if (!userPhone || !E164_RE.test(userPhone)) {
    return {
      contextMessage: wrapFallback(
        "homeowner has no E.164 phone on file — ask them to add one in settings",
      ),
    };
  }
  if (!contractorPhone || !E164_RE.test(contractorPhone)) {
    return {
      contextMessage: wrapFallback(
        `${resolved.name} has no usable phone on file`,
      ),
    };
  }

  const fromPhone = process.env.TWILIO_VOICE_FROM_NUMBER ?? "";
  const call = await createCall({
    user_id: args.user_id,
    contractor_id: resolved.id,
    to_user_phone: userPhone,
    to_contractor_phone: contractorPhone,
    from_phone: fromPhone,
    context: { source: "voice_intent" },
  });
  if (!call) {
    return {
      contextMessage: wrapFallback("call row insert failed — see server logs"),
    };
  }

  // Dial homeowner + contractor in parallel. 6 speaks via Twilio's
  // Conference Announce API, so no third "6 leg" is needed.
  const [userLeg, contractorLeg] = await Promise.all([
    createCallLeg({ to: userPhone, callId: call.id, participant: "user" }),
    createCallLeg({
      to: contractorPhone,
      callId: call.id,
      participant: "contractor",
    }),
  ]);
  if (!userLeg.ok || !contractorLeg.ok) {
    await setCallStatus(call.id, "failed");
    const errMsg = [
      !userLeg.ok ? `user: ${userLeg.error}` : "",
      !contractorLeg.ok ? `contractor: ${contractorLeg.error}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    return {
      contextMessage: wrapFallback(`Twilio dial failed: ${errMsg}`),
    };
  }
  await patchCall(call.id, {
    status: "dialing",
    twilio_call_sid_user: userLeg.sid,
    twilio_call_sid_contractor: contractorLeg.sid,
  });

  const payload: CallPayload = {
    call_id: call.id,
    status: "dialing",
    contractor_name: resolved.name,
    contractor_phone: contractorPhone,
    user_phone: userPhone,
    transcript: [],
    recording_signed_url: null,
    estimate_id: null,
    started_at: null,
    ended_at: null,
  };

  return {
    variant: { kind: "call", payload },
    contextMessage: wrapCallPlaced({ payload }),
  };
}

/**
 * M4.9 — Go-between mediation call. The homeowner + contractor are in
 * the same room; 6 joins as a Twilio conference mediator. Reuses the
 * M3.1 dial pipeline (createCallLeg → conference → transcription →
 * announce) but marks context.mode='go_between' so downstream surface
 * code, coaching-nudge dedup, and analytics can distinguish the two
 * kinds of calls.
 *
 * v1 requires both phones already on file (contractor via
 * contractor_ref, homeowner via users.phone). The invite-the-other-
 * party-via-share-link flow is deferred to v2.
 */
async function handleGoBetweenMode(args: {
  slots: IntentSlots;
  user_id: string | null;
  snapshot?: SurfaceSnapshot;
}): Promise<
  | { variant: SurfaceVariant; contextMessage: string }
  | { contextMessage: string }
> {
  if (!isTwilioVoiceConfigured()) {
    return {
      contextMessage: wrapFallback(
        "go-between mode requires Twilio Voice — env vars are missing",
      ),
    };
  }
  if (!args.user_id) {
    return {
      contextMessage: wrapFallback(
        "go-between mode requires sign-in — we need the homeowner's phone",
      ),
    };
  }
  // The other party is usually the contractor whose card is on-screen
  // when the homeowner says "get on the phone with me while they're
  // here". Fall back to an explicit contractor_ref if the surface
  // doesn't have one.
  const ref = args.slots.contractor_ref;
  const resolved = ref
    ? await resolveContractorRef({ ref, snapshot: args.snapshot })
    : args.snapshot?.contractorIds?.[0]
      ? await fetchContractorById(args.snapshot.contractorIds[0])
      : null;
  if (!resolved) {
    return {
      contextMessage: wrapFallback(
        "go-between: couldn't identify which contractor is here",
      ),
    };
  }

  const [userPhone, contractorPhone] = await Promise.all([
    fetchUserPhone(args.user_id),
    fetchContractorPhone(resolved.id),
  ]);
  if (!userPhone || !E164_RE.test(userPhone)) {
    return {
      contextMessage: wrapFallback(
        "homeowner has no E.164 phone on file — go-between needs one",
      ),
    };
  }
  if (!contractorPhone || !E164_RE.test(contractorPhone)) {
    return {
      contextMessage: wrapFallback(
        `${resolved.name} has no usable phone on file — go-between can't dial them in`,
      ),
    };
  }

  const fromPhone = process.env.TWILIO_VOICE_FROM_NUMBER ?? "";
  const call = await createCall({
    user_id: args.user_id,
    contractor_id: resolved.id,
    to_user_phone: userPhone,
    to_contractor_phone: contractorPhone,
    from_phone: fromPhone,
    context: { source: "voice_intent", mode: "go_between" },
  });
  if (!call) {
    return {
      contextMessage: wrapFallback(
        "go-between: call row insert failed — see server logs",
      ),
    };
  }

  const [userLeg, contractorLeg] = await Promise.all([
    createCallLeg({ to: userPhone, callId: call.id, participant: "user" }),
    createCallLeg({
      to: contractorPhone,
      callId: call.id,
      participant: "contractor",
    }),
  ]);
  if (!userLeg.ok || !contractorLeg.ok) {
    await setCallStatus(call.id, "failed");
    const errMsg = [
      !userLeg.ok ? `user: ${userLeg.error}` : "",
      !contractorLeg.ok ? `contractor: ${contractorLeg.error}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    return {
      contextMessage: wrapFallback(`go-between dial failed: ${errMsg}`),
    };
  }
  await patchCall(call.id, {
    status: "dialing",
    twilio_call_sid_user: userLeg.sid,
    twilio_call_sid_contractor: contractorLeg.sid,
  });

  const payload: CallPayload = {
    call_id: call.id,
    status: "dialing",
    contractor_name: resolved.name,
    contractor_phone: contractorPhone,
    user_phone: userPhone,
    transcript: [],
    recording_signed_url: null,
    estimate_id: null,
    started_at: null,
    ended_at: null,
    mode: "go_between",
  };

  return {
    variant: { kind: "call", payload },
    contextMessage: wrapGoBetweenStarted({ payload }),
  };
}

async function handleGenerateEstimate(args: {
  user_id: string | null;
  snapshot?: SurfaceSnapshot;
}): Promise<
  | { variant: SurfaceVariant; contextMessage: string }
  | { contextMessage: string }
> {
  if (!args.user_id) {
    return {
      contextMessage: wrapFallback("estimate generation requires sign-in"),
    };
  }
  // Source: the call currently on the drawer, OR the most recent
  // completed call. Snapshot.kind === 'call' carries the call_id via
  // contractorIds? No — the call payload doesn't put it there. We
  // stash the call_id in a new snapshot field, or fall back to most
  // recent. For simplicity, take the most recent completed call.
  const { listRecentCalls } = await import("../calls");
  const recent = await listRecentCalls({ user_id: args.user_id, limit: 5 });
  const call = recent.find(
    (c) => c.status === "completed" || c.status === "in_progress",
  );
  if (!call) {
    return {
      contextMessage: wrapFallback(
        "no recent call to estimate from — start a 3-way call first",
      ),
    };
  }

  const transcripts = await getRecentTranscriptForSession({
    session_id: call.id,
    limit: 200,
  });
  if (transcripts.length === 0) {
    return {
      contextMessage: wrapFallback(
        "the call has no transcript yet — wait a moment and try again",
      ),
    };
  }
  const chunks = transcripts.map((t) => ({
    speaker: t.speaker,
    text: t.text,
  }));

  const result = await extractLineItems({ chunks });
  if (!result.ok) {
    return {
      contextMessage: wrapFallback(
        `estimate extraction failed: ${result.reason}`,
      ),
    };
  }

  const contractorName = call.contractor_id
    ? (await fetchContractorById(call.contractor_id))?.name ?? null
    : null;

  const estimate = await createEstimate({
    user_id: args.user_id,
    contractor_id: call.contractor_id,
    call_id: call.id,
    scope_summary: result.scope_summary,
    line_items: result.line_items,
  });
  if (!estimate) {
    return {
      contextMessage: wrapFallback("estimate insert failed — see server logs"),
    };
  }

  const payload: EstimatePayload = {
    estimate_id: estimate.id,
    call_id: estimate.call_id,
    contractor_name: contractorName,
    scope_summary: estimate.scope_summary,
    line_items: estimate.line_items,
    subtotal_cents: estimate.subtotal_cents,
    tax_cents: estimate.tax_cents,
    total_cents: estimate.total_cents,
    currency: estimate.currency,
    status: estimate.status,
  };
  return {
    variant: { kind: "estimate", payload },
    contextMessage: wrapEstimateReady({ payload }),
  };
}

// ─── Recurring autopilot (M4.7) ────────────────────────────────────

function humanizeSchedule(
  row: RecurringJobRow,
): string {
  const sch = row.schedule;
  const dayNames: Record<string, string> = {
    SU: "Sunday", MO: "Monday", TU: "Tuesday", WE: "Wednesday",
    TH: "Thursday", FR: "Friday", SA: "Saturday",
  };
  const monthNames = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const everyN = sch.interval > 1 ? `Every ${sch.interval} ` : "Every ";

  let head = "";
  if (sch.freq === "WEEKLY") {
    if (sch.byday && sch.byday.length > 0) {
      const days = sch.byday.map((d) => dayNames[d]).join(" + ");
      head = sch.interval > 1
        ? `${everyN}weeks on ${days}`
        : `Every ${days}`;
    } else {
      head = `${everyN}week`;
    }
  } else if (sch.freq === "MONTHLY") {
    if (sch.bymonthday && sch.bymonthday.length > 0) {
      head = `${everyN}month on the ${sch.bymonthday.join(", ")}`;
    } else {
      head = `${everyN}month`;
    }
  } else {
    head = sch.interval > 1 ? `${everyN}days` : "Every day";
  }

  const hh = sch.byhour;
  const ampm = hh >= 12 ? "PM" : "AM";
  const dh = ((hh + 11) % 12) + 1;
  const mm = sch.byminute.toString().padStart(2, "0");
  const time = `${dh}:${mm} ${ampm}`;

  let tail = "";
  if (sch.bymonth && sch.bymonth.length > 0) {
    const first = sch.bymonth[0];
    const last = sch.bymonth[sch.bymonth.length - 1];
    tail = `, ${monthNames[first - 1]} through ${monthNames[last - 1]}`;
  }
  if (sch.until) {
    const u = new Date(sch.until);
    tail += `, until ${u.toLocaleDateString()}`;
  } else if (sch.count) {
    tail += `, ${sch.count} times`;
  }

  return `${head} at ${time}${tail}`;
}

async function handleScheduleRecurring(args: {
  slots: IntentSlots;
  user_id: string | null;
  snapshot?: SurfaceSnapshot;
  tz?: string | null;
}): Promise<
  | { variant: SurfaceVariant; contextMessage: string }
  | { contextMessage: string }
> {
  if (!args.user_id) {
    return {
      contextMessage: wrapFallback(
        "scheduling recurring jobs requires sign-in",
      ),
    };
  }
  if (!args.slots.recurring) {
    return {
      contextMessage: wrapFallback(
        "couldn't extract a recurring schedule from the request — say e.g. 'every Tuesday at 10am'",
      ),
    };
  }

  // Resolve contractor — same precedence as place_call:
  //   1. explicit contractor_ref slot
  //   2. top of the current surface (snapshot.contractorIds[0])
  //   3. null (homeowner-only recurring — rare but allowed)
  let contractorId: string | null = null;
  let contractorName: string | null = null;
  if (args.slots.contractor_ref) {
    const resolved = await resolveContractorRef({
      ref: args.slots.contractor_ref,
      snapshot: args.snapshot,
    });
    contractorId = resolved?.id ?? null;
    contractorName = resolved?.name ?? null;
  } else if (args.snapshot?.contractorIds?.length) {
    const firstId = args.snapshot.contractorIds[0];
    const resolved = await fetchContractorById(firstId);
    contractorId = resolved?.id ?? null;
    contractorName = resolved?.name ?? null;
  }

  // Silver-tier gate: this contractor must be on silver+ for the
  // homeowner to schedule recurring jobs THROUGH them. (Free/bronze
  // contractors don't get recurring booking; the silver tier sells
  // the autopilot capacity.)
  if (contractorId) {
    const tier = await getActiveTierForContractor(contractorId);
    if (!tierUnlocks(tier, "recurring_jobs")) {
      return {
        contextMessage: wrapFallback(
          `${contractorName ?? "that contractor"} is on the ${tier} plan; recurring jobs are a Silver+ feature. Pick another contractor or offer them an upgrade.`,
        ),
      };
    }
  }

  const tz =
    args.tz && typeof args.tz === "string" && args.tz.length > 0
      ? args.tz
      : "UTC";

  const row = await createRecurringJob({
    user_id: args.user_id,
    contractor_id: contractorId,
    title: args.slots.recurring.title,
    agenda: args.slots.agenda ?? args.slots.recurring.title,
    duration_minutes: 60,
    timezone: tz,
    schedule: args.slots.recurring.schedule,
    context: {
      source: "voice_intent",
      matched_phrase: args.slots.recurring.matched_phrase,
    },
  });
  if (!row) {
    return {
      contextMessage: wrapFallback(
        "recurring job insert failed — see server logs",
      ),
    };
  }

  // Compute the next 3 instances so 6 can read one out + the panel
  // shows the upcoming cadence.
  const now = new Date();
  const lookAhead = new Date(now.getTime() + 90 * 86_400_000); // 90d
  const next = expandInstances({
    schedule: row.schedule,
    timezone: row.timezone,
    anchor: new Date(row.active_from),
    from: now,
    to: lookAhead,
  }).slice(0, 3);

  const payload: RecurringJobPayload = {
    recurring_job_id: row.id,
    title: row.title,
    agenda: row.agenda,
    contractor_name: contractorName,
    schedule_human: humanizeSchedule(row),
    timezone: row.timezone,
    next_instances: next,
    status: row.status,
  };

  return {
    variant: { kind: "recurring", payload },
    contextMessage: wrapRecurringScheduled({ payload }),
  };
}

// ─── Top-level orchestrator ────────────────────────────────────────

export async function orchestrate(
  input: OrchestratorInput,
): Promise<OrchestratorOutput> {
  const classified = classifyIntent(input.text, { tz: input.tz ?? null });
  if (!classified.matched) {
    return { kind: "none", reason: classified.reason };
  }
  const { classification } = classified;

  // Only "high" confidence triggers actions. "medium" still gets
  // surfaced for diagnostic logging but doesn't fire backend calls
  // (avoids spurious surface updates on partial matches).
  if (classification.confidence !== "high") {
    return {
      kind: "action",
      classification,
      contextMessage: wrapFallback(
        `intent ${classification.kind} matched but slots insufficient`,
      ),
      debug: {
        confidence: classification.confidence,
        matched_rule: classification.matched_rule,
      },
    };
  }

  switch (classification.kind) {
    case "find_contractor": {
      const r = await handleFindContractor({ slots: classification.slots });
      return {
        kind: "action",
        classification,
        variant: r.variant,
        contextMessage: r.contextMessage,
      };
    }
    case "tell_me_more": {
      const r = await handleTellMeMore({
        slots: classification.slots,
        snapshot: input.currentSurface,
      });
      return {
        kind: "action",
        classification,
        variant: "variant" in r ? r.variant : undefined,
        contextMessage: r.contextMessage,
      };
    }
    case "recommend": {
      const r = await handleRecommend({
        slots: classification.slots,
        user_id: input.user_id,
        snapshot: input.currentSurface,
      });
      return {
        kind: "action",
        classification,
        variant: "variant" in r ? r.variant : undefined,
        contextMessage: r.contextMessage,
      };
    }
    case "book": {
      const r = await handleBook({
        slots: classification.slots,
        snapshot: input.currentSurface,
        user_id: input.user_id,
      });
      return {
        kind: "action",
        classification,
        variant: "variant" in r ? r.variant : undefined,
        contextMessage: r.contextMessage,
      };
    }
    case "deliberate_open": {
      const r = await handleDeliberateOpen({
        slots: classification.slots,
        user_id: input.user_id,
        snapshot: input.currentSurface,
      });
      return {
        kind: "action",
        classification,
        variant: "variant" in r ? r.variant : undefined,
        contextMessage: r.contextMessage,
      };
    }
    case "deliberate_refine": {
      const r = await handleDeliberateRefine({
        slots: classification.slots,
        user_id: input.user_id,
        snapshot: input.currentSurface,
      });
      return {
        kind: "action",
        classification,
        variant: "variant" in r ? r.variant : undefined,
        contextMessage: r.contextMessage,
      };
    }
    case "schedule_appointment": {
      const r = await handleScheduleAppointment({
        slots: classification.slots,
        user_id: input.user_id,
        snapshot: input.currentSurface,
      });
      return {
        kind: "action",
        classification,
        variant: "variant" in r ? r.variant : undefined,
        contextMessage: r.contextMessage,
      };
    }
    case "reschedule_appointment": {
      const r = await handleRescheduleAppointment({
        slots: classification.slots,
        user_id: input.user_id,
        snapshot: input.currentSurface,
      });
      return {
        kind: "action",
        classification,
        variant: "variant" in r ? r.variant : undefined,
        contextMessage: r.contextMessage,
      };
    }
    case "cancel_appointment": {
      const r = await handleCancelAppointment({
        user_id: input.user_id,
      });
      return {
        kind: "action",
        classification,
        variant: "variant" in r ? r.variant : undefined,
        contextMessage: r.contextMessage,
      };
    }
    case "view_appointments": {
      const r = await handleViewAppointments({
        user_id: input.user_id,
      });
      return {
        kind: "action",
        classification,
        variant: "variant" in r ? r.variant : undefined,
        contextMessage: r.contextMessage,
      };
    }
    case "draft_contract": {
      const r = await handleDraftContract({
        slots: classification.slots,
        user_id: input.user_id,
        snapshot: input.currentSurface,
      });
      return {
        kind: "action",
        classification,
        variant: "variant" in r ? r.variant : undefined,
        contextMessage: r.contextMessage,
      };
    }
    case "file_dispute": {
      const r = await handleFileDispute({
        slots: classification.slots,
        user_id: input.user_id,
        snapshot: input.currentSurface,
        raw_text: input.text,
        app_origin: input.app_origin ?? null,
      });
      return {
        kind: "action",
        classification,
        variant: "variant" in r ? r.variant : undefined,
        contextMessage: r.contextMessage,
      };
    }
    case "place_call": {
      const r = await handlePlaceCall({
        slots: classification.slots,
        user_id: input.user_id,
        snapshot: input.currentSurface,
      });
      return {
        kind: "action",
        classification,
        variant: "variant" in r ? r.variant : undefined,
        contextMessage: r.contextMessage,
      };
    }
    case "generate_estimate": {
      const r = await handleGenerateEstimate({
        user_id: input.user_id,
        snapshot: input.currentSurface,
      });
      return {
        kind: "action",
        classification,
        variant: "variant" in r ? r.variant : undefined,
        contextMessage: r.contextMessage,
      };
    }
    case "schedule_recurring": {
      const r = await handleScheduleRecurring({
        slots: classification.slots,
        user_id: input.user_id,
        snapshot: input.currentSurface,
        tz: input.tz,
      });
      return {
        kind: "action",
        classification,
        variant: "variant" in r ? r.variant : undefined,
        contextMessage: r.contextMessage,
      };
    }
    case "report_no_show": {
      const r = await handleReportNoShow({
        user_id: input.user_id,
        raw_text: input.text,
      });
      return {
        kind: "action",
        classification,
        variant: "variant" in r ? r.variant : undefined,
        contextMessage: r.contextMessage,
      };
    }
    case "go_between_mode": {
      const r = await handleGoBetweenMode({
        slots: classification.slots,
        user_id: input.user_id,
        snapshot: input.currentSurface,
      });
      return {
        kind: "action",
        classification,
        variant: "variant" in r ? r.variant : undefined,
        contextMessage: r.contextMessage,
      };
    }
  }
}
