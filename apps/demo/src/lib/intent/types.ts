/**
 * M3.0e — Intent classifier types.
 *
 * 4 intents power the M3.0d test drive:
 *   - find_contractor  → user wants a list of contractors for a category
 *   - tell_me_more     → user wants details about a specific contractor
 *   - recommend        → user wants 6's top picks with reasons
 *   - book             → user wants to choose a contractor (fires M2.6
 *                         simulation in v1 test drive)
 *
 * The classifier is rules-based (regex) for v1 to keep latency <50 ms.
 * Slot extraction returns explicit structured data; the orchestrator
 * uses slots to call the right M2 backend route.
 *
 * "Contractor refs" are how the user identifies a specific contractor —
 * either by ordinal position in the most-recent list ("the first one",
 * "#2") or by name ("Acme Plumbing"). The client resolves ordinals
 * against the current assistant-surface state at action time.
 */

export type IntentKind =
  | "find_contractor"
  | "tell_me_more"
  | "recommend"
  | "book"
  | "deliberate_open"
  | "deliberate_refine"
  | "schedule_appointment"
  | "reschedule_appointment"
  | "cancel_appointment"
  | "view_appointments"
  | "draft_contract"
  | "file_dispute"
  | "place_call"
  | "generate_estimate"
  | "schedule_recurring"
  | "report_no_show"
  | "go_between_mode";

/** A reference to a specific contractor in conversation context. */
export type ContractorRef =
  | { type: "ordinal"; position: number }
  | { type: "name"; name: string };

/** Slot bag — only the union of fields any intent uses. */
export type IntentSlots = {
  /** Category slug (matches M2's 15-category taxonomy). */
  category?: string;
  /** A textual location string the user said ("Austin, TX"). */
  location_text?: string;
  /** Resolved lat/lng. The orchestrator handles the lookup. */
  location?: { lat: number; lng: number };
  /** Reference to a specific contractor (for tell_me_more / book). */
  contractor_ref?: ContractorRef;
  /** Filters mentioned (locally-owned, same-day, min-rating, etc.). */
  filters?: {
    locally_owned?: boolean;
    same_day?: boolean;
    min_rating?: number;
    max_price_tier?: 1 | 2 | 3 | 4;
    max_distance_km?: number;
  };
  /**
   * For deliberate_refine — when the user says "not that one", the client
   * resolves the referenced ID(s) against its current surface and the
   * orchestrator adds them to the running exclude list.
   */
  exclude_ref?: ContractorRef;
  /**
   * For schedule_appointment / reschedule_appointment — the extracted
   * date/time in ISO UTC + the original phrase the user said.
   */
  when?: { iso_utc: string; phrase: string };
  /** Free-form agenda text — what the appointment is for. */
  agenda?: string;
  /** For draft_contract — extracted dollar amount in cents. */
  amount_cents?: number;
  /** For draft_contract — free-form work scope text. */
  scope?: string;
  /**
   * For file_dispute — the free-form complaint phrase extracted from
   * the user's utterance. Becomes the opening message of the thread.
   */
  complaint?: string;
  /**
   * For schedule_recurring — the recurring-schedule shape extracted from
   * the user's utterance, plus a short title. The orchestrator hands
   * this to the recurring_jobs row insert.
   */
  recurring?: {
    title: string;
    schedule: import("../recurring").RecurringSchedule;
    matched_phrase: string;
  };
};

/** Confidence buckets — chosen at classify time, used by orchestrator. */
export type IntentConfidence = "high" | "medium" | "low";

export type IntentClassification = {
  kind: IntentKind;
  slots: IntentSlots;
  confidence: IntentConfidence;
  /** The matched regex / rule identifier — for diagnostic logging. */
  matched_rule: string;
};

/** Either a classification or an explicit "no match". */
export type ClassifyResult =
  | { matched: true; classification: IntentClassification }
  | { matched: false; reason: string };

/**
 * Per-classification context — flows into rule.build() so time-aware
 * rules can localize wall-clock phrases. Today carries the user's IANA
 * timezone; future versions may carry locale, current surface, etc.
 */
export type ClassifyContext = {
  tz?: string | null;
};
