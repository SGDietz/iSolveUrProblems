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
  | "dismiss_surface"
  | "onboard_contractor"
  | "save_contractor_profile"
  | "add_todo"
  | "view_todos"
  | "complete_todo"
  | "remove_todo"
  | "clear_list"
  | "view_lists"
  | "schedule_recurring"
  | "report_no_show"
  | "go_between_mode";

/** A reference to a specific contractor in conversation context. */
export type ContractorRef =
  | { type: "ordinal"; position: number }
  | { type: "name"; name: string };

/**
 * A reference to a to-do item — by position on the spoken list ("check off
 * the first one") or by words from the item ("mark the anode rod done").
 */
export type TodoRef =
  | { type: "ordinal"; position: number }
  | { type: "text"; text: string };

/** Slot bag — only the union of fields any intent uses. */
export type IntentSlots = {
  /** Category slug (matches M2's 15-category taxonomy). */
  category?: string;
  /** A textual location string the user said ("Austin, TX"). */
  location_text?: string;
  /** Resolved lat/lng. The orchestrator handles the lookup. */
  location?: { lat: number; lng: number };
  /** "Show me more" — re-run the last find (context inferred from the
   * on-screen cards) at a deeper limit (G Droid smoke 2026-07-02). */
  more?: boolean;
  /** Reference to a specific contractor (for tell_me_more / book). */
  contractor_ref?: ContractorRef;
  /**
   * Explicit homeowner call consent from a UI consent sheet. Never infer this
   * from a spoken transcript; voice text like "call them" is not legal/all-party
   * consent for 6 to place or monitor a conference call.
   */
  call_consent?: { homeowner: true; source: "card_consent_sheet" };
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
  /** For add_todo — the raw items tail in the user's words (may be several:
   * "bread, butter and jam"; the handler splits + sanity-filters). */
  todo_text?: string;
  /** For contractor self-onboarding continuation turns. These fields are
   * captured only while the onboarding surface is active, so short answers
   * like "It is Wild Works" / "443-797-2166" can update the panel. */
  business_name?: string;
  phone?: string;
  email?: string;
  /** For add_todo — PRE-SPLIT items from the pending-list-answer rule
   * (relaxed splitter; trade nouns allowed on that one turn — Herm
   * TASK_094). Bypasses the strict splitter in the handler. */
  todo_titles?: string[];
  /** For complete_todo / remove_todo — which item. */
  todo_ref?: TodoRef;
  /** For remove_todo — 1-based positions ("remove both 1 and 2"). */
  todo_positions?: number[];
  /** Named list target ("...to my house list", "...on the Henderson job
   * list"). Absent = the default To-Do list. */
  list_name?: string;
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
  /**
   * Current assistant-surface kind. Keeps short confirm phrases like "done"
   * / "save it" from firing a global save unless a contractor-onboarding flow
   * is actually on screen.
   */
  currentSurfaceKind?: string | null;
  /**
   * Set when 6 just asked "what city or ZIP?" for a contractor find (G smoke
   * 2026-07-01: he answered "21093" and NOTHING fired — no rule matches a
   * bare ZIP, so the brain hallucinated a fake plumber). Lets the bare
   * location-answer rule resume the pending find with this category.
   */
  pendingFindCategory?: string | null;
  /**
   * Set when 6 SPOKE an add-offer ("Want me to add milk?") on his previous
   * turn. A whole-utterance affirmative resolves these items into a real,
   * deterministic list add (aiASAP ITEM 4; Herm TASK_070 blocker #2).
   */
  pendingAddOfferItems?: string[] | null;
  /**
   * Set when 6 just asked "what should I put on it?" after a make-list with
   * no items (G smoke #6: "keep lists for me" → "a painter, a plumber, and a
   * roofer" — the answer turn has no list verb and uses trade words the
   * strict sanity gate rejects; this routes it into add_todo with the
   * relaxed pending-answer splitter. Herm TASK_094 blocker #2).
   */
  pendingListAdd?: { listName?: string | null } | null;
};
