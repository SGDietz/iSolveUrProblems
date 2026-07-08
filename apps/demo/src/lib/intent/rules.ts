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
  collapseSpokenZip,
  extractAmount,
  extractCategory,
  extractComplaint,
  extractContractorRef,
  extractFilters,
  extractLocation,
  extractLocationText,
  extractScope,
} from "./slots";
import { extractDateTime } from "../appointments/extractDateTime";
import { parseRecurringSchedule } from "../recurring";
import {
  LIST_INDEX_RE,
  extractListName,
  isAddOfferAffirmative,
  isClearAllCommand,
  parseRemoveByPosition,
  parseRemovePositions,
  splitSpokenPendingListItems,
} from "../lists";
import type { ClassifyContext, ClassifyResult, IntentSlots } from "./types";

const TODO_COMPLETE_COMMAND_RE =
  /\b(?:check(?:ed)?\s+off|cross(?:ed)?\s+off|mark(?:ed)?\s+off|(?:cross|check|mark)(?:ed)?\s+.+?\s+off|mark\s+.+?\s+(?:as\s+)?(?:done|complete|completed|finished))\b/i;

function hasTodoSurface(ctx: ClassifyContext): boolean {
  return ctx.currentSurfaceKind === "todo";
}

function hasListTokenOrTodoSurface(text: string, ctx: ClassifyContext): boolean {
  return /\blist\b/i.test(text) || hasTodoSurface(ctx);
}

function isTodoMutationCommand(text: string): boolean {
  return (
    parseRemovePositions(text).length > 0 ||
    parseRemoveByPosition(text) !== null ||
    isClearAllCommand(text) ||
    TODO_COMPLETE_COMMAND_RE.test(text)
  );
}

function parseTodoOrdinal(text: string): number | null {
  const m = text.match(
    /\b(?:number|item|#)?\s*(one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|1st|2nd|3rd|4th|5th|6th|7th|8th|9th|10th|\d{1,2})\b/i,
  );
  if (!m) return null;
  const raw = m[1].toLowerCase();
  const words: Record<string, number> = {
    one: 1, first: 1, "1st": 1,
    two: 2, second: 2, "2nd": 2,
    three: 3, third: 3, "3rd": 3,
    four: 4, fourth: 4, "4th": 4,
    five: 5, fifth: 5, "5th": 5,
    six: 6, sixth: 6, "6th": 6,
    seven: 7, seventh: 7, "7th": 7,
    eight: 8, eighth: 8, "8th": 8,
    nine: 9, ninth: 9, "9th": 9,
    ten: 10, tenth: 10, "10th": 10,
  };
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  return words[raw] ?? null;
}

type Rule = {
  id: string;
  /** Returns truthy if the rule matches; falsy otherwise. */
  match: (text: string, ctx: ClassifyContext) => boolean;
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
    | "dismiss_surface"
    | "onboard_contractor"
    | "save_contractor_profile"
    | "add_todo"
    | "rename_todo"
    | "view_todos"
    | "inspect_todo"
    | "complete_todo"
    | "remove_todo"
    | "clear_list"
    | "view_lists"
    | "schedule_recurring"
    | "report_no_show"
    | "go_between_mode"
    | "unsubscribe_channel";
  /** Required slot keys — if any are missing the result is "medium". */
  required: Array<keyof IntentSlots>;
};

/** Cheap pre-check for any time/day token. Used to gate appointment rules. */
const TIME_HINT_RE =
  /\b(tomorrow|tonight|today|next\s+\w+|this\s+\w+|monday|tuesday|wednesday|thursday|friday|saturday|sunday|morning|afternoon|evening|in\s+\d+\s+(hour|minute|day|week)|\d{1,2}\s*(am|pm)|\d{4}-\d{2}-\d{2})\b/i;

// ─── Contractor SUPPLY-side detection (TASK_061) ────────────────────
// The homeowner (demand) side says "find me a plumber". The trade-pro
// (supply) side says "I'M a plumber and I need work". These two must not
// collide — supply must beat find_contractor.

const TRADE_WORD_RE =
  /\b(plumber|plumbing|electrician|electrical|electric|hvac|a\/c|ac|roofer|roofing|landscaper|landscaping|painter|painting|handyman|carpenter|carpentry|flooring|appliance|cleaner|cleaning|pest|garage\s+door|window|contractor|builder|gardener)\b/i;

/** Homeowner demand-side request: "I need/find/get a plumber". */
const HOMEOWNER_FIND_PRO_RE =
  /\b(?:find|search|look\s+for|need|want|get|hire|show|give|pull\s+up)\b\s+(?:me\s+|us\s+)?(?:\d+\s+|[a-z]+\s+)?(?:more\s+)?(?:a|an|the|some)?\s*(plumbers?|electricians?|hvac|a\/c|ac|roofers?|landscapers?|painters?|handym(?:a|e)n|carpenters?|flooring|appliance|cleaners?|cleaning|pest|garage\s+doors?|windows?|contractors?|builders?|gardeners?)\b/i;

// "that list" now dismisses like "this list" does — G said "take THAT list
// down" on the 2026-07-07 16:54 ride, nothing matched, and he had to repeat
// himself ("The list is still up. Take it down.").
const DISMISS_SURFACE_RE =
  /\b(?:take\s+(?:it|(?:this|that)(?:\s+(?:panel|surface|screen|list|contractor\s+(?:signup|sign[- ]?up|onboarding)))?|the\s+(?:panel|surface|screen|list|contractor\s+(?:signup|sign[- ]?up|onboarding)))\s+down(?!\s+a\s+(?:notch|bit|level|peg|couple|few|little))|get\s+(?:it|(?:this|that)(?:\s+(?:panel|surface|list|contractor\s+(?:signup|sign[- ]?up|onboarding)))?|the\s+(?:panel|surface|list|contractor\s+(?:signup|sign[- ]?up|onboarding)))\s+off\s+(?:the\s+)?screen|close\s+(?:it|(?:this|that)(?:\s+(?:panel|surface|screen|list|contractor\s+(?:signup|sign[- ]?up|onboarding)))?|the\s+(?:panel|surface|screen|list|contractor\s+(?:signup|sign[- ]?up|onboarding)))|remove\s+(?:it|that|this|the\s+)?(?:list|panel|surface|contractor\s+(?:signup|sign[- ]?up|onboarding))\s+from\s+(?:the\s+)?screen|(?:make\s+(?:it|that|this)\s+)?go\s+away)\b/i;

// List rename (G live-ride 2026-07-06: "let's call this list Contractors
// Needed... 6 should be able to change it for the user"). Gated on the todo
// surface actually being open (ClassifyContext.currentSurfaceKind) so a bare
// "call this X" out of list context never misfires.
// "this" is often followed by the literal word "list" before the new name
// ("call THIS LIST Contractors Needed") — that optional "list" token must be
// CONSUMED by the alternation, not left for the capture group, or the name
// leaks a leading "list " (verified 2026-07-06: "call this list contractors
// list" captured "list contractors list" before this fix).
const LIST_RENAME_RE =
  /\b(?:let'?s\s+)?call\s+(?:this(?:\s+list)?|it|the\s+list)\s+(.+)|rename\s+(?:this|the)\s+list\s+(?:to\s+)?(.+)|name\s+(?:this|the)\s+list\s+(.+)/i;

// M4.4 no-show phrasing — shared by the report.no_show rule AND the
// onboarding-continuation bail (a no-show report must escape the panel).
// Hardened vs M4 original (Herm fixture #9): "didn't show ME the list"
// never fires — a pronoun/object right after "show" bails.
const NO_SHOW_RE =
  /\b(no[- ]?show|didn'?t\s+show(?!\s+(?:me|us|you|it|them|him|her|the)\b)(\s+up)?|never\s+(showed|came|turned\s+up|arrived)|hasn'?t\s+shown(?!\s+(?:me|us|you)\b)(\s+up)?|nobody\s+(came|showed)|no\s+one\s+(came|showed)|they'?re\s+not\s+here|they\s+didn'?t\s+come|stood\s+(us|me)\s+up)\b/i;

/** Supply-side: user is saying they ARE the pro or want leads/work. */
function isContractorSupplySide(text: string): boolean {
  if (HOMEOWNER_FIND_PRO_RE.test(text)) return false;
  const hasTradeWord = TRADE_WORD_RE.test(text);
  const hasFirstPersonProEvidence =
    /\b(i\s*(?:am|'m)|we\s*(?:are|'re)|i\s+do|we\s+do|i\s+run|we\s+run|i\s+own|we\s+own|my\s+business\s+(?:is|does|offers))\b/i.test(
      text,
    ) && hasTradeWord;
  return (
    hasFirstPersonProEvidence ||
    /\b(sign\s+me\s+up|list\s+my\s+business|add\s+me\s+as|join\s+as|register\s+(?:me|my\s+business)|create\s+(?:my|a)\s+(?:contractor|pro|vendor)\s+profile)\b/i.test(
      text,
    ) ||
    (hasTradeWord &&
      /\b(i|we)\s+(?:need|want|am\s+looking\s+for|are\s+looking\s+for)\s+(?:more\s+)?(?:work|jobs|leads|customers|clients)\b/i.test(
        text,
      ))
  );
}

/** Save only when a contractor-onboarding surface is actually active. */
function isSaveContractorProfile(text: string, ctx: ClassifyContext): boolean {
  if (ctx.currentSurfaceKind !== "contractorOnboarding") return false;
  return /\b(that'?s\s+(everything|it)|save\s+(it|my\s+profile)|sign\s+me\s+up|finish|done|all\s+set|looks\s+good)\b/i.test(
    text,
  );
}

function normalizeOnboardingPhone(input: string): string | undefined {
  const digits = input.replace(/\D/g, "");
  return digits.length >= 7 ? digits : undefined;
}

function extractOnboardingContactSlots(text: string): Pick<IntentSlots, "phone" | "email"> {
  const email = text.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0];
  const phone = text
    .match(/(?:\+?\d{1,3}[\s\-().]*)?(?:\d[\s\-().]*){6,15}\d/g)
    ?.map(normalizeOnboardingPhone)
    .find(Boolean);
  return {
    ...(phone ? { phone } : {}),
    ...(email ? { email: email.trim().toLowerCase() } : {}),
  };
}

function cleanOnboardingBusinessName(raw: string | undefined): string | undefined {
  const value = raw
    ?.replace(/^(?:called|is)\s+/i, "")
    .replace(/\s+(?:out\s+of|based\s+in|located\s+in|serving|near|around|in|and|but|we|i)\b.*$/i, "")
    .replace(/[.!?,;:]+$/g, "")
    .trim();
  if (!value || value.length < 2) return undefined;
  if (/^(?:running|licensed|same|day|local|locally|yes|no|okay|ok)$/i.test(value)) {
    return undefined;
  }
  return value;
}

function extractOnboardingBusinessName(text: string): string | undefined {
  const patterns: RegExp[] = [
    /\b(?:my|our)\s+business\s+(?:is\s+called|name\s+is|is)\s+([A-Z0-9][\w&'.\- ]{1,80})/i,
    /\b(?:company|business)\s+name\s+(?:is\s+called|is)\s+([A-Z0-9][\w&'.\- ]{1,80})/i,
    /\b(?:it'?s|its|we'?re|we are)\s+called\s+([A-Z0-9][\w&'.\- ]{1,80})/i,
    /\b(?:i\s+run|we\s+run|i\s+own|we\s+own)\s+([A-Z0-9][\w&'.\- ]{1,80})/i,
    /^\s*(?:It\s+is|It's|That\s+is|That's)\s+([A-Z0-9][\w&'.\- ]{1,80})\s*[.!?]?\s*$/,
  ];
  for (const pattern of patterns) {
    const value = cleanOnboardingBusinessName(text.match(pattern)?.[1]);
    if (value) return value;
  }
  return undefined;
}

function buildContractorOnboardingSlots(text: string): IntentSlots {
  const category = extractCategory(text);
  const location = extractLocation(text);
  const businessName = extractOnboardingBusinessName(text);
  const contact = extractOnboardingContactSlots(text);
  return {
    category,
    business_name: businessName,
    ...contact,
    // Raw text works for ANY city/ZIP; coords only for known cities.
    location_text: extractLocationText(text) ?? location?.text,
    location: location?.coords,
  };
}

function isActiveContractorOnboardingContinuation(
  text: string,
  ctx: ClassifyContext,
): boolean {
  if (ctx.currentSurfaceKind !== "contractorOnboarding") return false;
  if (MAKE_LIST_RE.test(text) || isNeedListCommand(text)) return false;
  if (HOMEOWNER_FIND_PRO_RE.test(text)) return false;
  // A no-show report must escape an open signup panel (M4 merge fixture:
  // "they didn't show up" was swallowed because free-text location
  // extraction treated the WHOLE sentence as a service area).
  if (NO_SHOW_RE.test(text)) return false;
  if (/\blist\b/i.test(text) && !/\b(?:business|company|profile)\b/i.test(text)) {
    return false;
  }
  const slots = buildContractorOnboardingSlots(text);
  return Boolean(
    slots.business_name ||
      slots.phone ||
      slots.email ||
      slots.category ||
      slots.location_text ||
      /\b(?:licensed|license|same[- ]day|emergency|asap|locally\s+owned|local\s+business|family\s+owned|owner[- ]operated|franchise)\b/i.test(text),
  );
}

/**

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

// "Make/start/create a list" phrasings (Herm TASK_081 patch B): G's smoke had
// the brain freelance a SPOKEN-only list because no rule caught these. The
// command itself is a strong list signal even with zero items.
// "keep" + plural added 2026-07-02 (G smoke #6: "Can you keep lists for me?"
// matched NOTHING → brain claimed "saving it now!" with zero rows written —
// the list flavor of the ABC Plumbing lie).
// First-person added 2026-07-03 (G Droid ride: "can I make a list that
// you'll keep for me?" matched nothing — same lie, first-person flavor).
// Filler + no-verb list added 2026-07-05 (merged ride: "You know, make a list
// for me" and "I need a list of odds and ends" both fell through, letting 6
// freelance a spoken-only list / ABC-Plumbing-style lie). Herm TASK_119.
const MAKE_LIST_RE =
  /(?:\b(?:(?:can|could|would|will)\s+(?:you|i|we)\s+(?:please\s+)?|i\s+(?:need|want)\s+you\s+to\s+|(?:i\s+(?:need|want|have)\s+to|let'?s)\s+)|^\s*(?:(?:you\s+know|okay|ok|yeah|yep|um|uh|so|well),?\s+)*(?:please\s+)?)(?:make|start|create|build|keep)\s+(?:me\s+)?(?:a|the|my|our)?\s*(?:to[- ]?do\s+|todo\s+|task\s+|shopping\s+)?lists?(?:\s+(?:for\s+me|for\s+us))?/i;

// "I need/want a list…" — a literal list request with NO make-verb. Returns
// {} so the make-list handler opens/arms the guest list instead of writing
// trade nouns as items. Deliberately literal-list only: "I need a painter"
// stays find_contractor (no "list" token).
const NEED_LIST_RE =
  /\bi\s+(?:need|want|could\s+use)\s+(?:a|the|my|our)?\s*(?:to[- ]?do\s+|todo\s+|task\s+|shopping\s+)?lists?\b/i;

const LIST_ITEM_COLLISION_RE =
  /\b(?:appointment|meeting|booking|visit|contractors?|plumbers?|electricians?|handym(?:a|e)n|roofers?|painters?|landscapers?|estimates?|contracts?|disputes?|calls?)\b/i;

const LIST_ON_SCREEN_RE =
  /\b(?:put|show|bring|pull)\s+(?:a|the|my|our)?\s*(?:to[- ]?do\s+|todo\s+|task\s+|shopping\s+)?list\s+(?:on|onto|up\s+on)\s+(?:the\s+)?screen\b|\blist\s+(?:on|onto)\s+(?:the\s+)?screen\b/i;

const TODO_ITEM_QUERY_RE =
  /\b(?:what(?:'s|\s+is)|which|read|say|tell\s+me|show\s+me)\s+(?:is\s+|me\s+)?(?:on\s+)?(?:number|item|#|the)?\s*(one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+)\b/i;

function isNeedListCommand(text: string): boolean {
  return NEED_LIST_RE.test(text);
}

function extractMakeListItems(text: string): string | undefined {
  const m = MAKE_LIST_RE.exec(text);
  if (!m) return undefined;

  let tail = text.slice((m.index ?? 0) + m[0].length).trim();
  tail = tail
    .replace(/^[\s:;,.!?—-]+/, "")
    .replace(/^(?:of|with|for|about)\s+/i, "")
    .replace(/^(?:things?\s+)?(?:like|such\s+as)\s+/i, "")
    // STT often gives "mow my grass, to clean the gutters". The list-item
    // splitter treats leading "to" as an interrupted scrap, so normalize it
    // only after a make-list command has already fired.
    .replace(/(^|[,;]\s*|\band\s+)to\s+/gi, "$1")
    .replace(/[.?!]+$/g, "")
    .trim();

  // "…a list that you'll keep for me of all the things I need" (G Droid
  // ride 2026-07-03): a that/which clause DESCRIBES the list, never its
  // items. No items → the handler asks "what should I put on it?" and the
  // pending-list intake catches the real items on the next turn.
  if (/^(?:that|which)\b/i.test(tail)) return undefined;
  if (/^(?:all\s+the\s+things?|everything|stuff)\s+(?:i|we)\s+(?:need|have|want)\s+(?:to\s+)?(?:do|get\s+done|handle|remember)\b/i.test(tail)) {
    return undefined;
  }
  if (!tail || LIST_ITEM_COLLISION_RE.test(tail)) return undefined;
  return tail;
}

// Voice/text unsubscribe (G 2026-07-08: "build the unsubscribe, that will
// be through voice and 6"). Anchored on explicit stop/unsubscribe phrasing
// so it never fires on ordinary conversation ("I don't want to email him" —
// no "me" — doesn't match). Channel word is optional; defaults to email.
const UNSUBSCRIBE_RE =
  /\b(?:please\s+)?(?:stop|quit|don'?t)\s+(?:emailing|texting|sms(?:ing)?|whatsapp(?:ing)?|messaging)\s+me\b|\bunsubscribe\s+me\b|\btake\s+me\s+off\s+(?:your|the)\s+(?:email|text|sms|whatsapp)?\s*(?:mailing\s+)?list\b|\bno\s+more\s+(?:emails|texts|text\s+messages|sms|whatsapp\s+messages)\s+(?:please|from\s+you)?\b/i;

function extractUnsubscribeChannel(t: string): "email" | "sms" | "whatsapp" {
  // Prefix match (no trailing \b) — "whatsapping"/"whatsapped" run the
  // suffix straight into the word with no boundary for \bwhatsapp\b to
  // find (caught by the sms/whatsapp release test 2026-07-08).
  if (/\bwhatsapp/i.test(t)) return "whatsapp";
  if (/\b(?:text|texting|texts|sms)\b/i.test(t)) return "sms";
  return "email";
}

const RULES: readonly Rule[] = [
  // ─── VOICE DISMISS ────────────────────────────────────────────────
  // Must beat onboarding/list/find so "take this contractor signup down"
  // clears a stuck panel instead of feeding more text into the active flow.
  // List mutation still requires explicit list-item grammar ("take X off my
  // list"), so these screen/panel forms are safe to treat as UI dismissals.
  {
    id: "surface.dismiss",
    match: (t) => DISMISS_SURFACE_RE.test(t),
    build: () => ({}),
    kind: "dismiss_surface",
    required: [],
  },
  // ─── UNSUBSCRIBE (voice path — mirrors the one-click email link) ──
  // Must beat find_contractor / bare_category so "stop emailing me about
  // the leak" reads as an unsubscribe, not a plumbing search.
  {
    id: "account.unsubscribe",
    match: (t) => UNSUBSCRIBE_RE.test(t),
    build: (t) => ({ unsubscribe_channel: extractUnsubscribeChannel(t) }),
    kind: "unsubscribe_channel",
    required: [],
  },
  // ─── CONTRACTOR ONBOARDING (SUPPLY SIDE) ──────────────────────────
  // Must beat find_contractor. "I need a plumber" is demand-side (homeowner);
  // "I'm a plumber and need work" is supply-side (trade pro signing up).
  {
    id: "contractor_onboarding.save",
    match: (t, ctx) => isSaveContractorProfile(t, ctx),
    build: () => ({}),
    kind: "save_contractor_profile",
    required: [],
  },
  {
    id: "contractor_onboarding.start_or_continue",
    match: (t, ctx) =>
      isContractorSupplySide(t) || isActiveContractorOnboardingContinuation(t, ctx),
    build: (t) => buildContractorOnboardingSlots(t),
    kind: "onboard_contractor",
    required: [],
  },

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
  // ─── LISTS (G 2026-07-01: 6-led lists; parsers ported from aiASAP) ──
  // ADD-OFFER YES (aiASAP ITEM 4, wired per Herm TASK_070): 6 offered
  // "want me to add X?" on his last turn (client armed the one-shot slot
  // from his spoken line); a whole-utterance affirmative now resolves those
  // exact items into a real add. Gated on the pending slot, so a stray
  // "yeah" in normal conversation can never write a list.
  {
    id: "todo.add_offer_yes",
    match: (t, ctx) =>
      Boolean(ctx.pendingAddOfferItems?.length) &&
      isAddOfferAffirmative(t),
    build: (_t, ctx) => ({
      todo_text: (ctx.pendingAddOfferItems ?? []).join(", "),
    }),
    kind: "add_todo",
    required: ["todo_text"],
  },
  // "Can you make a list for me?" routes to the list machinery instead of
  // letting the brain freelance a spoken-only list (Herm TASK_081, G smoke
  // 2026-07-02: "I want those pillboxes to go down"). required is EMPTY
  // (Herm TASK_107 P0): with `required: ["todo_text"]` an item-less make-list
  // dropped to medium confidence and the orchestrator refused it BEFORE the
  // handler — so the ask/guest-panel/pending machinery never ran and the
  // brain freelanced "Absolutely!" on every ride. The command itself is the
  // intent; the handler asks what to put on it.
  {
    id: "todo.make_list",
    match: (t) =>
      !isClearAllCommand(t) && (MAKE_LIST_RE.test(t) || isNeedListCommand(t)),
    build: (t) => {
      // Need-list ("I need a list of odds and ends") has no make-verb tail to
      // parse — open the list empty and ask (Herm TASK_119). "I need a list of
      // like… I need a painter…" must NOT write the painter as a list item.
      if (isNeedListCommand(t) && !MAKE_LIST_RE.test(t)) {
        return {};
      }
      const raw = extractMakeListItems(t);
      const listName = extractListName(t);
      return raw
        ? { todo_text: raw, ...(listName ? { list_name: listName } : {}) }
        : listName
          ? { list_name: listName }
          : {};
    },
    kind: "add_todo",
    required: [],
  },
  // Visible-list item lookup — "what is number 1?" / "what's the second
  // item?" must answer against the card, not fire contractor tell-me-more or
  // get swallowed as a pending list item.
  {
    id: "todo.inspect_item",
    match: (t, ctx) => ctx.currentSurfaceKind === "todo" && TODO_ITEM_QUERY_RE.test(t),
    build: (t) => {
      const pos = parseTodoOrdinal(t);
      return pos !== null ? { todo_ref: { type: "ordinal", position: pos } } : {};
    },
    kind: "inspect_todo",
    required: ["todo_ref"],
  },
  // Answer to 6's "what should I put on it?" (one-shot ctx.pendingListAdd —
  // Herm TASK_094 blocker #2; G smoke #6: "a painter, a plumber, and a
  // roofer" had no list verb and trade words the strict gate rejects).
  // Command verbs bail first so "find me a plumber" stays a find; the
  // relaxed splitter allows trade nouns ONLY on this turn.
  {
    id: "todo.pending_list_items",
    match: (t, ctx) => {
      if (!ctx.pendingListAdd) return false;
      if (
        /^\s*(?:done|finished|all\s+set|that'?s\s+(?:it|all|good)|that\s+is\s+(?:it|all|good)|(?:that|this|it)\s+looks\s+good|looks\s+good|nothing\s+else|no\s+more|we'?re\s+done|we\s+are\s+done|okay\s+that'?s\s+it|ok\s+that'?s\s+it)\s*[.!?]*\s*$/i.test(t)
      ) {
        return false;
      }
      if (
        /\b(?:find|search|look\s+for|show|call|book|schedule|open|go\s+to|never\s*mind|forget\s+it|cancel|go\s+away|dismiss|close\s+it|close\s+that|close\s+this|get\s+rid\s+of\s+(?:it|that|this))\b/i.test(
          t,
        )
      ) {
        return false;
      }
      // aiASAP parity: while the "add more items" window is hot, do NOT
      // swallow list mutation commands as new item titles ("remove number
      // one" must remove card #1, not write that phrase onto the card).
      if (isTodoMutationCommand(t)) return false;
      // Bare pronoun clears ("clear it", "wipe that") miss isClearAllCommand
      // but are still commands — writing the words onto the card is the one
      // wrong answer. Anchored so items like "clear coat spray" only lose
      // the leading-verb form, which reads as a command anyway.
      if (/^\s*(?:clear|wipe|erase)\b/i.test(t)) return false;
      return splitSpokenPendingListItems(t).length > 0;
    },
    build: (t, ctx) => ({
      todo_titles: splitSpokenPendingListItems(t),
      ...(ctx.pendingListAdd?.listName
        ? { list_name: ctx.pendingListAdd.listName }
        : {}),
    }),
    kind: "add_todo",
    required: [],
  },
  // Rename the CURRENTLY OPEN list — "call this list Contractors Needed",
  // "let's call this list contractors list", "rename this list to X". Gated
  // on the todo surface actually being visible so a bare "call this X" out of
  // list context never misfires.
  {
    id: "todo.rename",
    match: (t, ctx) =>
      ctx.currentSurfaceKind === "todo" && LIST_RENAME_RE.test(t),
    build: (t) => {
      const m = t.match(LIST_RENAME_RE);
      const newTitle = (m?.[1] ?? m?.[2] ?? m?.[3] ?? "")
        .trim()
        .replace(/^["']|["']$/g, "")
        .replace(/[.!?]+$/, "");
      return newTitle ? { list_name: newTitle } : {};
    },
    kind: "rename_todo",
    required: ["list_name"],
  },
  // Every rule demands an explicit list token so casual sentences ("I need
  // to fix the sink") never become list writes. First match wins — order:
  // add → clear → remove → complete → index → view.
  // "add the anode rod to my list", "put bread, butter and jam on my
  // shopping list", "add paint to my Henderson job list" (named lists
  // auto-create on first use).
  {
    id: "todo.add",
    match: (t) =>
      /\b(?:add|put)\s+.+?\s+(?:to|on(?:to)?)\s+(?:my|the|our)\s+(?:[a-z0-9' -]+\s+)?list\b/i.test(
        t,
      ),
    build: (t) => {
      const m = t.match(
        /\b(?:add|put)\s+(.+?)\s+(?:to|on(?:to)?)\s+(?:my|the|our)\s+(?:[a-z0-9' -]+\s+)?list\b/i,
      );
      const raw = m?.[1]?.trim().replace(/^["']|["']$/g, "");
      const listName = extractListName(t);
      return raw
        ? { todo_text: raw, ...(listName ? { list_name: listName } : {}) }
        : {};
    },
    kind: "add_todo",
    required: ["todo_text"],
  },
  // "clear the list", "remove everything", "start the list over" — aiASAP
  // lesson (G said it 26 times and nothing cleared). Before remove/complete
  // so "remove everything" never reads as a single-item remove.
  {
    id: "todo.clear",
    match: (t, ctx) => hasListTokenOrTodoSurface(t, ctx) && isClearAllCommand(t),
    build: (t) => {
      const listName = extractListName(t);
      return listName ? { list_name: listName } : {};
    },
    kind: "clear_list",
    required: [],
  },
  // Positional + named REMOVE — "take off number one from the list",
  // "remove both 1 and 2 from my list", "take milk off the list".
  // Requires the word "list" so a positional phrase aimed at contractor
  // cards ("remove the first one") never drops a to-do item (aiASAP gated
  // this on the active list; we gate on the spoken token).
  {
    id: "todo.remove",
    match: (t, ctx) =>
      hasListTokenOrTodoSurface(t, ctx) &&
      (parseRemovePositions(t).length > 0 ||
        parseRemoveByPosition(t) !== null ||
        /\b(?:take|remove|delete)\s+.+?\s+(?:off|from)\s+(?:my|the|our)\s+(?:[a-z0-9' -]+\s+)?list\b/i.test(
          t,
        )),
    build: (t) => {
      const listName = extractListName(t);
      const base = listName ? { list_name: listName } : {};
      const multi = parseRemovePositions(t);
      if (multi.length > 0) return { ...base, todo_positions: multi };
      const single = parseRemoveByPosition(t);
      if (single !== null)
        return { ...base, todo_positions: [single] };
      const m = t.match(
        /\b(?:take|remove|delete)\s+(?:the\s+)?(.+?)\s+(?:off|from)\s+(?:my|the|our)\s+(?:[a-z0-9' -]+\s+)?list\b/i,
      );
      const raw = m?.[1]?.trim();
      return raw ? { ...base, todo_ref: { type: "text", text: raw } } : base;
    },
    kind: "remove_todo",
    required: [],
  },
  // "check off the first one", "mark the anode rod done", "cross off #2",
  // and the split form "cross X off my (to-do) list".
  // Before todo.view — "cross X off my to-do list" must not read as a view.
  // NEVER when the sentence is about an appointment/booking/pro (Herm
  // TASK_068 blocker #3: "mark the appointment complete" / "check off the
  // contractor" must not mutate a list).
  {
    id: "todo.complete",
    match: (t, ctx) =>
      hasListTokenOrTodoSurface(t, ctx) &&
      !/\b(?:appointment|meeting|booking|visit|contractor|plumber|electrician|handyman|roofer|painter|landscaper|estimate|contract|dispute|call)\b/i.test(
        t,
      ) &&
      (/\b(?:check(?:ed)?\s+off|cross(?:ed)?\s+off|mark(?:ed)?\s+off)\b/i.test(
        t,
      ) ||
        /\b(?:cross|check|mark)(?:ed)?\s+.+?\s+off\s+(?:of\s+)?(?:my|the)\s+(?:to[- ]?do\s+)?list\b/i.test(
          t,
        ) ||
        /\bmark\s+.+?\s+(?:as\s+)?(?:done|complete|completed|finished)\b/i.test(
          t,
        )),
    build: (t) => {
      const pos = parseTodoOrdinal(t);
      if (pos !== null) {
        return { todo_ref: { type: "ordinal", position: pos } };
      }
      const m =
        t.match(
          // Split form first — most specific: "cross X off (of) my list".
          /\b(?:cross|check|mark)(?:ed)?\s+(?:the\s+)?(.+?)\s+off\s+(?:of\s+)?(?:my|the)\s+(?:to[- ]?do\s+)?list\b/i,
        ) ??
        t.match(
          /\b(?:check(?:ed)?\s+off|cross(?:ed)?\s+off|mark(?:ed)?\s+off)\s+(?:the\s+)?(.+?)(?:\s+(?:from|off)\s+(?:my|the)\s+list)?\s*$/i,
        ) ??
        t.match(/\bmark\s+(?:the\s+)?(.+?)\s+(?:as\s+)?(?:done|complete|completed|finished)\b/i);
      const raw = m?.[1]?.trim();
      const listName = extractListName(t);
      return raw
        ? {
            todo_ref: { type: "text", text: raw },
            ...(listName ? { list_name: listName } : {}),
          }
        : {};
    },
    kind: "complete_todo",
    required: ["todo_ref"],
  },
  // "what are my lists", "show me my lists", "how many lists" — the INDEX
  // (plural-hardened in aiASAP so "add eggs to my lists" never pops it).
  // Before todo.view: the plural forms must not read as a single-list view.
  {
    id: "todo.lists.index",
    match: (t) => LIST_INDEX_RE.test(t),
    build: () => ({}),
    kind: "view_lists",
    required: [],
  },
  // "what's on my list", "read me my house list", "show me the Henderson list"
  // "see/view/pull up" added 2026-07-03 (G Droid ride: "I want to see the
  // list on your chest" matched nothing). "put a list on (the) screen" /
  // bare "list on screen" added 2026-07-07 (G's 13:08 ride: he said both,
  // nothing matched, and 6 read the items voice-only instead of opening the
  // panel). Dismiss beats this by rule order, and no dismiss verb appears
  // here, so "take/remove the list from the screen" still closes it.
  {
    id: "todo.view",
    match: (t) =>
      LIST_ON_SCREEN_RE.test(t) ||
      /\b(?:what'?s\s+on|show\s+(?:me\s+)?|see|view|pull\s+up|put\s+up|bring\s+up|read\s+(?:me\s+)?(?:back\s+)?|check)\s+(?:my|the|our|that|this|a)\s+(?:[a-z0-9' -]+\s+)?list\b/i.test(
        t,
      ) ||
      /\b(?:put|throw|pop|bring|show)\s+(?:a|an|the|my|that|this)?\s*(?:[a-z0-9' -]+\s+)?list\s+(?:up\s+)?on\s+(?:the\s+)?(?:screen|chest)\b/i.test(
        t,
      ) ||
      /^\s*(?:a\s+|the\s+)?list\s+on\s+(?:the\s+)?screen\s*[.!?]*\s*$/i.test(
        t,
      ) ||
      /\bmy\s+to[- ]?do\s+list\b/i.test(t),
    build: (t) => {
      const listName = extractListName(t);
      return listName ? { list_name: listName } : {};
    },
    kind: "view_todos",
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
  // ─── REPORT_NO_SHOW (M4.4, merged per plan v2 / Herm order #9) ─────
  // Homeowner-driven trigger for the backup dispatcher. Before reschedule
  // (which could claim "they didn't come, move it") and before find. The
  // handler resolves the target appointment from context.
  // HARDENED vs M4 original (Herm fixture #9): "didn't show ME the list"
  // must never fire dispatch — a pronoun/object right after "show" bails.
  // Vision ¶33: "If contractors don't show, 6 will get contractors that do."
  {
    id: "report.no_show",
    match: (t) => NO_SHOW_RE.test(t),
    build: () => ({}),
    kind: "report_no_show",
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
  // ─── SCHEDULE_RECURRING (M4.7, merged per plan v2 / Herm order #12) ─
  // Recurring patterns MUST be tried before one-shot schedule_appointment:
  // "schedule the lawn mowing every Tuesday at 10am" matches both — the
  // recurring path wins. Vision ¶33 (autopilot).
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
      // Title — best-effort first-noun extraction ("lawn mowing").
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
  // ─── GO_BETWEEN_MODE (M4.9, merged per plan v2 / Herm order #14) ────
  // "get on the phone with me while the plumber's here" / "mediate for
  // us". Beats place_call ("get on the phone with me" would trip it).
  // Distinct semantics: place_call = 6 dials a remote contractor;
  // go_between = 6 joins while both parties are physically together.
  // HANDLER IS FAIL-CLOSED (plan v2 A4): classifying this intent never
  // dials — it returns a consent-gated surface only. Vision ¶15.
  {
    id: "go_between.mode",
    match: (t) =>
      /\b(go[- ]?between(\s+mode)?|mediate\s+(for\s+us|between\s+us)|be\s+the\s+go[- ]?between|jump\s+in\s+and\s+mediate|get\s+on\s+the\s+phone\s+with\s+(me|us)\s+while)\b/i.test(
        t,
      ),
    build: (t) => ({
      contractor_ref: extractContractorRef(t),
    }),
    kind: "go_between_mode",
    required: [],
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
      // Bare "get him/them/her on the phone" — no trailing noun needed
      // (M4 merge fixture #5: Herm — must stay place_call, not go-between;
      // the dormant handler answers with tap-to-call guidance).
      /\bget\s+(them|him|her)\s+on\s+the\s+phone\b/i.test(t) ||
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
    // Ctx-gated (Herm TASK_144 Patch D — G 13:11 ride: a bare "Tell me more"
    // with no contractor context made 6 read "[INTENT NOT ACTIONABLE]"): a
    // concrete contractor ref always matches; the generic phrasing only
    // matches when a contractor-ish surface is actually in view. Otherwise
    // the main brain answers naturally.
    match: (t, ctx) => {
      const ref = extractContractorRef(t);
      if (ref) return true;
      const surfaceCanHaveContractorContext = [
        "contractors",
        "summary",
        "picks",
        "pickResult",
        "compare",
      ].includes(ctx.currentSurfaceKind ?? "");
      if (!surfaceCanHaveContractorContext) return false;
      return /\b(tell\s+me\s+more|more\s+(?:about|on|info)|show\s+me\s+details|details)\b/i.test(
        t,
      );
    },
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
  // PENDING-FIND location answer (G smoke 2026-07-01, 23:31 ET): 6 asked
  // "what city or ZIP?", G answered "21093", NO rule matched a bare ZIP →
  // the orchestrator never ran → the brain hallucinated "Plumbing Pros Inc."
  // This rule fires ONLY while a find is pending (ctx.pendingFindCategory,
  // carried in the surface snapshot) and the whole utterance is a location
  // answer — a ZIP or a short city phrase. Resumes the find with the
  // remembered category.
  // "Show me 2 more" / "who else?" while contractor cards are ON SCREEN
  // (G Droid smoke 2026-07-02: no more-results path existed — 6 refused
  // honestly but the ask was real). Gated on the contractors surface so a
  // stray "more" in normal chat can't fire a search; "tell me more (about
  // ...)" stays with tell_me_more (verb set excludes "tell" + about-guard).
  {
    id: "find.more",
    match: (t, ctx) => {
      if (ctx.currentSurfaceKind !== "contractors") return false;
      if (/\babout\b/i.test(t)) return false;
      return (
        /\b(?:show|give|find|pull\s+up|get)\s+(?:me\s+|us\s+)?(?:\d+\s+|a\s+few\s+|some\s+|any\s+)?more\b/i.test(
          t,
        ) ||
        /\bwho\s+else\b/i.test(t) ||
        /\bany(?:one|body)?\s+else\b/i.test(t) ||
        /^\s*(?:\d+\s+)?more(?:\s+[a-z]+s?)?\s*[.!?]?\s*$/i.test(t)
      );
    },
    build: (t) => ({ more: true, category: extractCategory(t) }),
    kind: "find_contractor",
    required: [],
  },
  {
    id: "find.location_answer",
    match: (t, ctx) => {
      if (!ctx.pendingFindCategory) return false;
      const trimmed = t.trim();
      // Labeled numbers are never ZIPs ("part number 12345", "order 12345")
      // — bail before ANY of the zip paths below can bite (Herm TASK_094).
      if (
        /\b(?:part|order|number|invoice|model|item|call|extension|ext)\s+\d{5}\b/i.test(
          trimmed,
        )
      ) {
        return false;
      }
      // STT-mangled spoken ZIP fires at ANY length: a frustrated re-say
      // ("So those are 5 digits... 2-1-0-3-0.") blows the word cap but IS
      // the answer (G live smoke 2026-07-02 — the ABC Plumbing freestyle).
      if (collapseSpokenZip(trimmed)) return true;
      // A PLAIN 5-digit ZIP buried in a longer sentence also fires — 6 just
      // asked for city/ZIP, so "…dead upped. Um, 21234." IS the answer
      // (G smoke #6). Money ("$25000", "25000 dollars") and labeled numbers
      // ("part number 12345", "order 12345") stay out (Herm TASK_094).
      if (
        /(?<![\$#])(?<!\b(?:part|order|number|invoice|model|item|call|extension|ext)\s)\b\d{5}\b(?!\s*(?:dollars|bucks|per|a\s+year))/i.test(
          trimmed,
        )
      ) {
        return true;
      }
      if (trimmed.split(/\s+/).length > 5) return false;
      return Boolean(extractLocationText(trimmed));
    },
    build: (t, ctx) => {
      const location = extractLocation(t);
      return {
        category: ctx.pendingFindCategory ?? undefined,
        location_text: extractLocationText(t) ?? location?.text,
        location: location?.coords,
      };
    },
    kind: "find_contractor",
    required: ["category", "location_text"],
  },
  // STT FRAGMENT (G smoke #7 2026-07-03): "one thing I definitely need is,
  // uh," and "is a painter." arrive as SEPARATE messages — neither alone
  // matches find.imperative, so no find fired, no pending armed, and the
  // spoken ZIP dead-ended. A short whole-utterance trade fragment IS the
  // ask. "I'm a painter" stays out (that's a pro onboarding, not a find);
  // multi-trade lists stay out (anchor + single trade), and the
  // pending-list answer rule sits earlier in this array so list intake
  // still wins while 6 is waiting on items.
  {
    id: "find.trade_fragment",
    match: (t) =>
      // "the" added + handy man/AC shapes per Herm TASK_098 ("the AC.",
      // "a handy man." are real spoken fragments).
      /^\s*(?:(?:um+|uh+|well|and|so|okay|ok)[,.]?\s+)*(?:(?:it|that)'?s\s+|is\s+)?(?:an?|the)\s+(?:plumber|electrician|hvac(?:\s+tech)?|a\/?c|roofer|landscaper|painter|handy\s*man|handym(?:a|e)n|carpenter|cleaner|gardener|builder|contractor)\s*[.!?]?\s*$/i.test(
        t,
      ),
    build: (t) => ({ category: extractCategory(t) }),
    kind: "find_contractor",
    required: ["category"],
  },
  // Both "find X near Y" and bare "I need an X" forms.
  {
    id: "find.imperative",
    // Plurals matter (G smoke 2026-07-01: "find me painterS near Timonium"
    // silently matched NOTHING — every trade word was singular-locked).
    match: (t) =>
      /\b(find|search|look\s+for|need|want|get|show|give|pull\s+up)\b.+\b(plumbers?|electricians?|hvac|a\/c|ac|roofers?|landscapers?|painters?|handym(?:a|e)n|carpenters?|flooring|appliance|cleaners?|cleaning|pest|garage\s+doors?|windows?|siding|contractors?|builders?|gardeners?)\b/i.test(
        t,
      ),
    build: (t) => {
      const category = extractCategory(t);
      const location = extractLocation(t);
      const filters = extractFilters(t);
      return {
        category,
        // Raw text works for ANY city/ZIP (nationwide); coords only for
        // recognized cities, so distance is hidden when unknown.
        location_text: extractLocationText(t) ?? location?.text,
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
        // Raw text works for ANY city/ZIP (nationwide); coords only for
        // recognized cities, so distance is hidden when unknown.
        location_text: extractLocationText(t) ?? location?.text,
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
    if (!rule.match(trimmed, ctx)) continue;
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
