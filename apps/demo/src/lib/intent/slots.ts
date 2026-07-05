/**
 * M3.0e — Slot extraction helpers.
 *
 * Pure regex / lookup table. No LLM calls.
 */

import type { ContractorRef } from "./types";

// ─── Category extraction ────────────────────────────────────────────

/**
 * Maps natural-language words a user might say to one of M2's 15
 * category slugs. Order matters — more specific entries first.
 */
const CATEGORY_WORDS: Array<{ slug: string; words: readonly string[] }> = [
  { slug: "plumber",    words: ["plumber", "plumbing", "drain", "pipe"] },
  { slug: "electrician", words: ["electrician", "electrical", "electric"] },
  { slug: "hvac",       words: ["hvac", "a/c", "ac", "air condition", "heating", "furnace"] },
  { slug: "roofer",     words: ["roofer", "roofing", "roof"] },
  { slug: "landscaper", words: ["landscaper", "landscaping", "lawn", "yard", "gardener"] },
  { slug: "painter",    words: ["painter", "painting"] },
  { slug: "handyman",   words: ["handyman", "handy man"] },
  { slug: "carpenter",  words: ["carpenter", "carpentry", "woodwork"] },
  { slug: "flooring",   words: ["flooring", "floor", "hardwood", "tile floor"] },
  { slug: "appliance",  words: ["appliance"] },
  { slug: "cleaning",   words: ["cleaner", "cleaning", "house clean"] },
  { slug: "pest",       words: ["pest", "exterminator", "bug"] },
  { slug: "garage_door", words: ["garage door"] },
  { slug: "window",     words: ["window", "siding", "glazier"] },
  // "general" is intentionally last — broadest match
  { slug: "general",    words: ["general contractor", "contractor", "builder", "renovation"] },
];

function stripNegatedCategoryClauses(text: string): string {
  return text.replace(
    /\b(?:not|no|don'?t|do\s+not|didn'?t|did\s+not)\s+(?:need|want|mean|say\s+)?(?:a|an|the|any|another)?\s*(?:plumbers?|plumbing|electricians?|electrical|electric|hvac|a\s*\/\s*c|ac|air\s*condition(?:er|ing)?|heating|furnace|roofers?|roofing|roof|landscapers?|landscaping|lawn|yard|gardeners?|painters?|painting|handy\s*man|handym(?:a|e)n|carpenters?|carpentry|flooring|floor|hardwood|tile\s+floor|appliance|cleaners?|cleaning|house\s+clean|pest|exterminator|bug|garage\s+door|windows?|siding|glazier|general\s+contractor|contractors?|builders?|renovation)\b/gi,
    " ",
  );
}

function categoryFromText(text: string): string | undefined {
  const t = text.toLowerCase();
  for (const { slug, words } of CATEGORY_WORDS) {
    if (words.some((w) => t.includes(w))) return slug;
  }
  return undefined;
}

function extractFirstPersonCategory(text: string): string | undefined {
  const patterns = [
    /\b(?:i\s*(?:am|'m)|we\s*(?:are|'re)|my\s+trade\s+is|our\s+trade\s+is)\s+(?:a|an|the)?\s*([^.!?,;]{1,80})/i,
    /\b(?:i|we)\s+do\s+([^.!?,;]{1,80})/i,
    /\b(?:my|our)\s+business\s+(?:does|offers|is)\s+([^.!?,;]{1,80})/i,
  ];
  for (const pattern of patterns) {
    const segment = text.match(pattern)?.[1];
    if (!segment) continue;
    const category = categoryFromText(stripNegatedCategoryClauses(segment));
    if (category) return category;
  }
  return undefined;
}

export function extractCategory(text: string): string | undefined {
  // First-person corrections must beat an earlier wrong/on-screen trade word:
  // "why is the trade saying HVAC? I'm a landscaper" should update to
  // landscaper, not keep the first taxonomy word in the sentence.
  const firstPerson = extractFirstPersonCategory(text);
  if (firstPerson) return firstPerson;
  return categoryFromText(stripNegatedCategoryClauses(text));
}

// ─── Location extraction ────────────────────────────────────────────

/**
 * Cities the test drive recognizes. If the user names a city we
 * recognize, we extract lat/lng. Unknown location = the orchestrator
 * ASKS for city/ZIP — there is NO default-center fallback (removed
 * 2026-07-01, Herm P0; see the note below).
 *
 * Adding a city is a 1-line change. Long term this becomes geocoding.
 */
const KNOWN_CITIES: Record<string, { lat: number; lng: number }> = {
  // US metros (the M3.0d test drive lives here)
  "austin":         { lat: 30.2672, lng: -97.7431 },
  "new york":       { lat: 40.7128, lng: -74.0060 },
  "nyc":            { lat: 40.7128, lng: -74.0060 },
  "los angeles":    { lat: 34.0522, lng: -118.2437 },
  "la":             { lat: 34.0522, lng: -118.2437 },
  "chicago":        { lat: 41.8781, lng: -87.6298 },
  "houston":        { lat: 29.7604, lng: -95.3698 },
  "miami":          { lat: 25.7617, lng: -80.1918 },
  "san francisco":  { lat: 37.7749, lng: -122.4194 },
  "sf":             { lat: 37.7749, lng: -122.4194 },
  "seattle":        { lat: 47.6062, lng: -122.3321 },
  "boston":         { lat: 42.3601, lng: -71.0589 },
  "denver":         { lat: 39.7392, lng: -104.9903 },
  "dallas":         { lat: 32.7767, lng: -96.7970 },
  "atlanta":        { lat: 33.7490, lng: -84.3880 },
  "phoenix":        { lat: 33.4484, lng: -112.0740 },
  "san diego":      { lat: 32.7157, lng: -117.1611 },
  // International (locales the app supports)
  "london":         { lat: 51.5074, lng: -0.1278 },
  "paris":          { lat: 48.8566, lng: 2.3522 },
  "berlin":         { lat: 52.5200, lng: 13.4050 },
  "madrid":         { lat: 40.4168, lng: -3.7038 },
  "lisbon":         { lat: 38.7223, lng: -9.1393 },
  "beijing":        { lat: 39.9042, lng: 116.4074 },
  "shanghai":       { lat: 31.2304, lng: 121.4737 },
};

// DEFAULT_CENTER (Austin) removed 2026-07-01 (Herm P0): every import was
// already gone after TASK_065/066 killed the fail-open paths; the bare export
// only invited a future "?? DEFAULT_CENTER". Unknown location = ASK, never rank
// off a fake center.

/**
 * A ZIP the user SPOKE, mangled by speech-to-text into time/dash/space runs:
 * "2:10:30." / "2-1-0-3-0" / "2 1 0 3 0" (G's live smoke 2026-07-02 — the ZIP
 * never matched, the find never resumed, and the brain freestyled a fake
 * "ABC Plumbing"). Collapse separator-broken digit runs; exactly 5 collapsed
 * digits = a ZIP. A real clock time ("10:30") collapses to 4 digits and a
 * phone number to 10, so neither can false-positive.
 */
export function collapseSpokenZip(text: string): string | undefined {
  // Whole utterance is digits + separators (trailing punctuation ignored):
  // "2:10:30." → 21030, "21030." → 21030, "10:30." → 1030 (no match).
  const bare = text.trim().replace(/[.!?]+$/, "").trim();
  if (/^[\d\s:.\-]+$/.test(bare)) {
    const digits = bare.replace(/\D/g, "");
    if (digits.length === 5) return digits;
  }
  // Embedded separator-broken run inside a longer sentence ("...understand
  // that. 2-1-0-3-0."). Groups must be glued ONLY by [-:. space] — any letter
  // between digit groups breaks the run, so word contexts can't merge.
  const runs = bare.match(/\b\d+(?:[-:. ]+\d+)+\b/g);
  for (const run of runs ?? []) {
    const digits = run.replace(/\D/g, "");
    if (digits.length === 5) return digits;
  }
  return undefined;
}

/**
 * Raw location TEXT — NOT tied to KNOWN_CITIES. Lets us search + save ANY US
 * city or ZIP ("48 states first, then world"), even with no coords for it.
 * Coords still come from extractLocation() (known cities only); when we have
 * no coords the UI + voice simply hide distance (never a fake 0.0 km).
 */
export function extractLocationText(text: string): string | undefined {
  const trimmed = text.trim();

  // Bare answer to "what city or ZIP?" — the WHOLE utterance is the place:
  // "Frederick, MD" / "Frederick MD 21701" / "San Antonio TX" / "90210".
  // The 2-letter state must be its own separated token (not a word-tail), and
  // the phrase can't start with a preposition/verb ("based in 90210").
  // NB: "the"/"a"/"an" are NOT rejected here — real places start with them
  // ("The Woodlands, TX"). The required City+ST format filters command phrases.
  const REJECT_LOC_FIRST = new Set([
    "based", "out", "located", "serving", "in", "near", "from", "i", "we",
    "my", "our", "do", "done", "need", "want", "find",
    "looking", "yes", "no", "it", "its",
  ]);
  const bareCityState = trimmed.match(
    /^([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,3}(?:,\s*|\s+)[A-Za-z]{2}(?:\s+\d{5})?)$/,
  );
  if (bareCityState) {
    const first = (bareCityState[1].match(/^[A-Za-z']+/)?.[0] ?? "").toLowerCase();
    if (!REJECT_LOC_FIRST.has(first)) {
      return bareCityState[1].replace(/\s+/g, " ").trim();
    }
  }
  const bareZip = trimmed.match(/^(\d{5})$/);
  if (bareZip) return bareZip[1];

  // "in / near / around / serving / out of / based in / located in / from
  //  <City>[ Word][ Word][, ST][ 12345]"
  const m = text.match(
    /\b(?:in|near|around|serving|based\s+in|out\s+of|located\s+in|from)\s+([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*){0,2}(?:,\s*[A-Za-z]{2}(?![A-Za-z]))?(?:\s+\d{5})?)/i,
  );
  if (m) {
    let raw = m[1].replace(/\s+/g, " ").trim();
    // Drop trailing clause words STT often glues on ("Denver and we do…").
    raw = raw
      .replace(
        /\s+(?:and|or|but|we|i|so|then|licensed|insured|please|thanks?)\b.*$/i,
        "",
      )
      .replace(/[.,]+$/g, "")
      .trim();
    // Reject obvious non-locations ("near the end of my rope", "in my
    // kitchen") without dropping real "The <City>" places. \b after each word
    // protects real cities (Kitchener, Homestead).
    const NON_LOC =
      /^(?:my|our|this|that|here|there|end|house|home|kitchen|bathroom|bedroom|yard|garage|basement|attic|problem|issue|way|corner|side|area|place|middle|back|front|top|bottom|thing|guy|stuff)\b/i;
    const ARTICLE_NON_LOC =
      /^(?:the|a|an)\s+(?:end|house|home|kitchen|bathroom|bedroom|yard|garage|basement|attic|problem|issue|way|corner|side|area|place|middle|back|front|top|bottom|thing|guy|stuff|other|same|whole|rest)\b/i;
    if (NON_LOC.test(raw) || ARTICLE_NON_LOC.test(raw)) {
      return undefined;
    }
    if (raw.length >= 2 && /[A-Za-z]/.test(raw)) return raw;
  }
  // Bare 5-digit ZIP anywhere.
  const zip = text.match(/\b(\d{5})\b/);
  if (zip) return zip[1];
  // Last resort: STT-mangled spoken ZIP ("2:10:30." / "2-1-0-3-0").
  const spoken = collapseSpokenZip(text);
  if (spoken) return spoken;
  return undefined;
}

/** Extract city name + coords from a phrase like "near Austin", "in NYC". */
export function extractLocation(
  text: string,
): { text: string; coords: { lat: number; lng: number } } | undefined {
  const t = text.toLowerCase();
  // Cheapest path: any of the known city names appears anywhere in the text.
  // Two-pass to prefer longer/multiword matches first (so "san francisco"
  // wins over "san").
  const cities = Object.entries(KNOWN_CITIES).sort(
    ([a], [b]) => b.length - a.length,
  );
  for (const [city, coords] of cities) {
    // Word boundary on both ends to avoid matching "austin" inside "austinite".
    const re = new RegExp(`\\b${city.replace(/\s+/g, "\\s+")}\\b`, "i");
    if (re.test(t)) {
      return { text: city, coords };
    }
  }
  return undefined;
}

// ─── Contractor reference extraction ────────────────────────────────

/**
 * Spelled-out small numbers we accept as ordinals.
 *
 * Iteration order matters — we try entries in declaration order, and the
 * regex matches the word with an OPTIONAL trailing "one" ("the second
 * one"). Multi-word ordinals MUST come before the bare "one" entry, or
 * "the second one" would match "one" first and resolve to position 1.
 *
 * The bare "one" handles "tell me about one of them" / "give me one"
 * but is intentionally LAST so concrete ordinals win the precedence
 * battle.
 */
const SPELLED_ORDINALS: Array<{ word: string; n: number }> = [
  { word: "first",  n: 1 },
  { word: "1st",    n: 1 },
  { word: "top",    n: 1 },
  { word: "second", n: 2 },
  { word: "2nd",    n: 2 },
  { word: "two",    n: 2 },
  { word: "third",  n: 3 },
  { word: "3rd",    n: 3 },
  { word: "three",  n: 3 },
  { word: "fourth", n: 4 },
  { word: "4th",    n: 4 },
  { word: "four",   n: 4 },
  { word: "fifth",  n: 5 },
  { word: "5th",    n: 5 },
  { word: "five",   n: 5 },
  // bare "one" last — see comment above
  { word: "one",    n: 1 },
];

/**
 * Extract a contractor reference from a phrase like "the first one",
 * "#2", "Acme Plumbing". Returns undefined when no clear ref is found.
 */
export function extractContractorRef(
  text: string,
): ContractorRef | undefined {
  const t = text.toLowerCase();

  // Pattern: "#1", "#2", "number 3"
  const hash = t.match(/(?:^|\s)#\s*(\d+)/);
  if (hash) {
    const n = parseInt(hash[1], 10);
    if (n >= 1 && n <= 20) return { type: "ordinal", position: n };
  }
  const numberWord = t.match(/\bnumber\s+(\d+)\b/);
  if (numberWord) {
    const n = parseInt(numberWord[1], 10);
    if (n >= 1 && n <= 20) return { type: "ordinal", position: n };
  }

  // Pattern: "the first one", "the top one", "the second", "the 2nd"
  for (const { word, n } of SPELLED_ORDINALS) {
    const re = new RegExp(`\\b(?:the\\s+)?${word}(?:\\s+one)?\\b`, "i");
    if (re.test(t)) return { type: "ordinal", position: n };
  }

  // Pattern: name extraction — "about Acme", "about Sunrise Drainworks",
  // "with Acme Plumbing". Capture up to 4 words after the trigger.
  const nameMatch = text.match(
    /\b(?:about|with|go\s+with|book|pick|hire|tell\s+me\s+about|more\s+on)\s+([A-Z][\w&'.-]*(?:\s+[A-Z][\w&'.-]*){0,3})/,
  );
  if (nameMatch) {
    return { type: "name", name: nameMatch[1].trim() };
  }

  return undefined;
}

// ─── Filter extraction ──────────────────────────────────────────────

/**
 * Extract a dollar amount in cents from natural language. Handles:
 *   "$500"           → 50000
 *   "500 dollars"    → 50000
 *   "$1,250"         → 125000
 *   "twenty bucks"   → ... (skipped — not enough signal in v1)
 *   "2.5k"           → 250000
 *
 * Returns undefined if nothing convincing is found.
 */
export function extractAmount(text: string): number | undefined {
  const t = text.toLowerCase();

  // "$1,250" / "$500" / "$2,500.00"
  const dollar = t.match(/\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/);
  if (dollar) {
    const raw = dollar[1].replace(/,/g, "");
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100);
  }

  // "500 dollars" / "1,250 dollars" / "500 bucks"
  const spelled = t.match(
    /\b(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)\s*(?:dollars?|bucks?|usd)\b/,
  );
  if (spelled) {
    const raw = spelled[1].replace(/,/g, "");
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 100);
  }

  // "2k" / "1.5k" — k-suffix abbreviation
  const kSuffix = t.match(/\b(\d+(?:\.\d+)?)\s*k\b/);
  if (kSuffix) {
    const n = parseFloat(kSuffix[1]);
    if (Number.isFinite(n) && n > 0) return Math.round(n * 1000 * 100);
  }

  return undefined;
}

/**
 * M3.9 — Pull a complaint phrase out of a "file a dispute / complaint"
 * utterance. Patterns covered:
 *   "file a complaint because X"
 *   "I want to dispute, X did a terrible job"
 *   "open a dispute about the work — X"
 *
 * Best-effort. The orchestrator falls back to using the full utterance
 * as the complaint when this returns undefined.
 */
export function extractComplaint(text: string): string | undefined {
  // Pattern: "...because/since/about/that <complaint>"
  const m = text.match(
    /\b(?:because|since|about|that|—|–|-)\s+(.{4,300})$/i,
  );
  if (m) {
    const phrase = m[1].trim().replace(/[.!?,;\s]+$/, "");
    if (phrase.length >= 4) return phrase;
  }
  // Pattern: ", <complaint>" — anything after a comma following the
  // dispute-opener phrase.
  const after = text.match(
    /\b(?:file|open|start|begin)\s+(?:a\s+)?(?:dispute|complaint|grievance),?\s+(.{4,300})$/i,
  );
  if (after) {
    const phrase = after[1].trim().replace(/[.!?,;\s]+$/, "");
    if (phrase.length >= 4) return phrase;
  }
  return undefined;
}

/**
 * Pull out a free-form scope phrase from "for X" / "to do Y" patterns.
 * Used by draft_contract. Best-effort; returns undefined if nothing
 * useful matches.
 */
export function extractScope(text: string): string | undefined {
  // "...for installing the new water heater"
  const m = text.match(
    /\b(?:for|to)\s+([a-z][\w\s-]{4,120})(?:\s+(?:for\s+\$|at\s+\$|,|\.|$))/i,
  );
  if (m) return m[1].trim();
  return undefined;
}

export function extractFilters(text: string): {
  locally_owned?: boolean;
  same_day?: boolean;
  min_rating?: number;
  max_price_tier?: 1 | 2 | 3 | 4;
  max_distance_km?: number;
} {
  const t = text.toLowerCase();
  const out: ReturnType<typeof extractFilters> = {};

  if (/\b(local|locally[- ]owned|small business|mom[- ]and[- ]pop)\b/.test(t)) {
    out.locally_owned = true;
  }
  if (/\b(same[- ]day|today|right now|asap|emergency|urgent)\b/.test(t)) {
    out.same_day = true;
  }
  if (/\b(cheap|cheapest|afford|budget|inexpensive|low[- ]cost)\b/.test(t)) {
    out.max_price_tier = 2;
  }
  if (/\b4\.5\s*stars?\b|\b4\.5\+|\b4\.5\s*or\s*higher/.test(t)) {
    out.min_rating = 4.5;
  } else if (/\btop[- ]rated|\bhighly\s*rated|\bbest\s*reviewed/.test(t)) {
    out.min_rating = 4.5;
  }

  // Distance — "closer than 5 km", "within 10 km", "no more than 3 km"
  const kmMatch = t.match(
    /\b(?:closer\s+than|within|less\s+than|no\s+more\s+than|under)\s+(\d+(?:\.\d+)?)\s*(?:km|kilometers?|kilometres?|miles?|mi)\b/,
  );
  if (kmMatch) {
    const n = parseFloat(kmMatch[1]);
    if (!Number.isNaN(n) && n > 0 && n <= 200) {
      // Convert miles to km if the unit was miles.
      const isMiles = /mi(?:les?)?\b/.test(kmMatch[0]);
      out.max_distance_km = isMiles ? Math.round(n * 1.609 * 10) / 10 : n;
    }
  }

  return out;
}
