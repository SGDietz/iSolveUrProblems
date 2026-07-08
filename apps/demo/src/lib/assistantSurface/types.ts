/**
 * Assistant Surface — types (M3.0b).
 *
 * The "results pop up on screen" right-side drawer that 6 drives during
 * voice conversations. Lives at the locale layout level so it persists
 * across navigation. The chat intent classifier (M3.0e) and any other
 * voice-driven action source can push variants into the store; the
 * surface component reads the active variant and renders the matching
 * panel.
 *
 * v1 covers exactly the four variants the M3.0d voice test drive needs:
 *   - contractors: ranked search results
 *   - summary:     review synthesis for one contractor
 *   - picks:       top 3 recommendations
 *   - pickResult:  win/lose notification dispatch outcome
 *
 * These are deliberately slim, client-friendly subsets of the M2 server
 * types. The orchestrator (M3.0e) maps server responses to these.
 */

/** Slim contractor card shape — only the fields the surface renders. */
export type ContractorCard = {
  id: string;
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
  /** Real scraped/self-onboarded email or null — the panel renders an email
   * line ONLY when this is a real address (most rows are null; never
   * invented — Herm TASK_094 item 3, G's Call/Email pillbox ask). */
  email?: string | null;
  /** Optional composite score 0..1 from the recommender. */
  score?: number;
  /** "Timonium, Maryland 21093" — shown under the reviews line (Herm
   * TASK_086 card-contents v1; honesty anchor for nearby-fill cards). */
  area_label?: string;
  /** Set on nearby persisted fill cards (3-minimum, G "boom boom boom"):
   * same broader area, exact distance unknown — UI + brain must never
   * present these as exact-local. */
  distance_note?: "same_area_unknown";
};

/** A single recommendation pick — same as ContractorCard plus a reason. */
export type RecommendationCard = ContractorCard & {
  reason: string;
};

/** Review-summary payload as the surface needs it. */
export type SummaryPayload = {
  contractor_id: string;
  contractor_name: string;
  summary: string;
  strengths_md: string;
  weaknesses_md: string;
  sample_quotes: Array<{ quote: string; rating: number | null }>;
};

/** Win/lose dispatch result — one entry per notified contractor. */
export type PickResultPerson = {
  contractor_id: string;
  name: string;
  channel: string | null;
  delivered: boolean;
  error?: string;
};

export type PickResultPayload = {
  winner: PickResultPerson | null;
  losers: PickResultPerson[];
  total_sent: number;
  total_failed: number;
};

/**
 * Side-by-side compare payload (M3.8). Two picks rendered as full cards
 * with a list of differentiators highlighted. Used by the deliberation
 * loop — the v1 view shows pairs since 6's voice typically narrates a
 * 2-way comparison; the panel can extend to 3 if needed later.
 */
export type ComparePayload = {
  picks: RecommendationCard[];
  /**
   * Brief, comma-separated headlines per pick — what makes each
   * distinctive. Generated server-side from the differentiator math
   * so the brain and the panel agree on the same talking points.
   */
  headlines: string[];
  /**
   * Human-readable list of filters currently in effect, for the UI label
   * (e.g. "locally owned · same-day · ≤ 5 km"). The brain narrates these
   * naturally; the panel renders them as chips.
   */
  active_constraints: string[];
  /** Memory-fact preferences surfaced via M1.2. */
  preference_facts: string[];
  /**
   * Machine-readable carryover state so multi-turn deliberation can
   * accumulate constraints across utterances without losing the thread.
   * The client snapshot reads this on each turn and the orchestrator
   * starts the next deliberation from here.
   */
  state: {
    category: string;
    constraints: {
      locally_owned?: boolean;
      same_day?: boolean;
      min_rating?: number;
      max_price_tier?: 1 | 2 | 3 | 4;
      max_distance_km?: number;
      exclude_ids?: string[];
    };
  };
};

/**
 * Appointment payload (M3.4 + M3.5). Used both for confirming a fresh
 * schedule/reschedule and for showing "your upcoming appointment" cards.
 * When `appointments.length === 1` we render a single confirmation card;
 * when > 1, a stacked list.
 */
export type AppointmentCard = {
  id: string;
  contractor_id: string | null;
  contractor_name: string | null;
  scheduled_at: string;       // ISO UTC
  scheduled_when_text: string; // human-friendly: "tomorrow at 10:00 AM"
  duration_minutes: number;
  agenda: string;
  status: "scheduled" | "rescheduled" | "cancelled" | "completed" | "no_show";
};

export type AppointmentSurfacePayload = {
  appointments: AppointmentCard[];
  /** What just happened — used by the panel header copy. */
  intent_kind: "scheduled" | "rescheduled" | "cancelled" | "list" | "no_show";
};

/**
 * Contract draft / signing-status payload (M3.7). Used to show the
 * homeowner a confirmation that the work agreement was generated and
 * dispatched for e-signature.
 */
export type ContractPayload = {
  contract_id: string;
  contractor_name: string;
  scope: string;
  amount_cents: number;
  platform_fee_cents: number;
  currency: string;
  envelope: {
    provider: "mock" | "dropbox_sign";
    envelope_id: string;
    status:
      | "draft"
      | "sent"
      | "awaiting_signature"
      | "signed"
      | "declined"
      | "cancelled"
      | "expired";
    signing_url_user: string | null;
    signing_url_contractor: string | null;
  };
};

/**
 * M3.9 — Dispute thread surface. Renders the running async-text thread
 * with 6 (the mediator) on one side and the homeowner on the other. The
 * panel exposes Accept (when there's a remedy_proposal on the latest
 * mediator turn) and Get a human (escalate) buttons.
 */
export type DisputeThreadMessage = {
  id: string;
  sender: "user" | "contractor" | "mediator" | "system";
  body: string;
  kind:
    | "message"
    | "remedy_proposal"
    | "escalation_notice"
    | "resolution_confirmation";
  /** ISO UTC. */
  created_at: string;
  /** Surfaced on the panel — only present on remedy_proposal kind. */
  proposed_resolution?: {
    resolution_kind:
      | "refund_full"
      | "refund_partial"
      | "redo_work"
      | "no_action"
      | "human_escalation";
    summary: string;
  };
};

export type DisputePayload = {
  dispute_id: string;
  status:
    | "open"
    | "awaiting_user"
    | "resolved"
    | "escalated"
    | "closed";
  complaint: string;
  disputed_amount_cents: number | null;
  contractor_name: string | null;
  contract_id: string | null;
  messages: DisputeThreadMessage[];
};

/**
 * M3.1 — Live phone-call panel. Mirrors the call's state in the drawer
 * so the homeowner can watch the conference connect, see who's joined,
 * and read the rolling transcript while talking.
 */
export type CallTranscriptLine = {
  id: string;
  speaker: "user" | "contractor" | "six" | "system";
  text: string;
  created_at: string;
};

export type CallPayload = {
  call_id: string;
  status:
    | "queued"
    | "dialing"
    | "in_progress"
    | "completed"
    | "failed"
    | "no_answer"
    | "busy"
    | "cancelled";
  contractor_name: string | null;
  contractor_phone: string | null;
  user_phone: string;
  transcript: CallTranscriptLine[];
  recording_signed_url: string | null;
  estimate_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  /**
   * M4.9 — Distinguishes a remote 3-way (default) from a go-between
   * mediation where the homeowner + contractor are physically together
   * and 6 joins via one or both phones. The transcript surface renders
   * a "shared transcript" affordance in go_between mode.
   */
  mode?: "remote" | "go_between";
};

/**
 * M4.7 — Recurring job confirmation panel. Renders the schedule's
 * human-readable summary + the next 3 materialized instances so the
 * homeowner can confirm the cadence is right.
 */
export type RecurringJobPayload = {
  recurring_job_id: string;
  title: string;
  agenda: string;
  contractor_name: string | null;
  /** Human-readable summary like "Every Tuesday at 10:00 AM, May through October". */
  schedule_human: string;
  timezone: string;
  /** Next 3 ISO UTC instances the cron will materialize. */
  next_instances: string[];
  status: "active" | "paused" | "ended" | "cancelled";
};

/**
 * M3.6 — Estimate panel. Renders the line-item breakdown + totals.
 */
export type EstimateLine = {
  description: string;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  total_cents: number;
};

export type EstimatePayload = {
  estimate_id: string;
  call_id: string | null;
  contractor_name: string | null;
  scope_summary: string;
  line_items: EstimateLine[];
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  currency: string;
  status: "draft" | "sent" | "accepted" | "declined" | "expired";
};

/**
 * TASK_061 — contractor self-onboarding surface. 6 collects a trade pro's
 * profile by voice; this panel mirrors what's captured + what's still needed.
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
  categories?: string[];
  city?: string;
  state?: string;
  lat?: number;
  lng?: number;
  phone?: string;
  email?: string;
  licensed_flag?: boolean;
  same_day_flag?: boolean;
  locally_owned?: boolean;
};

export type ContractorOnboardingPayload = {
  status: "collecting" | "saved";
  draft: ContractorOnboardingDraft;
  missing_fields: ContractorOnboardingField[];
  contractor_id?: string;
  confirmation?: string;
};

/** One open item on the visible list panel (Herm TASK_082: lists were
 * voice-only — persisted + spoken but never SHOWN; G: "I want those
 * pillboxes to go down"). */
export type TodoSurfaceItem = {
  id: string;
  title: string;
  position: number;
};

export type TodoPayload = {
  list_id: string;
  list_title: string;
  items: TodoSurfaceItem[];
  /** What just changed — drives the panel's one-line confirmation. */
  changed?: {
    added?: string[];
    completed?: string[];
    removed?: string[];
    cleared?: number;
    already_there?: string[];
  };
  /**
   * True when the panel renders a LOCAL-ONLY guest list (G live smoke
   * 2026-07-04: an anonymous rider must still SEE the list on 6's chest).
   * Never treated as persisted DB state — zero rows exist for it.
   */
  transient?: boolean;
  /** User-visible honesty banner, e.g. "Not saved yet" for guest lists. */
  persistence_note?: string;
};

/** The variant union — discriminated by `kind`. */
export type SurfaceVariant =
  | { kind: "contractors"; hits: ContractorCard[]; total_considered: number }
  | { kind: "summary"; payload: SummaryPayload; cached: boolean }
  | {
      kind: "picks";
      picks: RecommendationCard[];
      preference_facts: string[];
    }
  | { kind: "pickResult"; payload: PickResultPayload }
  | { kind: "compare"; payload: ComparePayload }
  | { kind: "appointment"; payload: AppointmentSurfacePayload }
  | { kind: "contract"; payload: ContractPayload }
  | { kind: "dispute"; payload: DisputePayload }
  | { kind: "call"; payload: CallPayload }
  | { kind: "estimate"; payload: EstimatePayload }
  | { kind: "todo"; payload: TodoPayload }
  | { kind: "contractorOnboarding"; payload: ContractorOnboardingPayload }
  | { kind: "recurring"; payload: RecurringJobPayload };

export type SurfaceVariantKind = SurfaceVariant["kind"];
