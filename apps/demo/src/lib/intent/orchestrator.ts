import {
  searchContractors,
  getContractorSummary,
  getContractorWithReviews,
  isSummaryStale,
  summarizeReviews,
  upsertContractorSummary,
  recommendContractors,
  deliberate,
  missingContractorOnboardingFields,
  upsertSelfOnboardedContractor,
  type ContractorOnboardingDraft,
  type ContractorCategorySlug,
  type ContractorRow,
  type ContractorSearchHit,
  type DeliberateConstraints,
} from "../contractors";
import { findContractorsLive } from "../contractors/liveFind";
import { extractContactDetails } from "../contactExtraction";
import { extractCategory, extractLocation, extractLocationText } from "./slots";
import {
  createAppointment,
  rescheduleAppointment,
  cancelAppointment,
  listUpcomingAppointments,
  findRecentUnfulfilledAppointment,
  declareNoShowAndDispatch,
  type AppointmentRow,
} from "../appointments";
import {
  createRecurringJob,
  expandInstances,
  type RecurringJobRow,
} from "../recurring";
import { getActiveTierForContractor, tierUnlocks } from "../billing";
import {
  addItems,
  clearList,
  findClaimedContractorId,
  listLists,
  listOpenItems,
  resolveTargetList,
  resolveListPick,
  setItemStatus,
  splitSpokenItems,
  type ListIndexEntry,
  type ListItemRow,
  type ListRow,
} from "../lists";
import { getSupabaseAdminConfig } from "../supabaseAdmin";
import { classifyIntent } from "./classify";
import {
  cleanForContext,
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
  wrapContractorOnboardingPrompt,
  wrapContractorProfileSaved,
  wrapFallback,
  wrapRecommendationsResult,
  wrapSummaryResult,
  wrapTodoAdded,
  wrapTodosList,
  wrapTodoCompleted,
  wrapTodoRemoved,
  wrapListCleared,
  wrapListIndex,
  wrapNoShowDispatched,
  wrapRecurringScheduled,
} from "./contextInjector";
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
  userKnowsContractor,
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
  ContractorOnboardingField,
  RecommendationCard,
  SummaryPayload,
  SurfaceVariant,
  TodoPayload,
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
    | "todo"
    | "contractorOnboarding"
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
  /**
   * Set client-side while 6 is waiting on a city/ZIP for a contractor find
   * (G smoke 2026-07-01: bare "21093" answers went nowhere and the brain
   * invented a plumber). The location-answer rule resumes the find with
   * this category.
   */
  pendingFind?: {
    category: string;
  };
  /**
   * Set after 6 reads the user's list index and asks "Which one?". The next
   * short pick ("first one", "Henderson") opens that list instead of falling
   * through to the brain/no-op.
   */
  pendingListIndex?: {
    entries: ListIndexEntry[];
  };
  /**
   * Set client-side when 6 SPOKE an add-offer ("Want me to add milk?" —
   * detected on the avatar transcript via ADD_OFFER_RE, items parsed with
   * parseOfferedAddItems). One-shot: the next user utterance either resolves
   * it (bare "yes" → deterministic list add via the add_offer rule) or kills
   * it. aiASAP ITEM 4 behavior, now wired (Herm TASK_070 blocker #2).
   */
  pendingAddOffer?: {
    items: string[];
  };
  /**
   * Set client-side after 6 asked "what should I put on it?" (make-list with
   * no items). The next plain answer becomes real list items via the
   * relaxed pending-answer splitter (Herm TASK_094 blocker #2).
   */
  pendingListAdd?: {
    listName?: string | null;
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
      /** True for a voice UI-dismiss action: clear/hide the current surface. */
      dismissSurface?: boolean;
      contextMessage?: string;
      /** Multi-turn continuations the client must remember and echo back in
       *  the next snapshot (e.g. a find waiting on the user's city/ZIP). */
      pending?:
        | { kind: "find"; category: string }
        | { kind: "list_index"; entries: ListIndexEntry[] }
        | { kind: "list_add"; listName?: string | null };
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
  const qs = new URLSearchParams();
  qs.set("select", "id,name");
  qs.set("limit", "1");
  if (isUuid(id)) {
    qs.set("id", `eq.${id}`);
  } else {
    // A non-UUID id is a live Outscraper card whose DB-UUID rehydration
    // didn't land in time (persistence timed out/failed) — resolve it by
    // provider source_id like fetchSnapshotContractorMeta does, so ordinal
    // details/book still work (Herm TASK_072 #1 fallback gap). The row is
    // returned with its real DB UUID, so everything downstream uses that.
    qs.set("source", "eq.outscraper_live");
    qs.set("source_id", `eq.${id}`);
  }
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
  email?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  score?: number;
  area_label?: string;
  distance_note?: "same_area_unknown";
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
    // Real scraped/self-onboarded emails only — most rows are null and the
    // panel renders nothing then (never invent one; Herm TASK_094 item 3).
    email: c.email ?? null,
    score: c.score,
    area_label: c.area_label ?? areaLabel(c),
    distance_note: c.distance_note,
  };
}

// ─── Per-intent handlers ────────────────────────────────────────────

/** Dedupe merged hits by phone (digits) then name — first wins. */
function dedupeContractorHits(hits: ContractorSearchHit[]): ContractorSearchHit[] {
  const seen = new Set<string>();
  const out: ContractorSearchHit[] = [];
  for (const h of hits) {
    const key = h.phone?.replace(/\D/g, "") || h.name.toLowerCase().trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

// Persisted REAL supply (Herm TASK_081 patch A): the sacred contractors DB
// compounds with every search — a live Outscraper blip must never erase rows
// we already hold. Self-onboarded rows are durable; outscraper_live rows are
// cached live supply, bounded to recent sightings so stale pros don't serve.
const REAL_PERSISTED_CONTRACTOR_SOURCES = ["self_onboarded", "outscraper_live"];
const OUTSCRAPER_PERSISTED_FALLBACK_DAYS = 14;

function extractZipOnly(locationText?: string | null): string | null {
  const m = locationText?.trim().match(/^\d{5}$/);
  return m?.[0] ?? null;
}

function scorePersistedContractor(row: ContractorRow): number {
  const ratingScore =
    typeof row.rating_avg === "number"
      ? Math.max(0, Math.min(1, (row.rating_avg - 1) / 4))
      : 0;
  const confidence =
    typeof row.rating_count === "number" ? Math.min(1, row.rating_count / 25) : 0;
  return ratingScore * (0.6 + 0.4 * confidence);
}

function persistedRowToUnknownDistanceHit(row: ContractorRow): ContractorSearchHit {
  return {
    ...row,
    // ZIP-only fallback has no user coords. Keep distance unknown; UI/voice
    // already hide 0 instead of saying fake-local miles/km.
    distance_km: 0,
    score: scorePersistedContractor(row),
  };
}

async function searchPersistedContractorsByZip(args: {
  category: string;
  zip: string;
  limit?: number;
}): Promise<ContractorSearchHit[] | null> {
  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return null;
  }

  const limit = Math.min(Math.max(args.limit ?? 3, 1), 20);
  const since = new Date(
    Date.now() - OUTSCRAPER_PERSISTED_FALLBACK_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const qs = new URLSearchParams();
  qs.set("select", "*");
  qs.append("categories", `cs.{${args.category}}`);
  qs.set("zip", `eq.${args.zip}`);
  qs.append("source", `in.(${REAL_PERSISTED_CONTRACTOR_SOURCES.join(",")})`);
  qs.append("source", "not.in.(mock,seed)");
  // Self-onboarded rows are durable supply. Outscraper rows are cached live
  // supply, so bound them to recent sightings to avoid stale marketplace cards.
  qs.set("or", `(source.eq.self_onboarded,last_seen_at.gte.${since})`);
  qs.set("limit", String(limit));
  qs.set("order", "rating_avg.desc.nullslast");

  try {
    const res = await fetch(`${url}/rest/v1/contractors?${qs.toString()}`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as ContractorRow[];
    return rows
      .filter(
        (row) =>
          row.source === "self_onboarded" ||
          Date.parse(row.last_seen_at) >= Date.parse(since),
      )
      .map(persistedRowToUnknownDistanceHit)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } catch {
    return null;
  }
}

async function searchPersistedRealContractors(args: {
  category: string;
  locationText?: string | null;
  near: { lat: number; lng: number } | null;
  limit?: number;
}): Promise<ContractorSearchHit[]> {
  const limit = args.limit ?? 3;
  // Bound the DB side so a Supabase stall can't delay the live results.
  const fallback = new Promise<null>((resolve) =>
    setTimeout(() => resolve(null), 4000),
  );

  const result = await Promise.race([
    args.near
      ? searchContractors({
          category: args.category,
          near: args.near,
          radius_km: 80,
          limit,
          sources: REAL_PERSISTED_CONTRACTOR_SOURCES,
        }).then((r) => (r.error ? null : r.hits))
      : (() => {
          const zip = extractZipOnly(args.locationText);
          return zip
            ? searchPersistedContractorsByZip({
                category: args.category,
                zip,
                limit,
              })
            : Promise.resolve(null);
        })(),
    fallback,
  ]).catch(() => null);

  return result ?? [];
}

// G's 3-card minimum (voice note 2026-07-02: "definitely three of those
// boxes... boom boom boom"). When live + exact-ZIP persisted supply comes up
// short, fill from persisted NEARBY rows (same 3-digit ZIP prefix) — LABELED
// "same area, distance unknown" so neither the UI nor the brain ever passes
// them off as exact-local (Herm TASK_086 patch; his 082 deferral superseded
// by G's directive).
const CONTRACTOR_CARD_TARGET_COUNT = 3;

type CardAnnotatedHit = ContractorSearchHit & {
  area_label?: string;
  distance_note?: "same_area_unknown";
};

function areaLabel(row: {
  city?: string | null;
  state?: string | null;
  zip?: string | null;
}): string | undefined {
  const cityState = [row.city, row.state].filter(Boolean).join(", ");
  return [cityState, row.zip].filter(Boolean).join(" ") || undefined;
}

function markNearbyFill(hit: ContractorSearchHit): CardAnnotatedHit {
  return {
    ...hit,
    distance_km: 0,
    area_label: areaLabel(hit) ?? "Same area",
    distance_note: "same_area_unknown",
  };
}

async function searchPersistedNearbyContractorsByZip(args: {
  category: string;
  zip: string;
  excludeIds: Set<string>;
  limit: number;
}): Promise<CardAnnotatedHit[]> {
  const prefix = args.zip.slice(0, 3);
  if (prefix.length !== 3) return [];
  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return [];
  }
  const since = new Date(
    Date.now() - OUTSCRAPER_PERSISTED_FALLBACK_DAYS * 86400000,
  ).toISOString();
  const qs = new URLSearchParams();
  qs.set("select", "*");
  qs.append("categories", `cs.{${args.category}}`);
  qs.set("zip", `like.${prefix}%`);
  qs.append("source", `in.(${REAL_PERSISTED_CONTRACTOR_SOURCES.join(",")})`);
  qs.append("source", "not.in.(mock,seed)");
  qs.set("or", `(source.eq.self_onboarded,last_seen_at.gte.${since})`);
  qs.set("order", "rating_avg.desc.nullslast");
  qs.set("limit", String(Math.min(args.limit + args.excludeIds.size + 8, 24)));

  try {
    const res = await fetch(`${url}/rest/v1/contractors?${qs.toString()}`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    });
    if (!res.ok) return [];
    const rows = (await res.json()) as ContractorRow[];
    return rows
      .filter((row) => row.zip !== args.zip)
      .filter(
        (row) =>
          !args.excludeIds.has(row.id) && !args.excludeIds.has(row.source_id),
      )
      .map((row) => markNearbyFill(persistedRowToUnknownDistanceHit(row)))
      .sort((a, b) => b.score - a.score)
      .slice(0, args.limit);
  } catch {
    return [];
  }
}

async function handleFindContractor(args: {
  slots: IntentSlots;
  snapshot?: SurfaceSnapshot;
}): Promise<{
  variant?: SurfaceVariant;
  contextMessage: string;
  pending?: { kind: "find"; category: string };
}> {
  // "Show me more" (G Droid smoke 2026-07-02): re-run the find around what's
  // already ON SCREEN — category/area come from the first visible card's
  // persisted row, the pull goes deeper, and only genuinely NEW pros count.
  // Honest when the deeper pull finds nothing fresh — never pad the list.
  if (args.slots.more) {
    const screenIds = args.snapshot?.contractorIds ?? [];
    const meta = screenIds[0]
      ? await fetchSnapshotContractorMeta(screenIds[0])
      : null;
    const moreCategory = args.slots.category ?? meta?.categories?.[0] ?? "general";
    const moreLocationText =
      meta?.zip ||
      [meta?.city, meta?.state].filter(Boolean).join(", ") ||
      undefined;
    const moreNear =
      meta?.lat != null && meta?.lng != null
        ? { lat: meta.lat, lng: meta.lng }
        : null;
    if (!moreLocationText && !moreNear) {
      return {
        contextMessage: wrapFallback(
          "wanted more pros but couldn't tell the area from the cards on screen — ask for their city or ZIP",
        ),
      };
    }
    const [moreLive, morePersisted] = await Promise.all([
      findContractorsLive({
        category: moreCategory,
        locationText: moreLocationText,
        near: moreNear,
        limit: 8,
      }),
      searchPersistedRealContractors({
        category: moreCategory,
        locationText: moreLocationText,
        near: moreNear,
        limit: 8,
      }),
    ]);
    const moreLiveHits = !moreLive.error ? moreLive.hits : [];
    const moreMerged = dedupeContractorHits([
      ...morePersisted,
      ...moreLiveHits,
    ]).slice(0, 8);
    const screen = new Set(screenIds);
    const fresh = moreMerged.filter(
      (h) => !screen.has(h.id) && !screen.has(h.source_id),
    );
    if (fresh.length === 0) {
      return {
        contextMessage: `[FIND MORE — not spoken by user] The user asked for more ${cleanForContext(moreCategory)}s, but a deeper pull found no NEW real pros beyond the ones already on screen. Say honestly that's every real one you could pull right now — never invent or pad the list.`,
      };
    }
    const moreHits: ContractorCard[] = fresh.slice(0, 8).map(contractorRowToCard);
    return {
      variant: {
        kind: "contractors",
        hits: moreHits,
        total_considered: moreHits.length,
      },
      contextMessage: wrapContractorsResult({
        category: moreCategory,
        location_text: moreLocationText,
        hits: moreHits,
      }),
    };
  }

  const category = args.slots.category ?? "general";
  const locationText = args.slots.location_text;
  const near = args.slots.location ?? null;

  // REAL supply only (G 2026-06-30: real or nothing). Live Outscraper pull PLUS
  // persisted REAL supply: self-onboarded rows and recently seen Outscraper rows
  // already saved to the sacred contractors DB (Herm TASK_081: a live provider
  // blip/zero must not erase real rows we already know about — G's 21093 smoke
  // heard "no plumbers" while the DB held three). NEVER mock/seed. Coords give
  // real distance; ZIP-only fallback hides distance rather than inventing one.
  // Ask BOTH sources for 8, not 3 (G iPad smoke 2026-07-03: "2 fucking
  // painters. Where the fuck is 3 fucking painters"). Outscraper returns up
  // to 20 real businesses; asking for only 3 left thin areas short after
  // dedup. Pulling 8 gets enough REAL local pros to fill the 3 cards with
  // genuine supply instead of leaning on the nearby-fill band-aid. Still
  // capped to CONTRACTOR_CARD_TARGET_COUNT for display.
  const [live, persistedHits] = await Promise.all([
    findContractorsLive({ category, locationText, near, limit: 8 }),
    searchPersistedRealContractors({
      category,
      locationText,
      near,
      limit: 8,
    }),
  ]);

  const liveHits = !live.error ? live.hits : [];
  let merged: CardAnnotatedHit[] = dedupeContractorHits([
    ...persistedHits,
    ...liveHits,
  ]).slice(0, CONTRACTOR_CARD_TARGET_COUNT);

  // 3-card minimum (G "boom boom boom"): thin live/exact-ZIP supply fills
  // from persisted NEARBY rows, explicitly labeled — never passed off as
  // exact-local (Herm TASK_086).
  const fillZip = extractZipOnly(locationText);
  if (
    fillZip &&
    merged.length < CONTRACTOR_CARD_TARGET_COUNT
  ) {
    const excludeIds = new Set<string>();
    for (const h of merged) {
      excludeIds.add(h.id);
      if (h.source_id) excludeIds.add(h.source_id);
    }
    // NO state filter: live cards say "MD" while persisted rows say
    // "Maryland" — the eq. filter silently zeroed the fill (G's smoke #6:
    // 2 painters, not 3). The 3-digit ZIP prefix is already state-safe.
    const nearby = await searchPersistedNearbyContractorsByZip({
      category,
      zip: fillZip,
      excludeIds,
      limit: CONTRACTOR_CARD_TARGET_COUNT - merged.length,
    });
    merged = dedupeContractorHits([...merged, ...nearby]).slice(
      0,
      CONTRACTOR_CARD_TARGET_COUNT,
    ) as CardAnnotatedHit[];
  }

  if (merged.length > 0) {
    const hits: ContractorCard[] = merged.map(contractorRowToCard);
    return {
      variant: { kind: "contractors", hits, total_considered: hits.length },
      contextMessage: wrapContractorsResult({
        category,
        location_text: locationText,
        hits,
      }),
    };
  }

  // No pros: if we don't have the user's area, ask for it; otherwise report
  // the hiccup honestly. NEVER invent contractors, NEVER serve seed/mock data.
  if (!locationText) {
    return {
      contextMessage: `[FIND — not spoken by user] The user wants a ${cleanForContext(category)} but you don't have their area yet. In first person as 6, ask what city or ZIP they're in so you can pull REAL local pros. Do NOT invent or name any contractors — the moment they answer, the real list arrives on its own.`,
      // The client remembers this and echoes it back in the next snapshot,
      // so a bare "21093" answer resumes THIS find (G smoke 2026-07-01).
      pending: { kind: "find", category },
    };
  }
  // locationText is raw user speech — cleaned before it reaches the brain
  // (Herm TASK_072 blocker #9).
  return {
    contextMessage: `[FIND — not spoken by user] The live directory returned no ${cleanForContext(category)}s near "${cleanForContext(locationText)}" right now (temporary). Warmly tell them you couldn't pull any this second and offer to try again. Do NOT invent or name any contractors.`,
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
      // HONEST gate (Herm release blocker #2): live-scraped pros carry a real
      // star rating + review COUNT but no review TEXT corpus yet. 6 must say
      // exactly that — never synthesize what reviewers "say".
      if (fresh.reason === "too_few_reviews") {
        return {
          contextMessage: [
            `[REVIEW SUMMARY UNAVAILABLE — not spoken by user]`,
            `${cleanForContext(resolved.name)} has no review text on file with us yet — only the overall star rating and review count already shown on their card.`,
            `Respond as 6 in first person: point at the star rating and review count on the card as the real signal, and say you don't have their written reviews on file yet. NEVER invent, paraphrase, or imply specific review content. One or two sentences.`,
          ].join("\n"),
        };
      }
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

/**
 * Shared LIVE-supply fallback (G doctrine 2026-07-03: Outscraper is PRIMARY,
 * the DB is a near-empty cache). Any DB-backed handler that comes up empty or
 * thin re-runs the live directory and shows REAL cards instead of dead-ending.
 * Returns null when there's no place string to search or live returns nothing
 * — the caller then keeps its own honest "offer to pull fresh" message.
 */
async function liveContractorsFallbackVariant(args: {
  category: string | null;
  locationText: string | null;
  near: { lat: number; lng: number } | null;
}): Promise<{ variant: SurfaceVariant; contextMessage: string } | null> {
  const locationText = args.locationText?.trim() || null;
  if (!locationText) return null;
  const category = args.category ?? "general";
  const live = await findContractorsLive({
    category,
    locationText,
    near: args.near,
    limit: 8,
  });
  if (live.error || live.hits.length === 0) return null;
  const hits: ContractorCard[] = live.hits
    .slice(0, CONTRACTOR_CARD_TARGET_COUNT)
    .map(contractorRowToCard);
  return {
    variant: { kind: "contractors", hits, total_considered: hits.length },
    contextMessage: wrapContractorsResult({
      category,
      location_text: locationText,
      hits,
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
  // Use the category + area from the contractors already on screen so
  // "which one?" ranks near what the user is looking at. If we can't resolve a
  // real location (user's coords OR the on-screen list's), ASK for city/ZIP —
  // never rank near a default center (Herm TASK_064 #3 / TASK_065 #3).
  const category =
    args.slots.category ?? (await inferCategoryFromSnapshot(args.snapshot));
  const inferredNear = args.slots.location
    ? null
    : await inferLocationFromSnapshot(args.snapshot);
  const near = args.slots.location ?? inferredNear;
  if (!near) {
    return {
      contextMessage:
        `[RECOMMEND — not spoken by user] No usable location — nothing on screen resolves to a place and the user hasn't given a city/ZIP. Respond as 6 in first person: ask what city or ZIP they're in (or offer to pull up some pros first) so you recommend REAL local options. One sentence. Do NOT default to any city.`,
    };
  }
  const result = await recommendContractors({
    userId: args.user_id,
    // Only speak distance when we know the USER's own coords (not inferred).
    distance_known: !!args.slots.location,
    searchInput: {
      category,
      near,
      radius_km: 25,
      min_rating: 4.5,
    },
  });
  // THIN (not just empty) → go live (G doctrine 2026-07-03: DB is a
  // near-empty cache, so a DB rank of 0-2 picks must pull REAL supply, not
  // show a lonely card). Outscraper is the primary engine.
  if (result.picks.length < CONTRACTOR_CARD_TARGET_COUNT) {
    const fallback = await liveContractorsFallbackVariant({
      category,
      locationText: args.slots.location_text ?? null,
      near,
    });
    if (fallback) return fallback;
    // Live had nothing usable AND the DB rank was thin — but if the DB DID
    // produce at least one real pick, show those rather than nothing.
    if (result.picks.length > 0) {
      // fall through to the picks render below
    } else return {
      contextMessage: [
        `[RECOMMEND — not spoken by user]`,
        `Nothing is saved for that trade near them yet, and no live pull ran (no confirmed place name).`,
        `Respond as 6 in first person: offer to pull up fresh, real local pros right now — confirm their city or ZIP in the same breath. One sentence. Do NOT name or invent any contractor.`,
      ].join("\n"),
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
function isUuid(v: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    v,
  );
}

/**
 * Resolve category + coords for a contractor that's currently on screen.
 * Live Outscraper cards carry the provider place_id as their `id`, while the
 * persisted DB row's `id` is a UUID and `source_id` = the place_id. So we look
 * up by `id` for a UUID and by `source_id` otherwise (Herm TASK_065 #3).
 */
async function fetchSnapshotContractorMeta(
  firstId: string,
): Promise<{
  categories: string[] | null;
  lat: number | null;
  lng: number | null;
  city: string | null;
  state: string | null;
  zip: string | null;
} | null> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const qs = new URLSearchParams();
    qs.set("select", "categories,lat,lng,city,state,zip");
    qs.set("limit", "1");
    if (isUuid(firstId)) {
      qs.set("id", `eq.${firstId}`);
    } else {
      // A non-UUID visible id is always a live Outscraper card (place_id).
      // Pin the source so another source can't win the source_id match.
      qs.set("source", "eq.outscraper_live");
      qs.set("source_id", `eq.${firstId}`);
    }
    const res = await fetch(`${url}/rest/v1/contractors?${qs.toString()}`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{
      categories: string[] | null;
      lat: number | null;
      lng: number | null;
      city: string | null;
      state: string | null;
      zip: string | null;
    }>;
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

async function inferCategoryFromSnapshot(
  snapshot?: SurfaceSnapshot,
): Promise<string> {
  if (snapshot?.deliberation?.category) return snapshot.deliberation.category;
  const firstId = snapshot?.contractorIds?.[0];
  if (!firstId) return "general";
  const meta = await fetchSnapshotContractorMeta(firstId);
  return meta?.categories?.[0] ?? "general";
}

/**
 * Infer the search area from the contractors currently on screen (the first
 * one's coords) so a follow-up "which one?" / "compare them" ranks near the
 * list the user is looking at instead of a default center. This is the RANKING
 * geometry only — we still never SPEAK a distance unless we know the user's own
 * coords (distance_known stays tied to slots.location).
 */
async function inferLocationFromSnapshot(
  snapshot?: SurfaceSnapshot,
): Promise<{ lat: number; lng: number } | null> {
  const firstId = snapshot?.contractorIds?.[0];
  if (!firstId) return null;
  const meta = await fetchSnapshotContractorMeta(firstId);
  if (meta?.lat != null && meta?.lng != null) {
    return { lat: meta.lat, lng: meta.lng };
  }
  return null;
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
  const inferredNear = args.slots.location
    ? null
    : await inferLocationFromSnapshot(args.snapshot);
  const near = args.slots.location ?? inferredNear;
  if (!near) {
    return {
      contextMessage:
        `[COMPARE — not spoken by user] No usable location — nothing on screen resolves to a place and the user hasn't given a city/ZIP. Respond as 6 in first person: ask what city or ZIP they're in (or offer to pull up some pros first) so you compare REAL local options. One sentence. Do NOT default to any city.`,
    };
  }
  const result = await deliberate({
    user_id: args.user_id,
    category,
    near,
    distance_known: !!args.slots.location,
    constraints: args.snapshot?.deliberation?.constraints ?? {},
    current_pick_ids: args.snapshot?.contractorIds,
  });
  if (!result.ok) {
    // Empty DB must not dead-end a compare (G doctrine 2026-07-03): pull
    // REAL live pros to compare against instead of erroring.
    const fallback = await liveContractorsFallbackVariant({
      category,
      locationText: args.slots.location_text ?? null,
      near,
    });
    if (fallback) return fallback;
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

  const inferredNear = args.slots.location
    ? null
    : await inferLocationFromSnapshot(args.snapshot);
  const near = args.slots.location ?? inferredNear;
  if (!near) {
    return {
      contextMessage:
        `[REFINE — not spoken by user] No usable location — nothing on screen resolves to a place and the user hasn't given a city/ZIP. Respond as 6 in first person: ask what city or ZIP they're in so you can pull REAL local options first. One sentence. Do NOT default to any city.`,
    };
  }
  const result = await deliberate({
    user_id: args.user_id,
    category,
    near,
    distance_known: !!args.slots.location,
    constraints: merged,
    current_pick_ids: args.snapshot?.contractorIds,
  });
  if (!result.ok) {
    // Empty DB must not dead-end a refine (G doctrine 2026-07-03): pull REAL
    // live pros so the user still has something to narrow. The spoken
    // constraints ride the brain context; the cards are the honest supply.
    const fallback = await liveContractorsFallbackVariant({
      category,
      locationText: args.slots.location_text ?? null,
      near,
    });
    if (fallback) return fallback;
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

  // REALITY DOCTRINE (G 2026-07-02: no fake data, ever): the M2.6 win/lose
  // fan-out isn't wired yet, and the old handler FAKED a "booked + everyone
  // notified" confirmation (delivered:true on nothing sent). Until real
  // dispatch ships, 6 tells the truth and routes to the actions that DO
  // work today: tap-to-call on the card, or 6 placing the call himself.
  return {
    contextMessage: [
      `[BOOKING NOT DISPATCHED — not spoken by user]`,
      `The user picked ${cleanForContext(resolved.name)}. Automatic booking/notification is NOT live yet — nothing was sent to anyone, and you must NOT claim it was.`,
      `Respond as 6 in first person: solid choice — offer to get them on the phone right now ("want me to call them?"), or point at the Call button on their card. Never say they were booked or notified. Two sentences max, warm.`,
    ].join("\n"),
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

// ─── Lists (G 2026-07-01: 6-led, voice-first; ported from aiASAP) ────
// Voice-first AND visible (Herm TASK_082 — lists were voice-only and G never
// SAW them: "I want those pillboxes to go down"): every successful list
// mutation/read also returns a `todo` surface variant so the panel shows the
// live list. Data lives in `lists` + `list_items` (20260701_lists.sql). All
// paths still fail SOFT into a spoken fallback so a missing table never
// breaks the talk flow.

/** Build the visible list panel payload from the list + its OPEN items. */
function todoVariant(
  list: ListRow,
  items: ListItemRow[],
  changed?: TodoPayload["changed"],
): SurfaceVariant {
  const sorted = [...items].sort(
    (a, b) =>
      a.position - b.position || a.created_at.localeCompare(b.created_at),
  );
  return {
    kind: "todo",
    payload: {
      list_id: list.id,
      list_title: list.title,
      items: sorted.map((item) => ({
        id: item.id,
        title: item.title,
        position: item.position,
      })),
      changed,
    },
  };
}

// GUEST STAGING (G live smoke 2026-07-04: "I need to see it on your chest
// right now" while anonymous — the old sign-in-only path showed NOTHING):
// anonymous list turns render a LOCAL, session-only todo panel so the list
// is visible on 6's chest, with a loud not-saved banner. ZERO db writes —
// the client (context.tsx) accumulates items across turns.
const LOCAL_TODO_LIST_ID_PREFIX = "local-unsaved-list";

function localTodoSlug(raw: string, fallback: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || fallback
  );
}

function localTodoListId(listTitle: string): string {
  // Keep guest/temp list identity per spoken list title. A single hard-coded
  // id merged "shopping" and "contractor" guest lists together in one
  // anonymous session (TASK_107 follow-on seam). Default empty make-list turns
  // still share the stable Your-list bucket across the ask→answer turn.
  return `${LOCAL_TODO_LIST_ID_PREFIX}-${localTodoSlug(listTitle, "default")}`;
}

function localTodoItemId(title: string, index: number): string {
  return `local-${index + 1}-${localTodoSlug(title, "item")}`;
}

function guestTodoVariant(args: {
  titles: string[];
  listName?: string | null;
  changed?: TodoPayload["changed"];
}): SurfaceVariant {
  const title = args.listName?.trim() || "Your list";
  return {
    kind: "todo",
    payload: {
      list_id: localTodoListId(title),
      list_title: title,
      transient: true,
      persistence_note: "Not saved yet — tell me your email to keep it.",
      items: args.titles.map((itemTitle, index) => ({
        id: localTodoItemId(itemTitle, index),
        title: itemTitle,
        position: index + 1,
      })),
      ...(args.changed ? { changed: args.changed } : {}),
    },
  };
}

// BETA LIST POLICY (G/Herm TASK_098 item 10, amended TASK_106): durable
// lists are sign-in-only. 6 must NEVER promise saving to an anonymous user —
// the guest list shows on screen as temporary, and the honest line names
// the exact path to keep it.
const SIGN_IN_FALLBACK =
  "the list is visible on screen as a TEMPORARY local list — it is NOT saved permanently. Never claim it was saved. Tell the user plainly: \"I can show it here for this session, but to save it for next time, set up your account — just tell me your email.\"";

/** Shared open of the spoken-command target list. Fail-soft null.
 * createIfMissing: only ADD commands may create a list on the fly —
 * read/complete/remove/clear must never conjure an empty list and then
 * pretend the user's old list was empty. */
async function openTargetList(args: {
  user_id: string;
  list_name?: string;
  createIfMissing?: boolean;
}): Promise<{
  list: ListRow;
  items: ListItemRow[];
} | null> {
  const contractorId = await findClaimedContractorId(args.user_id);
  const list = await resolveTargetList({
    user_id: args.user_id,
    contractor_id: contractorId,
    list_name: args.list_name ?? null,
    createIfMissing: args.createIfMissing,
  });
  if (!list) return null;
  const items = await listOpenItems({
    list_id: list.id,
    user_id: args.user_id,
  });
  return { list, items };
}

const NO_SUCH_LIST_FALLBACK =
  "no list by that name (and nothing to do without one) — tell the user which lists they have or offer to start one";

async function handlePendingListPick(
  input: OrchestratorInput,
): Promise<OrchestratorOutput | null> {
  const entries = input.currentSurface?.pendingListIndex?.entries ?? [];
  if (!input.user_id || entries.length === 0) return null;
  const picked = resolveListPick(input.text, entries);
  if (!picked) return null;

  const classification: IntentClassification = {
    kind: "view_todos",
    slots: { list_name: picked.title },
    confidence: "high",
    matched_rule: "todo.lists.pick",
  };
  const r = await handleViewTodos({
    slots: classification.slots,
    user_id: input.user_id,
  });
  return {
    kind: "action",
    classification,
    variant: r.variant,
    contextMessage: r.contextMessage,
  };
}

async function handleAddTodo(args: {
  slots: IntentSlots;
  user_id: string | null;
}): Promise<{
  contextMessage: string;
  variant?: SurfaceVariant;
  pending?: { kind: "list_add"; listName?: string | null };
}> {
  const raw = args.slots.todo_text?.trim();
  // Pre-split titles come from the pending-answer rule (relaxed splitter —
  // trade nouns allowed on that one turn, Herm TASK_094); everything else
  // goes through aiASAP's strict junk gate.
  const preSplit = (args.slots.todo_titles ?? []).filter(
    (t) => typeof t === "string" && t.trim().length > 0,
  );
  const titles =
    preSplit.length > 0
      ? preSplit.slice(0, 5)
      : raw
        ? splitSpokenItems(raw)
        : [];
  if (!args.user_id) {
    // GUEST STAGING (Herm TASK_106): show the local list on 6's chest —
    // honest banner, zero db writes. The client merges items across turns.
    if (titles.length === 0) {
      return {
        variant: guestTodoVariant({
          titles: [],
          listName: args.slots.list_name ?? null,
        }),
        contextMessage: wrapFallback(
          `${SIGN_IN_FALLBACK} The empty temporary list is on screen — ask the user, in first person as 6, what to put on it (their next plain answer WILL show on it).`,
        ),
        pending: {
          kind: "list_add",
          listName: args.slots.list_name ?? null,
        },
      };
    }
    return {
      variant: guestTodoVariant({
        titles,
        listName: args.slots.list_name ?? null,
        changed: { added: titles },
      }),
      contextMessage: wrapFallback(
        `${SIGN_IN_FALLBACK} These items are on the screen list now: ${titles.join(", ")}.`,
      ),
    };
  }
  if (titles.length === 0) {
    // Ask-and-REMEMBER (Herm TASK_094 blocker #2): without the pending
    // marker the user's plain answer ("a painter, a plumber, and a roofer")
    // matched nothing and the brain claimed a save that never happened.
    return {
      contextMessage: wrapFallback(
        "the list is ready but no items were caught — ask the user, in first person as 6, what to put on it (their next plain answer WILL be added for real)",
      ),
      pending: {
        kind: "list_add",
        listName: args.slots.list_name ?? null,
      },
    };
  }
  const opened = await openTargetList({
    user_id: args.user_id,
    list_name: args.slots.list_name,
  });
  if (!opened) {
    return {
      contextMessage: wrapFallback(
        "couldn't open the list — see server logs (lists tables live?)",
      ),
    };
  }
  const inserted = await addItems({
    list: opened.list,
    user_id: args.user_id,
    titles,
  });
  if (inserted.length === 0) {
    // Everything was already on the list (dedupe) — tell 6 the truth, and
    // SHOW the current list anyway (visible proof beats voice-only "already
    // there", Herm TASK_082).
    return {
      variant: todoVariant(opened.list, opened.items, {
        already_there: titles,
      }),
      contextMessage: wrapTodoAdded({
        titles: [],
        alreadyThere: titles,
        listTitle: opened.list.title,
        openCount: opened.items.length,
      }),
    };
  }
  return {
    variant: todoVariant(opened.list, [...opened.items, ...inserted], {
      added: inserted.map((i) => i.title),
    }),
    contextMessage: wrapTodoAdded({
      titles: inserted.map((i) => i.title),
      alreadyThere: [],
      listTitle: opened.list.title,
      openCount: opened.items.length + inserted.length,
    }),
  };
}

async function handleViewTodos(args: {
  slots: IntentSlots;
  user_id: string | null;
}): Promise<{
  contextMessage: string;
  variant?: SurfaceVariant;
  pending?: { kind: "list_add"; listName?: string | null };
}> {
  if (!args.user_id) {
    // GUEST STAGING (Herm TASK_106): "I want to see the list on your chest"
    // while anonymous opens the local panel — even empty — so the chest
    // list is REAL on screen; the next plain answer fills it.
    return {
      variant: guestTodoVariant({
        titles: [],
        listName: args.slots.list_name ?? null,
      }),
      contextMessage: wrapFallback(
        `${SIGN_IN_FALLBACK} The temporary list is open on screen now — ask the user what to put on it.`,
      ),
      pending: {
        kind: "list_add",
        listName: args.slots.list_name ?? null,
      },
    };
  }
  const opened = await openTargetList({
    user_id: args.user_id,
    list_name: args.slots.list_name,
    createIfMissing: false,
  });
  if (!opened) {
    return { contextMessage: wrapFallback(NO_SUCH_LIST_FALLBACK) };
  }
  return {
    variant: todoVariant(opened.list, opened.items),
    contextMessage: wrapTodosList({
      listTitle: opened.list.title,
      titles: opened.items.map((r) => r.title),
    }),
  };
}

async function handleViewLists(args: {
  user_id: string | null;
}): Promise<{ contextMessage: string; entries: ListIndexEntry[] }> {
  if (!args.user_id) {
    return { contextMessage: wrapFallback(SIGN_IN_FALLBACK), entries: [] };
  }
  const rows = await listLists({ user_id: args.user_id });
  const entries = rows.map((l) => ({ id: l.id, title: l.title }));
  return {
    contextMessage: wrapListIndex({ titles: entries.map((l) => l.title) }),
    entries,
  };
}

/** Resolve a todo_ref (ordinal or text) against the spoken-order items. */
function resolveItemRef(
  ref: NonNullable<IntentSlots["todo_ref"]>,
  items: ListItemRow[],
): ListItemRow | null {
  if (ref.type === "ordinal") {
    return items[ref.position - 1] ?? null;
  }
  const needle = ref.text.toLowerCase();
  return (
    items.find((r) => {
      const hay = r.title.toLowerCase();
      return hay.includes(needle) || needle.includes(hay);
    }) ?? null
  );
}

async function handleCompleteTodo(args: {
  slots: IntentSlots;
  user_id: string | null;
}): Promise<{ contextMessage: string; variant?: SurfaceVariant }> {
  if (!args.user_id) {
    return { contextMessage: wrapFallback(SIGN_IN_FALLBACK) };
  }
  const ref = args.slots.todo_ref;
  if (!ref) {
    return {
      contextMessage: wrapFallback(
        "couldn't tell which item to check off — ask the user which one",
      ),
    };
  }
  const opened = await openTargetList({
    user_id: args.user_id,
    list_name: args.slots.list_name,
    createIfMissing: false,
  });
  if (!opened) {
    return { contextMessage: wrapFallback(NO_SUCH_LIST_FALLBACK) };
  }
  if (opened.items.length === 0) {
    return { contextMessage: wrapFallback("the list is already empty") };
  }
  const target = resolveItemRef(ref, opened.items);
  if (!target) {
    return {
      contextMessage: wrapFallback(
        "couldn't match that to an item on the list — read the list back and ask which one",
      ),
    };
  }
  const row = await setItemStatus({
    item_id: target.id,
    user_id: args.user_id,
    status: "done",
  });
  if (!row) {
    return {
      contextMessage: wrapFallback("couldn't update the item — see server logs"),
    };
  }
  const remaining = opened.items.filter((i) => i.id !== target.id);
  return {
    variant: todoVariant(opened.list, remaining, { completed: [row.title] }),
    contextMessage: wrapTodoCompleted({
      title: row.title,
      listTitle: opened.list.title,
      openCount: remaining.length,
    }),
  };
}

async function handleRemoveTodo(args: {
  slots: IntentSlots;
  user_id: string | null;
}): Promise<{ contextMessage: string; variant?: SurfaceVariant }> {
  if (!args.user_id) {
    return { contextMessage: wrapFallback(SIGN_IN_FALLBACK) };
  }
  const opened = await openTargetList({
    user_id: args.user_id,
    list_name: args.slots.list_name,
    createIfMissing: false,
  });
  if (!opened) {
    return { contextMessage: wrapFallback(NO_SUCH_LIST_FALLBACK) };
  }
  if (opened.items.length === 0) {
    return { contextMessage: wrapFallback("the list is already empty") };
  }
  // Positions resolve against the SPOKEN order, all at once, BEFORE any
  // drop mutates the list (aiASAP: "remove both 1 and 2" must never drop
  // 1 then re-index and drop the wrong second item).
  let targets: ListItemRow[] = [];
  if (args.slots.todo_positions?.length) {
    targets = args.slots.todo_positions
      .map((p) => opened.items[p - 1])
      .filter((r): r is ListItemRow => Boolean(r));
  } else if (args.slots.todo_ref) {
    const one = resolveItemRef(args.slots.todo_ref, opened.items);
    if (one) targets = [one];
  }
  if (targets.length === 0) {
    return {
      contextMessage: wrapFallback(
        "couldn't match that to an item on the list — read the list back and ask which one",
      ),
    };
  }
  const removed: string[] = [];
  const removedIds = new Set<string>();
  for (const t of targets) {
    const row = await setItemStatus({
      item_id: t.id,
      user_id: args.user_id,
      status: "dropped",
    });
    if (row) {
      removed.push(row.title);
      removedIds.add(t.id);
    }
  }
  if (removed.length === 0) {
    return {
      contextMessage: wrapFallback("couldn't update the items — see server logs"),
    };
  }
  const remaining = opened.items.filter((i) => !removedIds.has(i.id));
  return {
    variant: todoVariant(opened.list, remaining, { removed }),
    contextMessage: wrapTodoRemoved({
      titles: removed,
      listTitle: opened.list.title,
      openCount: remaining.length,
    }),
  };
}

async function handleClearList(args: {
  slots: IntentSlots;
  user_id: string | null;
}): Promise<{ contextMessage: string; variant?: SurfaceVariant }> {
  if (!args.user_id) {
    return { contextMessage: wrapFallback(SIGN_IN_FALLBACK) };
  }
  const opened = await openTargetList({
    user_id: args.user_id,
    list_name: args.slots.list_name,
    createIfMissing: false,
  });
  if (!opened) {
    return { contextMessage: wrapFallback(NO_SUCH_LIST_FALLBACK) };
  }
  const cleared = await clearList({
    list_id: opened.list.id,
    user_id: args.user_id,
  });
  if (cleared < 0) {
    return {
      contextMessage: wrapFallback("couldn't clear the list — see server logs"),
    };
  }
  return {
    variant: todoVariant(opened.list, [], { cleared }),
    contextMessage: wrapListCleared({
      listTitle: opened.list.title,
      count: cleared,
    }),
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

// ─── M4.4 no-show report (merged per plan v2; handler verbatim-Bert) ──

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

// ─── M4.7 recurring autopilot (merged per plan v2; verbatim-Bert) ─────

function humanizeSchedule(row: RecurringJobRow): string {
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
  // homeowner to schedule recurring jobs THROUGH them.
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

  // Next 3 instances so 6 can read one out + the panel shows the cadence.
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

// ─── M4.9 go-between — REWRITTEN FAIL-CLOSED (plan v2 A4 / Herm) ──────
// Bert's original dialed both phone legs straight from a spoken command.
// Doctrine: a voice intent NEVER dials. This handler only (a) names the
// right contractor via the on-screen allowlist (Bert's good detail kept:
// stale appointment/contract panels must not pick the wrong person), and
// (b) returns honest guidance / a consent path. Actual dialing lives in
// the /api/calls routes behind the all-party consent ledger, and only
// once FEATURE_GO_BETWEEN_CALLS is flipped after legal + G approval.

async function handleGoBetweenMode(args: {
  slots: IntentSlots;
  user_id: string | null;
  snapshot?: SurfaceSnapshot;
}): Promise<{ contextMessage: string }> {
  const CONTRACTOR_ON_SCREEN_KINDS = new Set([
    "contractors",
    "summary",
    "picks",
    "pickResult",
    "compare",
  ]);
  const ref = args.slots.contractor_ref;
  const snapshotContractorId =
    args.snapshot && CONTRACTOR_ON_SCREEN_KINDS.has(args.snapshot.kind ?? "")
      ? args.snapshot.contractorIds?.[0]
      : undefined;
  const resolved = ref
    ? await resolveContractorRef({ ref, snapshot: args.snapshot })
    : snapshotContractorId
      ? await fetchContractorById(snapshotContractorId)
      : null;
  const who = resolved?.name ? cleanForContext(resolved.name) : "the contractor";

  if (!GO_BETWEEN_CALLS_ENABLED) {
    return {
      contextMessage: wrapFallback(
        `go-between mode isn't live yet — tell the user plainly, in first person as 6: "I can't join the conversation with ${who} by phone yet — that part of me is still being wired up. For now, tap the Call button on their card and I'll keep helping right here." NEVER claim a call was started.`,
      ),
    };
  }
  // Flag on: a spoken request is still NOT consent (all-party consent
  // ledger required — MD §10-402). Point at the consent surface; the
  // ledgered /api/calls path does the dialing after explicit YES taps.
  return {
    contextMessage: wrapFallback(
      `go-between needs explicit consent from everyone on the call before any dialing — ask the user to tap the Call button on ${who}'s card and confirm the consent sheet; the call connects from there, never from a spoken command alone.`,
    ),
  };
}

// ─── Phone call + estimate (M3.1 / M3.6) ────────────────────────────

const E164_RE = /^\+[1-9]\d{6,14}$/;

// TASK_061 — AI call automation is GATED OFF by default.
// Human-initiated tel: calls (the on-screen "Call" button) are fine. An AI
// 3-way conference that records/transcribes/estimates from the call needs
// ALL-PARTY consent (Maryland is an all-party state), TCPA review of the
// artificial-voice rules, and G's explicit approval. Until that consent +
// legal work ships, 6 hands the number to the user to tap-call. The M3.1
// Twilio conference path below stays dormant behind this flag (dormant-default
// pattern) — flip FEATURE_AI_CONFERENCE_CALLS=1 only after consent gating +
// G approval.
const AI_CONFERENCE_CALLS_ENABLED =
  process.env.FEATURE_AI_CONFERENCE_CALLS === "1";

// M4.9 go-between (in-person mediation) — SAME dormant-default doctrine.
// Flip only after all-party consent UX + legal review + G approval.
const GO_BETWEEN_CALLS_ENABLED =
  process.env.FEATURE_GO_BETWEEN_CALLS === "1";

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
  // Consent/legal gate: no AI-placed conference calls until consent + legal
  // work + G's approval. Hand the user to a human-initiated tap-to-call —
  // but only claim a card is on screen when one actually is (Herm #7).
  if (!AI_CONFERENCE_CALLS_ENABLED) {
    const contractorOnScreen =
      !!args.slots.contractor_ref ||
      (args.snapshot?.contractorIds?.length ?? 0) > 0;
    const guidance = contractorOnScreen
      ? `Tell them to tap "Call" on the contractor's card on screen to ring the pro themselves, and offer to stay on to help.`
      : `Ask which contractor they mean (there isn't one on screen yet) — once it's up, they can tap "Call" on that pro's card.`;
    return {
      contextMessage: [
        `[CALL — not spoken by user]`,
        `6 does NOT place automated AI calls yet (consent + legal gate).`,
        `Respond as 6 in first person: ${guidance} One or two short sentences. Do NOT claim you dialed or called anyone.`,
      ].join("\n"),
    };
  }

  // Defense in depth: even if FEATURE_AI_CONFERENCE_CALLS is accidentally
  // enabled, a *spoken* "call them" command is not enough consent for 6 to
  // create a call row or dial legs. The only safe future path is a UI consent
  // sheet that passes an explicit call_consent token; today's classifier never
  // sets this, so the voice-intent side-effect path remains fail-closed.
  if (args.slots.call_consent?.homeowner !== true) {
    const contractorOnScreen =
      !!args.slots.contractor_ref ||
      (args.snapshot?.contractorIds?.length ?? 0) > 0;
    const guidance = contractorOnScreen
      ? `Tell them to tap "Call" on the contractor's card and approve the consent sheet before any AI-assisted call can start.`
      : `Ask which contractor they mean (there isn't one on screen yet) — once it's up, they can tap "Call" on that pro's card and approve the consent sheet.`;
    return {
      contextMessage: [
        `[CALL — not spoken by user]`,
        `6 did NOT place an automated AI call. A spoken call request is not explicit call consent.`,
        `Respond as 6 in first person: ${guidance} One or two short sentences. Do NOT claim you dialed or called anyone.`,
      ].join("\n"),
    };
  }
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

  // Defense-in-depth with /api/calls/start (Herm TASK_116 P1): every future
  // dial path must prove the homeowner already has a real relationship with
  // this contractor before we fetch phones, create a call row, or spend
  // Twilio money.
  const knows = await userKnowsContractor({
    user_id: args.user_id,
    contractor_id: resolved.id,
  });
  if (!knows) {
    return {
      contextMessage: wrapFallback(
        "no existing relationship with this contractor — calls can only be placed to pros you have a contract, appointment, or prior call with",
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

// ─── Contractor self-onboarding (TASK_061 — SUPPLY side) ────────────
//
// 6 interviews a trade pro by voice and builds their profile — no form.
// Fields are extracted deterministically from the running transcript; the
// row is saved ONLY when the required fields are present (6 must never say
// "you're in" without a real DB row).

const REQUIRED_CONTRACTOR_ONBOARDING_FIELDS =
  new Set<ContractorOnboardingField>([
    "business_name",
    "trade",
    "service_area",
    "phone_or_email",
  ]);

function asYesNo(text: string, yes: RegExp, no: RegExp): boolean | undefined {
  if (no.test(text)) return false;
  if (yes.test(text)) return true;
  return undefined;
}

function extractBusinessName(text: string): string | undefined {
  // NOTE: longer alternatives first ("is called" before "is") so the verb
  // isn't captured into the name ("...is called Reliant" → "Reliant").
  const patterns = [
    /\b(?:my|our)\s+business\s+(?:is\s+called|name\s+is|is)\s+([A-Z0-9][\w&'.\- ]{1,80})/i,
    /\b(?:company|business)\s+name\s+(?:is\s+called|is)\s+([A-Z0-9][\w&'.\- ]{1,80})/i,
    /\b(?:it'?s|its|we'?re|we are)\s+called\s+([A-Z0-9][\w&'.\- ]{1,80})/i,
    /\b(?:i\s+run|we\s+run|i\s+own|we\s+own)\s+([A-Z0-9][\w&'.\- ]{1,80})/i,
    /^\s*(?:It\s+is|It's|That\s+is|That's)\s+([A-Z0-9][\w&'.\- ]{1,80})\s*[.!?]?\s*$/,
  ];
  for (const pattern of patterns) {
    const value = match1(pattern, text);
    if (value && value.length >= 2) return value;
  }
  return undefined;
}

function match1(pattern: RegExp, text: string): string | undefined {
  return text
    .match(pattern)?.[1]
    // Drop a leftover leading verb the alternation may have kept.
    ?.replace(/^(?:called|is)\s+/i, "")
    // Stop the name at the service-area clause or a trailing conjunction so
    // "Bright Spark Electric out of Denver" saves as "Bright Spark Electric".
    .replace(
      /\s+(?:out\s+of|based\s+in|located\s+in|serving|near|around|in|and|but|we|i)\b.*$/i,
      "",
    )
    .replace(/[.!?,;:]+$/g, "")
    .trim();
}

function extractState(text: string): string | undefined {
  const match = text.match(
    /\b(?:in|near|around|serving|out\s+of|based\s+in)\s+[A-Za-z .'-]{2,40},\s*([A-Z]{2})\b/,
  );
  return match?.[1]?.toUpperCase();
}

function buildContractorOnboardingDraft(text: string): ContractorOnboardingDraft {
  const contact = extractContactDetails(text);
  const category = extractCategory(text);
  const location = extractLocation(text);
  return {
    business_name: extractBusinessName(text),
    categories: category ? [category as ContractorCategorySlug] : undefined,
    // Raw text captures ANY city/ZIP (nationwide); coords only for known cities.
    city: extractLocationText(text) ?? location?.text,
    state: extractState(text),
    // REAL coords only (recognized city). Never a DEFAULT_CENTER / Austin
    // fake — the city string alone satisfies service_area.
    lat: location?.coords.lat,
    lng: location?.coords.lng,
    phone: contact.phone ?? undefined,
    email: contact.email ?? undefined,
    licensed_flag: asYesNo(
      text,
      /\b(licensed|license\s+is\s+active|fully\s+licensed)\b/i,
      /\b(not\s+licensed|unlicensed|no\s+license|not\s+yet\s+licensed)\b/i,
    ),
    same_day_flag: asYesNo(
      text,
      /\b(same[- ]day|emergency|asap)\b/i,
      /\b(no\s+same[- ]day|not\s+same[- ]day|scheduled\s+only)\b/i,
    ),
    locally_owned: asYesNo(
      text,
      /\b(locally\s+owned|local\s+business|family\s+owned|owner[- ]operated)\b/i,
      /\b(franchise|not\s+local|national\s+chain)\b/i,
    ),
  };
}

function mergeDrafts(
  earlier: ContractorOnboardingDraft,
  later: ContractorOnboardingDraft,
): ContractorOnboardingDraft {
  return {
    business_name: later.business_name ?? earlier.business_name,
    categories: later.categories?.length ? later.categories : earlier.categories,
    city: later.city ?? earlier.city,
    state: later.state ?? earlier.state,
    lat: later.lat ?? earlier.lat,
    lng: later.lng ?? earlier.lng,
    phone: later.phone ?? earlier.phone,
    email: later.email ?? earlier.email,
    licensed_flag: later.licensed_flag ?? earlier.licensed_flag,
    same_day_flag: later.same_day_flag ?? earlier.same_day_flag,
    locally_owned: later.locally_owned ?? earlier.locally_owned,
  };
}

async function getContractorOnboardingDraft(args: {
  session_id: string;
  slots: IntentSlots;
}): Promise<{ draft: ContractorOnboardingDraft; sourceText: string }> {
  const rows = await getRecentTranscriptForSession({
    session_id: args.session_id,
    limit: 80,
  });
  const userLines = rows
    .filter((r) => r.speaker === "user")
    .map((r) => r.text.trim())
    .filter(Boolean);
  const sourceText = userLines.join("\n");
  let draft: ContractorOnboardingDraft = {};
  for (const line of userLines) {
    draft = mergeDrafts(draft, buildContractorOnboardingDraft(line));
  }
  // Backfill from the triggering utterance's slots if the transcript scan
  // missed the trade/city (e.g. the very first turn before it's persisted).
  if (!draft.categories?.length && args.slots.category) {
    draft.categories = [args.slots.category as ContractorCategorySlug];
  }
  if (!draft.business_name && args.slots.business_name) {
    draft.business_name = args.slots.business_name;
  }
  if (!draft.phone && args.slots.phone) {
    draft.phone = args.slots.phone;
  }
  if (!draft.email && args.slots.email) {
    draft.email = args.slots.email;
  }
  if (!draft.city && args.slots.location_text) {
    draft.city = args.slots.location_text;
    draft.lat = args.slots.location?.lat;
    draft.lng = args.slots.location?.lng;
  }
  return { draft, sourceText };
}

async function handleOnboardContractor(args: {
  session_id: string;
  slots: IntentSlots;
}): Promise<{ variant: SurfaceVariant; contextMessage: string }> {
  const { draft } = await getContractorOnboardingDraft({
    session_id: args.session_id,
    slots: args.slots,
  });
  const payload = {
    status: "collecting" as const,
    draft,
    missing_fields: missingContractorOnboardingFields(draft),
  };
  return {
    variant: { kind: "contractorOnboarding", payload },
    contextMessage: wrapContractorOnboardingPrompt({ payload }),
  };
}

async function handleSaveContractorProfile(args: {
  session_id: string;
  user_id: string | null;
  slots: IntentSlots;
}): Promise<{ variant: SurfaceVariant; contextMessage: string }> {
  const { draft, sourceText } = await getContractorOnboardingDraft({
    session_id: args.session_id,
    slots: args.slots,
  });
  const missing = missingContractorOnboardingFields(draft);
  const criticalMissing = missing.filter((field) =>
    REQUIRED_CONTRACTOR_ONBOARDING_FIELDS.has(field),
  );
  if (criticalMissing.length > 0) {
    const payload = {
      status: "collecting" as const,
      draft,
      missing_fields: missing,
    };
    return {
      variant: { kind: "contractorOnboarding", payload },
      contextMessage: wrapContractorOnboardingPrompt({ payload }),
    };
  }

  const saved = await upsertSelfOnboardedContractor({
    ...draft,
    session_id: args.session_id,
    user_id: args.user_id,
    source_text: sourceText,
  });
  if (!saved.ok) {
    const payload = {
      status: "collecting" as const,
      draft,
      missing_fields: missing,
    };
    return {
      variant: { kind: "contractorOnboarding", payload },
      contextMessage: wrapFallback(
        `contractor profile save failed: ${saved.reason}`,
      ),
    };
  }

  const payload = {
    status: "saved" as const,
    draft,
    missing_fields: [] as ContractorOnboardingField[],
    contractor_id: saved.contractor_id,
    confirmation: `You're in, ${saved.name}.`,
  };
  return {
    variant: { kind: "contractorOnboarding", payload },
    contextMessage: wrapContractorProfileSaved({ payload }),
  };
}

// ─── Top-level orchestrator ────────────────────────────────────────

export async function orchestrate(
  input: OrchestratorInput,
): Promise<OrchestratorOutput> {
  const pendingListPick = await handlePendingListPick(input);
  if (pendingListPick) return pendingListPick;

  const classified = classifyIntent(input.text, {
    tz: input.tz ?? null,
    currentSurfaceKind: input.currentSurface?.kind ?? null,
    pendingFindCategory: input.currentSurface?.pendingFind?.category ?? null,
    pendingAddOfferItems: input.currentSurface?.pendingAddOffer?.items ?? null,
    pendingListAdd: input.currentSurface?.pendingListAdd ?? null,
  });
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
    case "dismiss_surface": {
      return {
        kind: "action",
        classification,
        dismissSurface: true,
        contextMessage:
          "[SURFACE DISMISSED — not spoken by user] I cleared the visible panel. Respond in first person as 6 with one short acknowledgement, no extra explanation.",
      };
    }
    case "onboard_contractor": {
      const r = await handleOnboardContractor({
        session_id: input.session_id,
        slots: classification.slots,
      });
      return {
        kind: "action",
        classification,
        variant: r.variant,
        contextMessage: r.contextMessage,
      };
    }
    case "save_contractor_profile": {
      const r = await handleSaveContractorProfile({
        session_id: input.session_id,
        user_id: input.user_id,
        slots: classification.slots,
      });
      return {
        kind: "action",
        classification,
        variant: r.variant,
        contextMessage: r.contextMessage,
      };
    }
    case "find_contractor": {
      const r = await handleFindContractor({
        slots: classification.slots,
        snapshot: input.currentSurface,
      });
      return {
        kind: "action",
        classification,
        variant: r.variant,
        contextMessage: r.contextMessage,
        pending: r.pending,
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
      // Fail-closed by design (plan v2 A4): never dials; guidance only.
      const r = await handleGoBetweenMode({
        slots: classification.slots,
        user_id: input.user_id,
        snapshot: input.currentSurface,
      });
      return {
        kind: "action",
        classification,
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
    case "add_todo": {
      const r = await handleAddTodo({
        slots: classification.slots,
        user_id: input.user_id,
      });
      return {
        kind: "action",
        classification,
        variant: r.variant,
        contextMessage: r.contextMessage,
        pending: r.pending,
      };
    }
    case "view_todos": {
      const r = await handleViewTodos({
        slots: classification.slots,
        user_id: input.user_id,
      });
      return {
        kind: "action",
        classification,
        variant: r.variant,
        contextMessage: r.contextMessage,
        pending: r.pending,
      };
    }
    case "complete_todo": {
      const r = await handleCompleteTodo({
        slots: classification.slots,
        user_id: input.user_id,
      });
      return {
        kind: "action",
        classification,
        variant: r.variant,
        contextMessage: r.contextMessage,
      };
    }
    case "remove_todo": {
      const r = await handleRemoveTodo({
        slots: classification.slots,
        user_id: input.user_id,
      });
      return {
        kind: "action",
        classification,
        variant: r.variant,
        contextMessage: r.contextMessage,
      };
    }
    case "clear_list": {
      const r = await handleClearList({
        slots: classification.slots,
        user_id: input.user_id,
      });
      return {
        kind: "action",
        classification,
        variant: r.variant,
        contextMessage: r.contextMessage,
      };
    }
    case "view_lists": {
      const r = await handleViewLists({
        user_id: input.user_id,
      });
      return {
        kind: "action",
        classification,
        contextMessage: r.contextMessage,
        pending: r.entries.length > 0
          ? { kind: "list_index", entries: r.entries }
          : undefined,
      };
    }
  }
}
