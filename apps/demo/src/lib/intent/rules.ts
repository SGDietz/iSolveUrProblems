/**
 * M3.0e — Intent rules.
 *
 * Each rule maps a regex pattern (or set of patterns) to one of the 4
 * core intents. Rules are evaluated in priority order — first match
 * wins. More specific patterns come first; broader ones last.
 *
 * Confidence:
 *   - high: the rule fired AND all required slots resolved
 *   - medium: rule fired, some slots present, others missing (orchestrator
 *     fills defaults)
 *   - low: weak match (kept for diagnostic logging, not actioned)
 *
 * Verbal patterns are anchored loosely — speech-to-text often drops
 * articles ("a", "the"), capitalizes inconsistently, and inserts filler
 * words. Patterns tolerate that.
 */

import {
  extractAmount,
  extractCategory,
  extractComplaint,
  extractContractorRef,
  extractFilters,
  extractLocation,
  extractScope,
} from "./slots";
import { extractDateTime } from "../appointments/extractDateTime";
import { parseRecurringSchedule } from "../recurring";
import type { ClassifyContext, ClassifyResult, IntentSlots } from "./types";

type Rule = {
  id: string;
  /** Returns truthy if the rule matches; falsy otherwise. */
  match: (text: string) => boolean;
  /** Builds slots from the text + extractors + classification context. */
  build: (text: string, ctx: ClassifyContext) => IntentSlots;
  /** The intent kind this rule produces. */
  kind:
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
    | "schedule_recurring";
  /** Required slot keys — if any are missing the result is "medium". */
  required: Array<keyof IntentSlots>;
};

/** Cheap pre-check for any time/day token. Used to gate appointment rules. */
const TIME_HINT_RE =
  /\b(tomorrow|tonight|today|next\s+\w+|this\s+\w+|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|in\s+\d+\s+(hour|minute|day|week)|\d{1,2}\s*(am|pm)|\d{4}-\d{2}-\d{2})\b/i;

/**
 * Pull out a free-form agenda phrase from "for X" / "about Y" patterns.
 * Best-effort — empty string is OK; the orchestrator falls back to the
 * default agenda text.
 */
function extractAgenda(text: string): string | undefined {
  const m = text.match(
    /\b(?:for|about|to)\s+(the\s+)?([a-z][\w\s-]{2,80}?)\s+(?:tomorrow|tonight|today|next|this|monday|tuesday|wednesday|thursday|friday|saturday|sunday|at\s+\d|in\s+\d)/i,
  );
  if (m) return m[2].trim();
  return undefined;
}

const RULES: readonly Rule[] = [
  // ─── DELIBERATE_REFINE ────────────────────────────────────────────
  // Highest priority — phrases like "not that one, too far" should
  // beat both book.imperative AND recommend.which.
  {
    id: "deliberate.refine.not_that_one",
    match: (t) =>
      /\bnot\s+(that|the\s+first|the\s+top|that\s+one|him|her|them)\b/i.test(
        t,
      ),
    build: (t) => {
      const filters = extractFilters(t);
      return {
        exclude_ref: extractContractorRef(t) ?? {
          type: "ordinal",
          position: 1,
        },
        filters: Object.keys(filters).length > 0 ? filters : undefined,
      };
    },
    kind: "deliberate_refine",
    required: [],
  },
  {
    id: "deliberate.refine.add_constraint",
    match: (t) =>
      /\b(only|just)\s+(local|locally|same[- ]day|under|cheaper|highly\s+rated|top[- ]rated)|\b(closer\s+than|within|less\s+than|no\s+more\s+than|under)\s+\d+\s*(?:km|kilometers?|miles?|mi)\b/i.test(
        t,
      ),
    build: (t) => {
      const filters = extractFilters(t);
      return {
        filters: Object.keys(filters).length > 0 ? filters : undefined,
      };
    },
    kind: "deliberate_refine",
    required: ["filters"],
  },
  // ─── DELIBERATE_OPEN ──────────────────────────────────────────────
  // "I can't decide", "help me decide" — invitation to open the
  // deliberation panel.
  {
    id: "deliberate.open",
    match: (t) =>
      /\b(i\s+can'?t\s+decide|i\s+don'?t\s+know\s+which|help\s+me\s+(decide|choose|pick)|hard\s+to\s+choose|compare\s+(them|those|these))\b/i.test(
        t,
      ),
    build: () => ({}),
    kind: "deliberate_open",
    required: [],
  },
  // ─── CANCEL_APPOINTMENT ───────────────────────────────────────────
  // Very specific — "cancel my appointment" / "cancel the appointment".
  // Comes before reschedule so "cancel" isn't accidentally treated as
  // a reschedule trigger.
  {
    id: "cancel.appointment",
    match: (t) =>
      /\b(cancel|cancel\s+the|cancel\s+my|call\s+off|drop)\s+(my|the|that)?\s*(appointment|meeting|booking|visit)\b/i.test(
        t,
      ),
    build: () => ({}),
    kind: "cancel_appointment",
    required: [],
  },
  // ─── RESCHEDULE_APPOINTMENT ───────────────────────────────────────
  // "move it to Thursday", "push to next Tuesday", "reschedule to 3pm"
  {
    id: "reschedule.appointment",
    match: (t) =>
      /\b(reschedule|move\s+it\s+to|push\s+(it\s+)?to|change\s+it\s+to|can\s+we\s+(move|push)|move\s+the\s+appointment)\b/i.test(
        t,
      ) && TIME_HINT_RE.test(t),
    build: (t, ctx) => {
      const dt = extractDateTime(t, new Date(), ctx.tz ?? "UTC");
      return dt
        ? { when: { iso_utc: dt.iso_utc, phrase: dt.matched_phrase } }
        : {};
    },
    kind: "reschedule_appointment",
    required: ["when"],
  },
  // ─── VIEW_APPOINTMENTS ────────────────────────────────────────────
  // "what's on my calendar", "show me my appointments", "what's coming up"
  {
    id: "view.appointments",
    match: (t) =>
      /\b(what'?s\s+(on\s+)?(my\s+)?(calendar|schedule)|show\s+me\s+my\s+(appointments|schedule)|what'?s\s+(coming\s+up|next|scheduled)|do\s+i\s+have\s+anything\s+(scheduled|coming))\b/i.test(
        t,
      ),
    build: () => ({}),
    kind: "view_appointments",
    required: [],
  },
  // ─── SCHEDULE_RECURRING ───────────────────────────────────────────
  // Recurring patterns MUST be tried before the one-shot
  // schedule_appointment rule, because "schedule the lawn mowing every
  // Tuesday at 10am" matches both — and we want the recurring path.
  //
  // Vision ¶33: "autopilot, such as their grass mowed, weeds pulled..."
  {
    id: "schedule.recurring",
    match: (t) =>
      /\b(every|each|weekly|monthly|daily|recurring|each\s+(week|month|day))\b/i.test(
        t,
      ) &&
      /\b(schedule|book|set\s+up|put\s+(it\s+)?on\s+(autopilot|automatic)|keep|have)\b/i.test(
        t,
      ),
    build: (t) => {
      const parsed = parseRecurringSchedule(t);
      if (!parsed) return {};
      // Title — best-effort first-noun extraction. "lawn mowing", "gutter check"
      const titleMatch = t.match(
        /\b(?:keep|have)\s+(?:my\s+|the\s+)?([a-z][\w\s]{2,40}?)(?:\s+(?:done|cut|cleaned|mowed|trimmed|every|each|weekly|monthly|daily))/i,
      );
      const title = titleMatch?.[1]?.trim() ?? "recurring job";
      return {
        recurring: {
          title,
          schedule: parsed.schedule,
          matched_phrase: parsed.matched_phrase,
        },
      };
    },
    kind: "schedule_recurring",
    required: ["recurring"],
  },
  // ─── SCHEDULE_APPOINTMENT ─────────────────────────────────────────
  // "schedule the work for tomorrow at 10", "book it for Tuesday",
  // "set up a visit", "let's do tomorrow morning"
  {
    id: "schedule.appointment.with_time",
    match: (t) =>
      /\b(schedule|set\s+up|book\s+it|book\s+the\s+(visit|appointment|work)|let'?s\s+do|how\s+about|can\s+we\s+do)\b/i.test(
        t,
      ) && TIME_HINT_RE.test(t),
    build: (t, ctx) => {
      const dt = extractDateTime(t, new Date(), ctx.tz ?? "UTC");
      const agenda = extractAgenda(t);
      return {
        when: dt
          ? { iso_utc: dt.iso_utc, phrase: dt.matched_phrase }
          : undefined,
        agenda,
      };
    },
    kind: "schedule_appointment",
    required: ["when"],
  },
  // ─── PLACE_CALL ───────────────────────────────────────────────────
  // "call the plumber", "get them on the phone", "phone Acme" — must
  // beat tell_me_more and book.
  {
    id: "place.call.imperative",
    match: (t) =>
      /\b(call|phone|get\s+(them|him|her|me)\s+on\s+the\s+phone|dial|ring(\s+up)?)\s+(the\s+)?(plumber|electrician|hvac|a\/c|ac|roofer|landscaper|painter|handyman|carpenter|contractor|builder|gardener|them|him|her|#?\d+)\b/i.test(
        t,
      ) ||
      /\b(call|phone|dial)\s+(the\s+|my\s+)?(first|second|third|fourth|fifth|top|1st|2nd|3rd)(\s+(one|pick|guy|gal|person))?\b/i.test(
        t,
      ),
    build: (t) => ({
      contractor_ref: extractContractorRef(t),
    }),
    kind: "place_call",
    required: ["contractor_ref"],
  },
  // ─── GENERATE_ESTIMATE ────────────────────────────────────────────
  // "make me an estimate", "write up the estimate", "give me a quote".
  // After a call ends, this triggers M3.6 over the call's transcripts.
  {
    id: "generate.estimate.imperative",
    match: (t) =>
      /\b(make|write\s+up|generate|create|build|prepare|draft)\s+(me\s+)?(an?\s+)?(estimate|quote|bid|breakdown)\b|\b(quote\s+this|line[- ]item\s+(it|this))\b/i.test(
        t,
      ),
    build: () => ({}),
    kind: "generate_estimate",
    required: [],
  },
  // ─── FILE_DISPUTE ─────────────────────────────────────────────────
  // "file a complaint", "open a dispute", "I want to dispute X" — must
  // beat book.imperative because "dispute" never means "book".
  {
    id: "file.dispute.imperative",
    match: (t) =>
      /\b(file\s+a\s+(complaint|dispute|grievance)|open\s+a\s+(complaint|dispute)|start\s+a\s+(complaint|dispute)|i\s+want\s+to\s+(complain|file|dispute|raise\s+a\s+complaint)|i\s+have\s+a\s+complaint|raise\s+an?\s+issue|dispute\s+(the\s+|this\s+|that\s+)?(work|job|charge|contract|invoice|bill))\b/i.test(
        t,
      ),
    build: (t) => ({
      complaint: extractComplaint(t),
      amount_cents: extractAmount(t),
      contractor_ref: extractContractorRef(t),
    }),
    kind: "file_dispute",
    required: [],
  },
  // ─── DRAFT_CONTRACT ───────────────────────────────────────────────
  // "draft the contract", "write up an agreement", "send the contract
  // for signing" — must beat book.imperative.
  {
    id: "draft.contract.imperative",
    match: (t) =>
      /\b(draft|write\s+up|send|generate|create|prepare)\s+(the\s+|a\s+|an\s+)?(contract|agreement|paperwork)\b/i.test(
        t,
      ),
    build: (t) => {
      const amount = extractAmount(t);
      const scope = extractScope(t);
      return {
        amount_cents: amount,
        scope,
        contractor_ref: extractContractorRef(t),
      };
    },
    kind: "draft_contract",
    required: [],
  },
  // ─── BOOK ─────────────────────────────────────────────────────────
  // High priority — must match before any of the other intents
  // accidentally claim a "book" phrase.
  {
    id: "book.imperative",
    match: (t) =>
      /\b(book|hire|choose|go\s+with|let'?s\s+go\s+with|i'?ll\s+take|let'?s\s+do)\b/i.test(
        t,
      ),
    build: (t) => ({
      contractor_ref: extractContractorRef(t),
    }),
    kind: "book",
    required: ["contractor_ref"],
  },
  // ─── TELL_ME_MORE ─────────────────────────────────────────────────
  {
    id: "tell_me_more.about",
    match: (t) =>
      /\b(tell\s+me\s+more|more\s+(about|on|info)|what'?s\s+up\s+with|what\s+about|how\s+about)\b/i.test(
        t,
      ),
    build: (t) => ({
      contractor_ref: extractContractorRef(t),
    }),
    kind: "tell_me_more",
    required: ["contractor_ref"],
  },
  // ─── RECOMMEND ────────────────────────────────────────────────────
  {
    id: "recommend.which",
    match: (t) =>
      /\b(which\s+(one|should|do\s+you)|what\s+do\s+you\s+(recommend|suggest|think)|who\s+should|what\s+would\s+you\s+pick|help\s+me\s+(decide|choose)|i\s+can'?t\s+decide)\b/i.test(
        t,
      ),
    build: () => ({}),
    kind: "recommend",
    required: [],
  },
  // ─── FIND_CONTRACTOR ──────────────────────────────────────────────
  // Both "find X near Y" and bare "I need an X" forms.
  {
    id: "find.imperative",
    match: (t) =>
      /\b(find|search|look\s+for|need|want|get)\b.+\b(plumber|electrician|hvac|a\/c|ac|roofer|landscaper|painter|handyman|carpenter|flooring|appliance|cleaner|cleaning|pest|garage\s+door|window|siding|contractor|builder|gardener)\b/i.test(
        t,
      ),
    build: (t) => {
      const category = extractCategory(t);
      const location = extractLocation(t);
      const filters = extractFilters(t);
      return {
        category,
        location_text: location?.text,
        location: location?.coords,
        filters: Object.keys(filters).length > 0 ? filters : undefined,
      };
    },
    kind: "find_contractor",
    required: ["category"],
  },
  // Bare category mention — "I have a plumbing problem", "my AC is broken"
  {
    id: "find.bare_category",
    match: (t) =>
      /\b(plumbing|electrical|hvac|a\/c|ac|roof|landscaping|painting|handyman|carpentry|flooring|appliance|pest|garage\s+door|window\b.+broken|leak|drain|clog)\b/i.test(
        t,
      ),
    build: (t) => {
      const category = extractCategory(t);
      const location = extractLocation(t);
      const filters = extractFilters(t);
      return {
        category,
        location_text: location?.text,
        location: location?.coords,
        filters: Object.keys(filters).length > 0 ? filters : undefined,
      };
    },
    kind: "find_contractor",
    required: ["category"],
  },
];

/** Try every rule in priority order. Returns the first match (or no-match). */
export function applyRules(
  text: string,
  ctx: ClassifyContext = {},
): ClassifyResult {
  const trimmed = text.trim();
  if (!trimmed) return { matched: false, reason: "empty text" };

  for (const rule of RULES) {
    if (!rule.match(trimmed)) continue;
    const slots = rule.build(trimmed, ctx);
    const missingRequired = rule.required.filter(
      (k) => slots[k] === undefined,
    );
    return {
      matched: true,
      classification: {
        kind: rule.kind,
        slots,
        confidence: missingRequired.length === 0 ? "high" : "medium",
        matched_rule: rule.id,
      },
    };
  }

  return { matched: false, reason: "no rule matched" };
}
