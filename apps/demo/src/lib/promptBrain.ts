const MAX_TEXT = 400;
const MAX_RECENT = 6;
export const PILL_MAX_CHARS = 18;

// Junk that must never become a pill (aiASAP's hard-learned core, trimmed
// to the classes that can actually appear here). Keep in sync with route use.
// Per-family suffixes (Herm TASK_104 red-team of my first fix): email/contact/
// remind/notif variants stay broad via \w*, but sign/log-in stop at the in/into
// token with a trailing \b so legit repair labels ("Sign Installation", "Log
// Interior") are NOT killed — and hyphen/space forms (E-mail, Sign-In) + the
// noun "Summary" are now caught. Leading \b keeps "Design"/"Logistics"/"Signal"
// safe. G live-ride addenda: provider labels must not cross into contact/call
// lanes or destructive list actions. Covers Email, E-mail, E Mail, Emailing,
// Summary, Zip-Code, Sign In, Sign-In, Signin, Signing-In, Log In, Log-In,
// Login, Log Into, Call/Phone/Text/SMS, Delete List, Clear List, Remove List.
const BLOCKED_PILL_RE =
  /\b(?:contact\w*|remind\w*|notif\w*|call(?:ing)?\b|phone\w*|text(?:ing)?\b|sms\b|e[-\s]?mail\w*|summar(?:y|i[sz]\w*)|change[-\s]?subject|confirm[-\s]?understanding|review[-\s]?key[-\s]?points|check[-\s]?understanding|get[-\s]?help\b|zip[-\s]?code\w*|(?:delete|clear|remove)[-\s]?list\b|stop[-\s]?(?:the[-\s]?)?(?:project|task|session)|cancel[-\s]?(?:this|project|task|session)|end[-\s]?(?:the[-\s]?)?(?:project|task|session)|sign(?:ing)?[-\s]?in(?:to)?\b|log(?:ging)?[-\s]?in(?:to)?\b|claude|herm\b|kea\b)/i;

const CONTROL_CHARS_RE = new RegExp(
  "[" +
    String.fromCharCode(0) +
    "-" +
    String.fromCharCode(31) +
    String.fromCharCode(127) +
    "]",
  "g",
);

const FILLER_RE =
  /\b(?:uh|um|okay|ok|yeah|yes|no|so|well|like|just|please|hey|six|6|here|there|this|that|thing|stuff|really|actually|basically|right|now|then|also|too|again|want|need|needs|needed|can|could|would|should|you|your|me|my|mine|our|the|a|an|and|or|to|of|for|with|on|in|at|by|from|it|its|is|are|was|were|be|been|being|have|has|had|do|does|did|get|got|make|made|put|take|give|show|see|look|hit|tap|press|button|list|lists|contractor list|pill|pills|pillboxes|box|boxes)\b/gi;

const SUBJECT_STOP_RE =
  /\b(?:email|gmail|proton|yahoo|outlook|sign\s*in|log\s*in|account|zip\s*code|phone|contact|reminder|notification)\b/i;

// The GENERIC fallback only fires on speech that actually smells like a
// repair/trade problem — G's live smoke 2026-07-04 minted junk pills ("Fix
// Visually", "Fix Worked Great") from status chatter and UI talk.
const GENERIC_SUBJECT_SIGNAL_RE =
  /\b(?:fix|repair|replace|install|broken|stuck|leak(?:ing)?|clog(?:ged)?|crack(?:ed)?|paint|build|clean|mow|grass|yard|gutter|roof|plumb(?:er|ing)?|electric(?:al|ian)?|handy\s*man|contractor|pro|estimate|quote)\b/i;
const GENERIC_SUBJECT_NOISE_RE =
  /\b(?:visually|visible|screen|chest|pill\s*boxes?|worked\s+great|great|thanks?|thank\s+you|okay|ok|perfect|nice)\b/i;
const APP_UI_NOUN_RE =
  /\b(?:app|interface|ui|screen|sheet|panel|drawer|card(?:s)?|button(?:s)?|pill\s*box(?:es)?|pills?|avatar|six|6|chest|camera\s+button|video\s+button|gallery\s+button)\b/i;
const APP_UI_FEEDBACK_RE =
  /\b(?:more|less|too|make|turn|bump|increase|decrease|bigger|smaller|larger|brown|light|brighter|darker|color|colour|splash|move|moving|animate|animation|wiggl(?:e|es|ing|y)|wigg(?:ing|in)|shak(?:e|es|ing)|shook|freak(?:s|ing|ed)?|fly(?:ing)?|crazy|fast|slow|tempo|text|font|size)\b/i;

// Two or more media-button nouns moving together is app-UI talk ("camera and
// gallery just shook together") — a single one ("my security camera is
// shaking") stays a real repair subject. Mirrors the client-side gate.
const MEDIA_CUE_NOUN_GLOBAL_RE = /\b(?:camera|video|gallery)\b/gi;
const APP_UI_STANDALONE_FEEDBACK_RE =
  /\b(?:more\s+(?:brown|light|color|colour)|(?:brown|light|color|colour)[-\s]*splash|text\s+size|make\s+(?:the\s+)?text\s+bigger)\b/i;

type SubjectMatch = {
  subject: string;
  kind: "trade" | "object" | "task";
  trade?: string;
  generic?: boolean;
};

const SUBJECT_PATTERNS: Array<[RegExp, SubjectMatch]> = [
  [/\b(?:air\s*condition(?:er|ing)?|a\s*\/\s*c|\bac\b|hvac|heat\s*pump|furnace)\b/i, { subject: "AC", kind: "trade", trade: "HVAC Pro" }],
  [/\b(?:handy\s*man|handyman|fix[- ]?it)\b/i, { subject: "Handyman", kind: "trade", trade: "Handyman" }],
  [/\b(?:paint(?:er|ing)?|drywall)\b/i, { subject: "Paint", kind: "trade", trade: "Painter" }],
  [/\b(?:plumb(?:er|ing)?|pipe|faucet|sink|drain|toilet|leak(?:y|ing)?|clog(?:ged|ging)?)\b/i, { subject: "Plumbing", kind: "trade", trade: "Plumber" }],
  [/\b(?:electric(?:ian|al)?|outlet|breaker|wire|light switch)\b/i, { subject: "Electrical", kind: "trade", trade: "Electrician" }],
  [/\b(?:roof(?:er|ing)?|gutter|shingle)\b/i, { subject: "Roof", kind: "trade", trade: "Roofer" }],
  [/\b(?:landscap(?:e|er|ing)|lawn|grass|yard|weeds?|crabgrass)\b/i, { subject: "Yard", kind: "trade", trade: "Landscaper" }],
  [/\b(?:window|sash)\b/i, { subject: "Window", kind: "object", trade: "Handyman" }],
  [/\b(?:door|hinge|lock|knob)\b/i, { subject: "Door", kind: "object", trade: "Handyman" }],
  [/\b(?:wall|ceiling|crack|hole|patch)\b/i, { subject: "Wall", kind: "object", trade: "Handyman" }],
  [/\b(?:floor|tile|grout|carpet|hardwood)\b/i, { subject: "Floor", kind: "object", trade: "Handyman" }],
  [/\b(?:stove|stovetop|burner|oven|range)\b/i, { subject: "Stove", kind: "object", trade: "Appliance Pro" }],
  [/\b(?:dishwasher|fridge|refrigerator|washer|dryer|appliance)\b/i, { subject: "Appliance", kind: "object", trade: "Appliance Pro" }],
  [/\b(?:scratch(?:ed|es|ing)?|dent|scuff)\b/i, { subject: "Damage", kind: "object", trade: "Handyman" }],
  [/\b(?:estimate|quote|price|cost)\b/i, { subject: "Estimate", kind: "task" }],
  [/\b(?:contractors?|pros?|professionals?)\b/i, { subject: "Pros", kind: "task" }],
];

// aiASAP-style safe fallback: when speech has no concrete subject, never mint
// pills from filler words. Rotate clean action labels so the text still changes
// without recreating "Fix Visually" / "Stop The Project" junk.
const ACTION_DEFAULT_POOL: string[] = [
  "Tell Me More",
  "Show A Photo",
  "What Is Wrong",
  "Get Estimate",
  "Find A Pro",
  "Compare Pros",
  "Fix It Myself",
  "How Bad Is It",
  "See My Options",
  "What It Costs",
  "Book A Visit",
  "Ask A Question",
];

function rotatingActionDefaults(seedText: string, avoid: string[] = []): string[] {
  let seed = 0;
  for (let i = 0; i < seedText.length; i += 1) {
    seed = (seed * 31 + seedText.charCodeAt(i)) & 0xffff;
  }
  const avoidLower = new Set(avoid.map((item) => item.toLowerCase()));
  const picked: string[] = [];
  const start = ACTION_DEFAULT_POOL.length ? seed % ACTION_DEFAULT_POOL.length : 0;
  for (let i = 0; i < ACTION_DEFAULT_POOL.length && picked.length < 3; i += 1) {
    const pill = ACTION_DEFAULT_POOL[(start + i) % ACTION_DEFAULT_POOL.length];
    if (!avoidLower.has(pill.toLowerCase())) picked.push(pill);
  }
  return sanitizePills(picked) ?? ACTION_DEFAULT_POOL.slice(0, 3);
}

export type PromptBrainInput = {
  latestUserText: string;
  recentUserTexts?: string[];
  currentPrompts?: string[];
  currentSubject?: string | null;
};

export function cleanPromptBrainText(raw: unknown, cap = MAX_TEXT): string {
  return typeof raw === "string"
    ? raw
        .replace(CONTROL_CHARS_RE, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, cap)
    : "";
}

// DEVICE/CONNECTION context is not a home/garden subject (G 13:11 ride:
// "now I'm on my computer" minted "Fix Computer / Get Help"). Shared
// predicate so BOTH the client gate and the route/tests hit the same logic
// (Herm TASK_144 Patch B). A repair signal ("my computer desk is broken")
// keeps the turn alive.
const DEVICE_CONTEXT_RE =
  /\b(?:(?:i'?m|i\s+am|we'?re|we\s+are|now|back)?\s*(?:on|using|at)\s+(?:my|the)?\s*(?:computer|laptop|desktop|phone|ipad|tablet)|(?:no|without|lost|don'?t\s+have)\s+(?:internet|wi[- ]?fi|connection|access)|(?:my|the)\s+(?:phone|computer|laptop|desktop|ipad|tablet)\s+(?:is\s+)?(?:working|connected|back|on))\b/i;

const DEVICE_REPAIR_SIGNAL_RE =
  /\b(?:fix|repair|replace|install|broken|stuck|leak(?:ing)?|clog(?:ged)?|crack(?:ed)?|paint|build|clean|mow|grass|yard|gutter|roof|plumb(?:er|ing)?|electric(?:al|ian)?|handy\s*man|contractor|pro|estimate|quote|desk|chair|table|appliance|door|window|wall|floor)\b/i;

// G narrates dev instructions to his agents BY NAME mid-ride ("So Claude, I
// want to make these letters bigger") — those turns minted "Fix Claude" /
// "Show Claude" pills (live-ride 19:40). Agent-name turns are dev meta-talk,
// never a repair subject.
const AGENT_NAME_RE = /\b(?:claude|herm|herman)\b/i;

export function isPromptBrainContextOnlyText(raw: unknown): boolean {
  const text = cleanPromptBrainText(raw, 300);
  if (!text) return false;
  if (AGENT_NAME_RE.test(text)) return true;
  if (DEVICE_REPAIR_SIGNAL_RE.test(text)) return false;
  const mediaNounCount = text.match(MEDIA_CUE_NOUN_GLOBAL_RE)?.length ?? 0;
  return Boolean(
    DEVICE_CONTEXT_RE.test(text) ||
      (APP_UI_NOUN_RE.test(text) && APP_UI_FEEDBACK_RE.test(text)) ||
      (mediaNounCount >= 2 && APP_UI_FEEDBACK_RE.test(text)) ||
      APP_UI_STANDALONE_FEEDBACK_RE.test(text),
  );
}

function titleCaseWords(raw: string): string {
  return raw
    .replace(/["'.!?]/g, "")
    .replace(/[^A-Za-z0-9 &/-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => {
      const upper = w.toUpperCase();
      if (["AC", "HVAC", "DIY"].includes(upper)) return upper;
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    })
    .join(" ");
}

function normalizePill(raw: string): string {
  return titleCaseWords(raw).slice(0, PILL_MAX_CHARS).trim();
}

function pushPill(out: string[], raw: string): void {
  const pill = normalizePill(raw);
  if (
    pill.length >= 3 &&
    pill.length <= PILL_MAX_CHARS &&
    !BLOCKED_PILL_RE.test(pill) &&
    !out.some((p) => p.toLowerCase() === pill.toLowerCase())
  ) {
    out.push(pill);
  }
}

export function sanitizePills(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") continue;
    pushPill(out, item);
    if (out.length === 3) break;
  }
  return out.length === 3 ? out : null;
}

function stripNegatedSubjectClauses(text: string): string {
  return text.replace(
    /\b(?:not|no|don'?t|do\s+not|didn'?t|did\s+not)\s+(?:need|want|mean|say\s+)?(?:a|an|the|any|another)?\s*(?:air\s*condition(?:er|ing)?|a\s*\/\s*c|ac|hvac|heat\s*pump|furnace|handy\s*man|handyman|fix[- ]?it|painters?|painting|drywall|plumbers?|plumbing|pipe|faucet|sink|drain|toilet|leak(?:y|ing)?|clog(?:ged|ging)?|electricians?|electrical|outlet|breaker|wire|light\s+switch|roofers?|roofing|roof|gutter|shingle|landscapers?|landscaping|lawn|grass|yard|weeds?|crabgrass|windows?|sash|door|hinge|lock|knob|wall|ceiling|crack|hole|patch|floor|tile|grout|carpet|hardwood|stove|stovetop|burner|oven|range|dishwasher|fridge|refrigerator|washer|dryer|appliance|scratch(?:ed|es|ing)?|dent|scuff)\b/gi,
    " ",
  );
}

function findSubject(text: string): SubjectMatch | null {
  const clean = stripNegatedSubjectClauses(cleanPromptBrainText(text, 300));
  if (!clean || SUBJECT_STOP_RE.test(clean) || isPromptBrainContextOnlyText(clean)) return null;
  for (const [re, match] of SUBJECT_PATTERNS) {
    if (re.test(clean)) return match;
  }

  if (
    !GENERIC_SUBJECT_SIGNAL_RE.test(clean) ||
    GENERIC_SUBJECT_NOISE_RE.test(clean)
  ) {
    return null;
  }

  const words = titleCaseWords(clean.replace(FILLER_RE, " "))
    .split(" ")
    .filter((w) => w.length >= 3)
    .slice(0, 3);
  const subject = words.join(" ");
  return subject.length >= 3
    ? { subject, kind: "object", trade: "Handyman", generic: true }
    : null;
}

export function derivePromptBrainSubject(input: PromptBrainInput): string {
  const latest = cleanPromptBrainText(input.latestUserText);
  const currentSubject = cleanPromptBrainText(input.currentSubject ?? "", 120);
  const latestMatch = findSubject(latest);

  // Concrete new speech wins immediately — this is the iPad fix: the pills are
  // anchored to what G is talking about right now, not only to old initial boxes.
  if (latestMatch && !latestMatch.generic) return latestMatch.subject;

  const currentMatch = findSubject(currentSubject);
  if (currentMatch) return currentMatch.subject;

  const recent = (input.recentUserTexts ?? [])
    .map((t) => cleanPromptBrainText(t))
    .filter(Boolean)
    .slice(-MAX_RECENT)
    .reverse();
  // Generic matches never become THE subject (Herm TASK_106: "visually",
  // "worked great" were minting junk pill sets) — only concrete trade/
  // object/task patterns anchor the pills.
  for (const text of recent) {
    const match = findSubject(text);
    if (match && !match.generic) return match.subject;
  }

  return "";
}

export function buildPromptBrainFallback(input: PromptBrainInput): string[] {
  const latest = cleanPromptBrainText(input.latestUserText);
  const subjectText = derivePromptBrainSubject(input) || latest;
  const match = findSubject(subjectText) ?? findSubject(latest);

  if (match && !match.generic) {
    const candidates =
      match.kind === "trade"
        ? [`Find ${match.trade ?? match.subject}`, "Get Estimate", "Compare Pros"]
        : match.kind === "task"
          ? [
              match.subject === "Estimate" ? "Get Estimate" : "Find Pros",
              "Compare Pros",
              "Next Step",
            ]
          : [`Fix ${match.subject}`, `Find ${match.trade ?? "Help"}`, "Show Me How"];
    const built = sanitizePills([...candidates, "Next Step", "Find Help", "Show Me How"]);
    if (built) return built;
  }

  return rotatingActionDefaults(subjectText || latest || "start", input.currentPrompts ?? []);
}

export function buildPromptBrainUserMessage(input: PromptBrainInput): string {
  const latest = cleanPromptBrainText(input.latestUserText);
  const recent = (input.recentUserTexts ?? [])
    .map((t) => cleanPromptBrainText(t))
    .filter(Boolean)
    .slice(-MAX_RECENT);
  const current = (input.currentPrompts ?? [])
    .filter((t): t is string => typeof t === "string")
    .map((t) => cleanPromptBrainText(t, PILL_MAX_CHARS))
    .filter(Boolean)
    .slice(0, 4);
  const currentSubject = derivePromptBrainSubject(input);

  // User speech is DATA, not instructions — quoted via JSON.stringify so a
  // spoken "ignore previous instructions" stays inert (house injection law).
  return [
    `Current subject to anchor the pills to: ${JSON.stringify(currentSubject || latest)}`,
    `Recent user speech (oldest first): ${JSON.stringify(recent)}`,
    `Latest user speech: ${JSON.stringify(latest)}`,
    `Pills currently shown: ${JSON.stringify(current)}`,
    "Reply with the JSON only.",
  ].join("\n");
}
