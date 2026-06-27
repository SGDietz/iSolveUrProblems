// Pure signup + session-intent helpers for 6.
// CARVED 2026-06-10 from src/components/LiveAvatarSession.tsx, logic UNCHANGED,
// so the replay harness (tests/) drives the exact same code the component runs.
// LiveAvatarSession.tsx imports everything from here - ONE source of truth.

export const ACCOUNT_MEMORY_VALUE_LINES = [
  "With an account, your lists stay intact, I remember the last conversation, and we pick up where we left off every time.",
  "That account is how I remember your likes, dislikes, lists, and the thread of the conversation instead of acting like we just met.",
  "If you've got a phone, you've got a friend. The account is what lets me remember you next time.",
  "When you create an account, I will remember everything you ask me to keep.",
];

export const INTERNAL_SIGNAL_RE =
  /^\s*\[(?:USER HAS BEEN SILENT|SILENT|OBJECT_NOT_VISIBLE)[^\]]*\]/i;

export const LIST_CLOSE_RE =
  /\b(?:close|hide|dismiss|drop|put away|take down|minimize|cierra|cerrar|oculta|ocultar|quita|quitar|ferme|fermer|cache|cacher|schliesse|schlie\u00dfe|ausblenden)\s+(?:the|my|this|that|la|mi|esta|esa|le|ma|cette|die|meine|diese)?\s*(?:grocery|shopping|walmart|to[-\s]?do|compras|mercado|tareas|courses|einkauf)?\s*(?:list|lists|lista|listas|liste)\b|\bmake\s+(?:the|my|this|that)?\s*(?:list|lists)\s+(?:disappear|go away)\b|\b(?:take|remove|drop)\s+(?:the|my|this|that)?\s*(?:grocery|shopping|walmart|to[-\s]?do)?\s*(?:list|lists)\s+(?:down|off|from)(?:\s+(?:the\s+)?screen)?\b|\btake\s+(?:it|this|that)\s+down\b|\bput\s+(?:it|this|that|the\s+list|the\s+lists)\s+away\b|\bno\s+(?:visible\s+)?list\b|\bback\s+to\s+(?:the\s+)?(?:prompts|boxes)\b/i;

export const ACCOUNT_SETUP_TRIGGER_RE =
  /\b(?:set up|setup|create|start|make|open)\s+(?:an?\s+)?account\b|\b(?:remember me|remember this next time|remember everything|save this for next time|sign me in|log me in)\b/i;
export const ACCOUNT_READY_YES_RE =
  /\b(?:yes|yeah|yep|sure|ready|ok|okay|correct|that'?s correct|that is correct|that'?s right|that is right|that does|that'?s it|that is it|it is|it'?s correct|it'?s right|sounds right|looks right|looks good|do it|let'?s do it|set it up|send it|send the email|send the link|send that)\b/i;
// 2026-06-10 (tracer find): 6's brain asks "first time signing up, or already
// have an account?" in parallel with the app's ready gate. The user's answer
// ("first time" / "I already have one") is them ENGAGING with signup — it must
// move the flow FORWARD, not stall the machine at the gate while the brain
// freelances (that stall is exactly what burned G's 13:11 session).
export const ACCOUNT_FIRST_TIME_RE =
  /\b(?:first time|my first|i'?m new|brand new|new here|never (?:signed|made|had) (?:up|one|an account)|don'?t have (?:an )?account)\b/i;
export const ACCOUNT_RETURNING_RE =
  /\b(?:already have (?:an |one|my )?(?:account)?|i'?m (?:a )?(?:member|returning)|been here before|have an account|signed up before)\b/i;
// r18 (2026-06-11, G's 12:49 session): "I'm not sure. You tell me." matched
// neither first-time nor returning — the gate stalled ARMED and the brain
// freelanced the signup (chest box never opened, spelled letters never popped).
// An unsure answer still moves forward: the server already resolves
// new-vs-existing by email, so the machine just asks for the spell and checks.
export const ACCOUNT_UNSURE_RE =
  /\b(?:not sure|you tell me|no idea|don'?t (?:know|remember|recall)|can'?t remember|i forget|how would i know)\b/i;
export const ACCOUNT_READY_NO_RE =
  /\b(?:no|nope|nah|not now|later|stop|never mind|nevermind|cancel|wait|hold on|hold up|wrong|incorrect|that'?s not|isn'?t right|don'?t send)\b/i;
// Consent-yes detection for the account gates. A CONSENT yes (email-is-correct /
// send-the-link) must OPEN with a clear affirmation AND carry NO complaint or
// screen-observation. Two real bugs shaped this (both G 2026-06-09): (a) a buried
// "okay"/"right" inside a COMPLAINT wrongly FIRED a send ("Okay, so the box says
// SGDeets@email.it"); (b) an over-strict allow-list then wrongly REJECTED a real
// yes ("Yes. Send the sign-in link"). Open-with-affirmation + no-complaint signal
// does both: accepts short natural yeses, rejects descriptions of the screen.
// 2026-06-10 ('at' trap): spoken-address fragments ("at pm dot me", "dot com")
// inside a yes mean the user is DESCRIBING/correcting the address, not
// consenting — a consent there could send the link to a wrong email.
export const CONSENT_COMPLAINT_RE =
  /\b(?:box|pillbox|says?|saying|still|screen|spell|wad\s?works|never|don'?t think|won'?t|isn'?t|wasn'?t|shouldn'?t|your email|email is|email'?s|confirmation)\b|@|\.(?:com|net|org|me|it|io|co)\b|\bdot\s+(?:com|net|org|me|io|co|it)\b|\bat\s+[a-z0-9-]{1,16}\s+dot\b/i;
// SWEEP FIX (2026-06-10 adversarial review): the old filler group required a
// SPACE after the filler, so "um, yes" (STT loves that comma) failed consent —
// and a leading "fuck yes" failed outright (G's crowd talks like G). Fillers
// and intensifiers may now repeat with commas between; the complaint check
// still runs first, so screen-descriptions stay rejected.
// GHOST-#3 ADDITION (Julius session): "It is." / "It is correct." is G's most
// natural confirm and it opened with nothing on the list — gate stalled.
export const CONSENT_YES_OPEN_RE =
  /^[\s,.!'-]*(?:(?:well|um|uh|so|and|okay then|alright|fucking|fuck|hell|damn|man|dude)\b[\s,.!'-]*)*(?:yes|yeah|yea|yep|yup|sure|ok|okay|okey|correct|perfect|absolutely|definitely|sounds good|looks good|that'?s (?:right|correct|it)|that is (?:right|correct|it)|it is(?: correct| right)?\b|it'?s (?:correct|right)|go ahead|do it|send it|send the|please send|send)\b/i;
export function isAccountConsentYes(text: string): boolean {
  if (ACCOUNT_READY_NO_RE.test(text)) return false; // any no / wait / wrong blocks
  if (CONSENT_COMPLAINT_RE.test(text)) return false; // describing the screen != consent
  return CONSENT_YES_OPEN_RE.test(text); // must open with a clear affirmation
}
export const EMAIL_RE = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
export const EMAIL_ENTRY_REQUEST_RE =
  /\b(?:type|typing|text|write|enter|keyboard|text box|textbox|input|pop up|popup)\b.*\b(?:email|address|it|that)\b|\b(?:can i|let me)\s+(?:type|text|write|enter)\s+(?:the\s+)?(?:email|address|it)\b/i;

export const ACCOUNT_SETUP_REOFFER_COOLDOWN_MS = 90_000;
export const END_CONVERSATION_RE =
  /\b(?:end|stop|finish|quit|exit|close|shut\s+down|wrap up|done with)\s+(?:this|the|my)?\s*(?:conversation|session|chat|talk|site|app|avatar|six|6)\b|\b(?:i'?m done|all done|that'?s all)\s+(?:with\s+)?(?:this|the|my)?\s*(?:conversation|session|chat|talk|site|app|avatar|six|6|for now)\b/i;
export const END_SESSION_CONFIRM_RE =
  /\b(?:yes|yeah|yep|yup|yea|sure|ok|okay|correct|right|do it|go ahead|close|stop|end|quit|exit|shut\s+(?:it\s+)?down|that'?s right|that is right|please)\b/i;
export const END_SESSION_CANCEL_RE =
  /\b(?:no|nope|nah|not now|later|never mind|nevermind|cancel|keep going|continue|stay|don'?t|do not)\b/i;

// --- Close-confirmation hardening (2026-06-01) ---------------------------------
// A passing MENTION of closing must never end the session. While waiting on a
// confirm we accept only three shapes, all unambiguous:
//   1. An explicit verb+object close command at any length ("close it",
//      "shut it down", "end the session").
//   2. A whole-utterance bare command ("stop.", "close", "done") — these are
//      exactly the words 6's own confirm prompt tells the user to say.
//   3. A whole-utterance affirmation ("yes", "yeah ok", "go ahead").
// A long sentence that merely CONTAINS "yeah/ok/right/stop/close" is ordinary
// conversation and must NOT confirm (this is what closed G's session twice).
export const END_SESSION_CLOSE_VERB_RE =
  /\b(?:close|end|stop|quit|exit|finish|wrap\s+up|hang\s+up)\s+(?:it|this|us|me\s+out|the\s+(?:session|conversation|chat|call|talk|app|site))\b|\bshut\s+(?:it\s+)?down\b/i;
export const END_SESSION_CONFIRM_CMD_RE =
  /^(?:stop|close|end|quit|exit|done|finish|shut\s*it\s*down|shut\s*down|hang\s*up|sign\s*off|log\s*off|that'?s\s+all|i'?m\s+done)[\s.,!-]*$/i;
export const END_SESSION_AFFIRM_ONLY_RE =
  /^(?:(?:yes|yeah|yep|yup|yea|sure|ok|okay|okey|kay|correct|right|alright|all\s+right|affirmative|please|do\s+it|go\s+ahead|go\s+for\s+it|that'?s\s+right|that\s+is\s+right)[\s.,!-]*)+$/i;
// "How do I close", "don't close", "not yet", "maybe later" must NOT arm the prompt.
export const END_SESSION_BLOCK_RE =
  /\b(?:don'?t|do\s+not|won'?t|will\s+not|can'?t|cannot|how\s+(?:do|can|to|would)|what\s+(?:if|happens)|why|maybe|might|if\s+i|if\s+you|when\s+i|let\s+me\s+ask|remember\s+me|next\s+time|would\s+you\s+remember|not\s+(?:yet|now|sure|really))\b/i;

// --- STT-SHARD CLOSE STITCH (G 2026-06-14) ----------------------------------
// STT sometimes splits "close the session" into TWO utterances: a dangling
// verb head ("close the") then a bare object tail ("session"). Neither shard
// matches END_CONVERSATION_RE alone, so the bare tail fell through to the
// brain (6 answered "session" as conversation). We stitch the two ONLY when
// the prior fragment is a genuine close-verb head AND the current fragment is
// a bare close-object tail. A standalone "session" with no close-ish
// predecessor never closes.
export const END_SESSION_TAIL_RE =
  /^[\s,.!'-]*(?:the\s+|this\s+|that\s+|my\s+)?(?:session|conversation|chat|talk|app|site|avatar)\b[\s,.!?'-]*$/i;
export const END_SESSION_VERB_TAIL_RE =
  /\b(?:close|end|stop|quit|exit|finish|wrap\s+up|hang\s+up|shut\s+(?:it\s+)?down)(?:\s+(?:the|this|that|my))?[\s,.!'-]*$/i;

// Stitch a bare close-object tail onto a recent dangling close-verb head.
// True ONLY when the prior fragment ended with a close verb (+optional
// article), the current fragment is a bare close object, the joined phrase is
// a real close, and the joined phrase is not a question/negation.
export function isStitchedSessionClose(
  priorText: string,
  currentText: string,
): boolean {
  if (!END_SESSION_TAIL_RE.test(currentText)) return false;
  if (!END_SESSION_VERB_TAIL_RE.test(priorText)) return false;
  // STT often re-emits the article across the split ("close the" + "the
  // session" => "close the the session"), which would fail the intent test.
  // Collapse a doubled boundary article before the check.
  const stitched = `${priorText} ${currentText}`.replace(
    /\b(the|this|that|my)\s+(?:the|this|that|my)\b/i,
    "$1",
  );
  if (END_SESSION_BLOCK_RE.test(stitched)) return false;
  return hasEndSessionIntent(stitched);
}

export const ONLINE_LOOKUP_CLOSE_RE =
  /\b(?:close|hide|dismiss|clear|stop|end|remove|take\s+(?:off|away|down)|get\s+rid\s+of)\s+(?:the|this|that|my|a|an)?\s*(?:search|results?|sources?|lookup|online\s+search|events?|pill\s*boxes?|pills?|location(?:\s+(?:box|popup|pop\s*up|panel|window))?|box|popup|pop\s*up|panel|window|things\s+that\s+came\s+up)(?:\s+(?:from|off)\s+(?:the\s+)?screen)?\b|\bmake\s+(?:the|this|that|my)?\s*(?:events?|search|results?|box|popup|pop\s*up|panel|pill\s*boxes?|pills?)\s+go\s+away\b/i;

export const SHOPPING_MODE_CLOSE_RE =
  /\b(?:close|exit|leave|stop)\s+(?:shopping|store|full screen)\s*mode\b/i;

export function isInternalSignal(text: string): boolean {
  return INTERNAL_SIGNAL_RE.test(text.trim());
}

export function hasEndSessionIntent(text: string): boolean {
  if (isInternalSignal(text)) return false;
  if (
    LIST_CLOSE_RE.test(text) ||
    SHOPPING_MODE_CLOSE_RE.test(text) ||
    ONLINE_LOOKUP_CLOSE_RE.test(text)
  ) {
    return false;
  }
  // A question about closing or a negated mention is not a request to close.
  if (END_SESSION_BLOCK_RE.test(text)) return false;
  return END_CONVERSATION_RE.test(text);
}

export function confirmsEndSession(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  // A cancel/negation always wins ("no", "not now", "keep going", "don't").
  if (END_SESSION_CANCEL_RE.test(trimmed)) return false;
  // 1. Explicit verb+object close command — confirms at any length.
  if (END_SESSION_CLOSE_VERB_RE.test(trimmed)) return true;
  // 2. Whole-utterance bare command ("stop", "close", "done").
  if (END_SESSION_CONFIRM_CMD_RE.test(trimmed)) return true;
  // 3. Whole-utterance affirmation ("yes", "yeah ok"). A long sentence that just
  //    contains a filler "yeah/ok/right" is NOT a confirmation.
  return END_SESSION_AFFIRM_ONLY_RE.test(trimmed);
}

export const DEVICE_NAME_STOP_WORDS = new Set([
  "yes",
  "no",
  "just",
  "okay",
  "ok",
  "grocery",
  "groceries",
  "list",
  "todo",
  "to-do",
  "walmart",
  "shopping",
  "store",
  "at",
  "in",
  "on",
  "to",
  "for",
  "from",
  "going",
  "looking",
  "trying",
  "working",
  "doing",
  "having",
  "making",
  "building",
  "planning",
  "here",
  "back",
  "ready",
  "fine",
  "good",
  "excited",
  "reminder",
  "birthday",
  "weekend",
  "hike",
  "hikes",
  "hiking",
  "email",
  "phone",
  "help",
  "nothing",
  "later",
  "cancel",
  // Confirmation / filler / signup-answer words that must NEVER become a name
  // (G 2026-06-03: "It is" confirming the email got stored as "It Is"; an
  // earlier "first time" answer got stored as "First Time"). Apology/hesitation
  // fillers added 2026-06-07: "Sorry about that" got stored as the name "Sorry".
  "sorry",
  "apologies",
  "apologize",
  "oops",
  "oof",
  "excuse",
  "pardon",
  "wait",
  "actually",
  "hold",
  "it",
  "is",
  "it's",
  "its",
  "first",
  "time",
  "yeah",
  "yep",
  "yup",
  "nope",
  "sure",
  "right",
  "correct",
  "send",
  "sent",
  "perfect",
  "great",
  "thanks",
  "thank",
  "please",
  "oui",
  "si",
  "wait",
  "hold",
  "um",
  "uh",
  // Speech/state words that slip in from "I'm talking" / "user has not been
  // silent" / "I'm speaking" (G 2026-06-04: name saved as "Talking").
  "talking",
  "talk",
  "speaking",
  "speak",
  "silent",
  "saying",
  "said",
  "listening",
  "user",
  "continuously",
  "interrupting",
  "interrupt",
  "anyway",
  "anyways",
  // 2026-06-11 (r18, "Now" stored as G's name from "you're not gonna remember
  // who I am now?"): time/negation words that ride right behind "I am".
  "now",
  "not",
  "there",
  "today",
  "tonight",
  "gonna",
  "anymore",
]);

export function cleanDeviceName(value: string): string | null {
  let name = value
    .replace(/\b(?:the\s+letter|letter)\s+([a-z])\b/i, "$1")
    .replace(/^(?:is|it's|its|this is)\s+/i, "")
    .replace(/[.,!?;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!name || name.length > 40 || /[@\d?]/.test(name)) return null;
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length > 3) return null;
  if (words.some((word) => DEVICE_NAME_STOP_WORDS.has(word.toLowerCase()))) {
    return null;
  }
  if (!words.every((word) => /^[a-z][a-z'.-]*$/i.test(word))) return null;

  // r32 (G live 2026-06-12 20:42: "G the letter G" stored as "G G" and 6
  // greeted him "Welcome back, G G!"): after letter-form expansion, repeated
  // words collapse — people repeat the letter, nobody is named "G G".
  const deduped = words.filter(
    (word, index) =>
      index === 0 || word.toLowerCase() !== words[index - 1].toLowerCase(),
  );

  name = deduped
    .map((word) =>
      word.length === 1
        ? word.toUpperCase()
        : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(" ");
  return name;
}

/** True for stored "names" that are really lead-in phrases / filler, never a
 * real person's name - "Call Me", "My Name", "I'm", "First Time" (G 2026-06-08). */
export function isJunkPersonName(name: string | null | undefined): boolean {
  if (!name) return false;
  const n = name.trim().toLowerCase().replace(/[.,!?]+$/g, "");
  return /^(?:call me|my name(?: is)?|name is|i am|i'?m|the name(?: is)?|you can call me|they call me|people call me|this is|it'?s|its|first time|it is)$/.test(
    n,
  );
}

export function extractDeviceNameCandidate(text: string, allowPlainAnswer: boolean): string | null {
  // BUGFIX (2026-06-10, the Kevin session): people say "my name is, um, Kevin"
  // — the comma after "is" broke the old \s+ and the name was NEVER captured,
  // which armed the name step and cascaded the whole signup into the brain's
  // hands. Eat commas/dashes plus filler words (um/uh/like) between the
  // lead-in and the name. Fillers are matched with \b so "Umberto" never
  // loses his "Um".
  const FILLER = /^(?:(?:um|uh|like|its|it'?s|well)\b[\s,.-]*)*/i;
  const explicitRaw =
    text.match(/\bmy name(?:'?s| is)\b[\s,.-]*([^.!?]{1,60})/i)?.[1] ??
    text.match(/\b(?:you can )?call me\b[\s,.-]*([^.!?]{1,60})/i)?.[1] ??
    // CLAUSE-START GUARD (2026-06-11, r18): "I am" only introduces a name when
    // it STARTS the clause — "you're not gonna remember who I am now?" captured
    // the name "Now" because mid-clause "I am" matched bare \b.
    text.match(/(?:^|[.!?,;:]\s*|\b(?:and|so|well|yeah|yes|hi|hey|hello|but|oh|okay|ok)\b[\s,]*)(?:i am|i'm|im)\s+([^,.!?]{1,40})/i)?.[1] ??
    // SWEEP FIX (2026-06-10): "I'm, um, Alice" — the comma path on i'm is
    // allowed ONLY through an explicit filler word, so "I am, however, not
    // sure" can never turn "However" into a name.
    text.match(/(?:^|[.!?,;:]\s*|\b(?:and|so|well|yeah|yes|hi|hey|hello|but|oh|okay|ok)\b[\s,]*)(?:i am|i'?m|im)\b[\s,]*(?:(?:um|uh|like)\b[\s,]*)+([^,.!?]{1,40})/i)?.[1] ??
    null;
  const explicit = explicitRaw
    ? explicitRaw.replace(FILLER, "").split(/[,]/)[0].trim().slice(0, 40)
    : null;
  if (explicit) return cleanDeviceName(explicit);
  if (!allowPlainAnswer) return null;
  if (text.length > 40 || /[?@]/.test(text)) return null;
  // STT often splits "call me G" into "Call me" + "G". Never store a bare
  // lead-in ("call me" / "my name is" / "I'm") AS the name - strip it; if
  // nothing real is left, return null so 6 asks again. (G 2026-06-08: the
  // bare "Call me" chunk was being saved as the name "Call Me".)
  const stripped = text
    .replace(
      /^\s*(?:(?:you can|please|just|so|well|um|uh|yeah|ok|okay)\s+)*(?:call me|my name(?: is|'?s)?|i am|i'?m|im|they call me|people call me|the name is|name is)\b[\s,'.-]*/i,
      "",
    )
    .trim();
  if (!stripped) return null;
  // r28 (copilot 2026-06-12, G live: "I want to create a" got chopped by STT
  // and the trailing "a" became his name — "Got it, a."): a bare article or
  // pronoun is never a name. Single LETTERS stay allowed — G himself is "G".
  if (/^(?:a|an|the|i)$/i.test(stripped)) return null;
  return cleanDeviceName(stripped);
}

export function buildAccountMemoryOffer(customSpoken: string | undefined, seed: number): string {
  const valueLine =
    ACCOUNT_MEMORY_VALUE_LINES[seed % ACCOUNT_MEMORY_VALUE_LINES.length];
  const base = customSpoken?.trim()
    ? customSpoken.replace(/\s+You ready\??$/i, "").trim()
    : "Account setup is optional, but it makes this feel more human.";
  return `${base} ${valueLine} You ready?`;
}

export const SPOKEN_EMAIL_NOISE_WORDS = new Set([
  "email",
  "e",
  "mail",
  "address",
  "is",
  "its",
  "it",
  "my",
  "the",
  "send",
  "link",
  "to",
  // 2026-06-10 ('at' trap, caught by test): "yes at pm dot me" parsed into the
  // address yes@pm.me and REPLACED the real pending email. Consent/filler words
  // can never be a glued local part — a real yes@... owner spells it Y-E-S.
  "yes",
  "yeah",
  "yep",
  "yup",
  "no",
  "ok",
  "okay",
  "sure",
  "correct",
  "right",
  "that",
  "thats",
  "this",
]);

export function isValidEmailCandidate(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

// Spoken words that map to a single email symbol when the user is SPELLING.
export const SPELL_SYMBOL_WORDS: Record<string, string> = {
  at: "@",
  "at sign": "@",
  dot: ".",
  period: ".",
  point: ".",
  underscore: "_",
  "under score": "_",
  dash: "-",
  hyphen: "-",
  minus: "-",
  plus: "+",
};
// Spoken number words → digits (people spell digits in emails too).
export const SPELL_NUMBER_WORDS: Record<string, string> = {
  zero: "0",
  oh: "0",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
};
// Filler the listener throws in front of a spell ("okay", "it's", "my email is").
// These are dropped so they don't pollute the captured address.
export const SPELL_FILLER_WORDS = new Set([
  "okay",
  "ok",
  "its",
  "it",
  "is",
  "my",
  "the",
  "email",
  "e",
  "mail",
  "address",
  "so",
  "um",
  "uh",
  "and",
  "then",
  "letter",
  "number",
  "lowercase",
  "uppercase",
  "capital",
]);

/**
 * Interpret ONE spoken utterance as spelled-out email characters and return the
 * tight character run to append to the on-chest box (FIX 1, 2026-06-01).
 *
 * Handles letters said individually ("s g d i e t z"), runs glued by the ASR
 * ("sgd ietz"), the words "at"/"dot"/etc. → symbols, number words → digits, and
 * an already-inline address ("sgdietz@pm.me"). Leading conversational filler
 * ("okay, it's ...") is stripped.
 *
 * `looksSpelled` is false when the utterance is mostly real words (multi-letter
 * tokens that are not filler/symbols and not an inline address) — that is the
 * signal for 6 to say "Please spell it slowly." instead of capturing garbage.
 */
export function parseSpelledEmailChunk(text: string): {
  chars: string;
  looksSpelled: boolean;
} {
  const lowered = text.toLowerCase().replace(/[']/g, "");
  // Collapse multi-word symbols first ("at sign", "under score").
  const preSymboled = lowered
    .replace(/\bat sign\b/g, " @ ")
    .replace(/\bunder score\b/g, " _ ");
  const tokens = preSymboled
    .split(/[\s,]+/g)
    .map((t) => t.trim())
    .filter(Boolean);

  let chars = "";
  let wordTokenCount = 0; // real-word tokens we could not interpret as a spell
  let spellTokenCount = 0; // letters/digits/symbols/inline — evidence of spelling

  for (const token of tokens) {
    // An inline address fragment ("sgdietz@pm.me" or "@pm.me") — take its email
    // characters verbatim.
    if (/[@]/.test(token) || /^[a-z0-9._%+-]+\.[a-z]{2,}$/.test(token)) {
      const cleaned = token.replace(/[^a-z0-9._%+@-]/g, "");
      if (cleaned) {
        chars += cleaned;
        spellTokenCount += 1;
        continue;
      }
    }
    // SWEEP FIX (2026-06-10 adversarial review): STT chains spelled letters
    // with hyphens ("s-g-d-i-e-t-z"). That used to read as ONE unknown word
    // and trip the low-confidence "please spell it slowly" flag even though
    // every character was a clean spell. A hyphen chain of singles IS a spell.
    if (/^[a-z0-9](?:-[a-z0-9])+$/.test(token)) {
      chars += token.replace(/-/g, "");
      spellTokenCount += 1;
      continue;
    }
    if (token in SPELL_SYMBOL_WORDS) {
      chars += SPELL_SYMBOL_WORDS[token];
      spellTokenCount += 1;
      continue;
    }
    if (token in SPELL_NUMBER_WORDS) {
      chars += SPELL_NUMBER_WORDS[token];
      spellTokenCount += 1;
      continue;
    }
    // A single letter or digit = one spelled character.
    if (/^[a-z0-9]$/.test(token)) {
      chars += token;
      spellTokenCount += 1;
      continue;
    }
    // Pure punctuation token (e.g. "." or "_").
    if (/^[._%+@-]+$/.test(token)) {
      chars += token;
      spellTokenCount += 1;
      continue;
    }
    // Drop known filler words silently.
    if (SPELL_FILLER_WORDS.has(token)) {
      continue;
    }
    // A leftover multi-character word. It MIGHT be a glued letter run the ASR
    // merged ("sgd"), so we still take its alphanumerics — but we also count it
    // as a "word token" so an utterance made mostly of real words trips the
    // low-confidence flag and asks the user to spell more slowly.
    const alnum = token.replace(/[^a-z0-9._%+-]/g, "");
    if (alnum) {
      chars += alnum;
    }
    wordTokenCount += 1;
  }

  // Confident it was a spell when we captured at least one real email character
  // and the multi-letter "word" tokens did not dominate the utterance.
  const looksSpelled =
    spellTokenCount + chars.length > 0 && wordTokenCount <= spellTokenCount;

  return { chars, looksSpelled };
}

export function extractSpokenEmailCandidate(text: string): string | null {
  const directMatch = text.match(EMAIL_RE);
  const direct = directMatch?.[0]?.trim().toLowerCase();
  if (direct && isValidEmailCandidate(direct)) {
    // Guard against the dropped-local-part bug: speech like "Okay, it's SGD
    // IETZ@pm.me" makes EMAIL_RE start at "IETZ" (the space before it ends the
    // \b local part) and silently yield "ietz@pm.me", losing "sgd". If the
    // matched address is immediately preceded by more local-part-looking
    // characters (allowing a run of spaces, i.e. spoken letters), the inline
    // match is NOT the whole intended local part. Rather than save a wrong,
    // partial address — or greedily stitch conversational filler onto it — we
    // bail to null so the caller asks the user to spell it slowly. NEVER save a
    // guessed email. A clean inline address (no glued prefix) still returns
    // immediately, the common typed/pasted case.
    const matchStart = directMatch?.index ?? -1;
    const preceding = matchStart > 0 ? text.slice(0, matchStart) : "";
    const hasDroppedLocalPart = /[A-Za-z0-9._%+-]\s*$/.test(preceding);
    if (!hasDroppedLocalPart) {
      return direct;
    }
    // GHOST-#3 FIX (2026-06-10, Julius session): "my email IS sgdietz@pm.me."
    // tripped this guard too — "is " looks like a glued prefix. When the word
    // before the address is ordinary lead-in chatter (is/its/email/at/to...),
    // the inline match IS the whole address — return it. A real glued spell
    // ("SGD IETZ@pm.me") still bails: "sgd" is not a lead-in word.
    const lastWord = preceding.trim().split(/\s+/).pop()?.toLowerCase() ?? "";
    if (SPOKEN_EMAIL_NOISE_WORDS.has(lastWord.replace(/[^a-z]/g, ""))) {
      return direct;
    }
    return null;
  }

  const normalized = text
    .toLowerCase()
    .replace(/[']/g, "")
    .replace(/[\u2013\u2014]+/g, " ")
    .replace(/\b(?:at sign|at)\b/g, " @ ")
    .replace(/\b(?:dot|period|point)\b/g, " . ")
    .replace(/\s+/g, " ")
    .trim();
  const atIndex = normalized.indexOf("@");
  if (atIndex < 1) return null;

  // BUGFIX (2026-06-10, caught by the replay harness on its first run): the old
  // flat noise filter ATE the spelled letter "e" (it doubled as the "e" of
  // "e mail"), so "s g d i e t z at pm dot me" saved sgdItz@pm.me — and a
  // .slice(-6) token cap beheaded any local part spelled in 7+ pieces
  // ("s c o t t d i e t z" lost its head). Walk BACKWARD from the "@" instead,
  // the same proven shape as parseEmailFromAvatarReadback's local-part walk:
  // spelled single characters ALWAYS count (even "e"), clean multi-character
  // runs count unless they are known noise words, and the walk STOPS at the
  // first noise/other word — so leading chatter never glues on and no cap is
  // needed.
  const beforeAt = normalized
    .slice(0, atIndex)
    .split(/[^a-z0-9._%+-]+/g)
    .map((token) => token.trim())
    .filter(Boolean);
  const localParts: string[] = [];
  for (let i = beforeAt.length - 1; i >= 0; i -= 1) {
    const token = beforeAt[i];
    if (/^[a-z0-9]$/.test(token)) {
      localParts.unshift(token);
      continue;
    }
    if (SPOKEN_EMAIL_NOISE_WORDS.has(token)) break;
    if (/^[a-z0-9._%+-]{2,}$/.test(token)) {
      localParts.unshift(token);
      continue;
    }
    break;
  }
  const local = localParts.join("").replace(/[^a-z0-9._%+-]/g, "");
  if (local.length < 2) return null;

  const domainWords = normalized
    .slice(atIndex + 1)
    .replace(/\s*\.\s*/g, ".")
    .replace(/[^a-z0-9.\s-]/g, " ")
    .split(/\s+/g)
    .map((word) => word.trim())
    .filter(Boolean);
  let domain: string | null = null;
  for (let count = 1; count <= Math.min(domainWords.length, 5); count += 1) {
    // GHOST-#3 FIX (2026-06-10): the sentence-ending period rode along on the
    // domain ("pm.me." from "...is sgdietz@pm.me.") and failed validation, so
    // a perfectly spoken address parsed to null. Trim edge dots before judging.
    const candidate = domainWords
      .slice(0, count)
      .join("")
      .replace(/[^a-z0-9.-]/g, "")
      .replace(/^\.+|\.+$/g, "");
    if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(candidate)) {
      const tld = candidate.split(".").at(-1) ?? "";
      if (tld.length >= 2) {
        domain = candidate;
        break;
      }
    }
  }
  if (!domain) return null;

  const candidate = `${local}@${domain}`;
  return isValidEmailCandidate(candidate) ? candidate : null;
}

/**
 * CHANGE 1 (2026-06-01): parse the email out of 6's OWN spoken confirmation
 * (AVATAR_TRANSCRIPTION), NOT the raw user STT. 6's brain denoises the spelled
 * letters and reads the address back in a tight, parseable shape, e.g.
 *   "Got it! That's S-G-D-I-E-T-Z at P-M dot M-E. Did I get that right?"
 *   → "sgdietz@pm.me"
 * That readback is the reliable source of truth, so the on-chest box mirrors it.
 *
 * Strategy: isolate the address SPAN around the "at"/"@" so surrounding chatter
 * ("Got it!", "Did I get that right?") is dropped, then collapse the spelled
 * letters/hyphens/spaces into the local part and domain. Also accepts an inline
 * address if 6 happens to say one. Returns a lowercased address validated by
 * isValidEmailCandidate, or null if there's no confident address.
 */
export function parseEmailFromAvatarReadback(spokenText: string): string | null {
  if (!spokenText || typeof spokenText !== "string") return null;

  // 1) A clean inline address spoken verbatim ("sgdietz@pm.me") wins outright.
  const directMatch = spokenText.match(EMAIL_RE);
  const direct = directMatch?.[0]?.trim().toLowerCase();
  if (direct && isValidEmailCandidate(direct)) {
    return direct;
  }

  // Words that signal the readback has ENDED — trailing chatter after the
  // address ("...dot com, did I get that right?"). These must not be pulled
  // into the domain.
  const READBACK_TAIL_STOP = new Set([
    "did", "i", "get", "that", "right", "correct", "is", "it", "yes", "no",
    "so", "okay", "ok", "and", "the", "your", "you", "does", "look", "looks",
    "good", "sound", "sounds", "please", "ready", "send", "on", "screen",
    "check", "make", "sure", "heard", "have",
  ]);

  // 2) Spelled readback. Lowercase, drop apostrophes/quotes, treat hyphens/
  //    dashes between spelled letters as separators (S-G-D-I-E-T-Z →
  //    "s g d i e t z"), turn spoken symbol words into the symbols, drop
  //    sentence punctuation, and peel a trailing sentence period off the end of
  //    a word ("m-e." → "m e") while keeping a standalone "." (from "dot") as a
  //    separator.
  const normalized = spokenText
    .toLowerCase()
    .replace(/[''"]/g, "")
    .replace(/[–—-]+/g, " ")
    .replace(/\bat sign\b/g, " @ ")
    .replace(/\bat\b/g, " @ ")
    .replace(/\b(?:dot|period|point)\b/g, " . ")
    .replace(/\bunderscore\b/g, " _ ")
    .replace(/\bunder score\b/g, " _ ")
    .replace(/[!?;:,]/g, " ")
    .replace(/([a-z0-9])\.(?=\s|$)/g, "$1 ")
    .replace(/\s+/g, " ")
    .trim();

  // Tokenize; map spoken number words to digits ("seven" → "7").
  const tokens = normalized
    .split(/\s+/g)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => (t in SPELL_NUMBER_WORDS ? SPELL_NUMBER_WORDS[t] : t));

  // Must contain an "@" anchor with something before it.
  const atPos = tokens.indexOf("@");
  if (atPos < 1) return null;

  // 3) LOCAL PART: walk left from "@" collecting single-letter/digit and
  //    single-symbol tokens (spelled local). ALSO accept ONE multi-char alnum
  //    token if it sits directly against "@" (a glued/inline local like
  //    "sgdietz"); then stop. Leading chatter ("that's", "email") never sits
  //    flush against "@", so it is excluded.
  const localParts: string[] = [];
  for (let i = atPos - 1; i >= 0; i -= 1) {
    const tok = tokens[i];
    if (/^[a-z0-9]$/.test(tok) || /^[._%+-]$/.test(tok)) {
      localParts.unshift(tok);
      continue;
    }
    if (localParts.length === 0 && /^[a-z0-9][a-z0-9._%+-]*$/.test(tok)) {
      localParts.unshift(tok);
    }
    break;
  }
  const local = localParts.join("");
  if (local.length < 1 || !/^[a-z0-9._%+-]+$/.test(local)) return null;

  // 4) DOMAIN: tokens after "@". The domain may be spelled letter-by-letter
  //    ("p m") OR a whole word ("gmail"). Accept single chars, ".", and
  //    domain-looking words; STOP at a trailing chatter word (READBACK_TAIL_STOP)
  //    so "...dot com right?" doesn't pull "right" into the domain.
  const domainParts: string[] = [];
  for (let i = atPos + 1; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === "." || /^[a-z0-9]$/.test(tok)) {
      domainParts.push(tok);
      continue;
    }
    if (/^[a-z0-9-]{2,}$/.test(tok)) {
      if (READBACK_TAIL_STOP.has(tok)) break;
      domainParts.push(tok);
      continue;
    }
    break;
  }
  const domain = domainParts
    .join("")
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
  if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)) return null;

  const candidate = `${local}@${domain}`;
  return isValidEmailCandidate(candidate) ? candidate : null;
}

// A domain merge is a CORRECTION — it needs correction words. Without this
// gate, any ramble containing a domain-shaped sound rewrote the pending email:
// G's "...you said that really in a fucked up way. Like, I could never..."
// normalized to "way.like" and the address became wildworks@way.like (caught
// by the 2026-06-11 echo-guard replay; the live session survived only because
// 6's readback guard happened to be set).
const DOMAIN_CORRECTION_INTENT_RE =
  /\b(?:no|nope|wrong|incorrect|actually|i said|should be|supposed to be|change (?:it|that|the domain)?\s*to)\b/i;

export function mergeEmailDomainCorrection(
  text: string,
  previousEmail: string | null,
): string | null {
  if (!previousEmail || !previousEmail.includes("@")) return null;
  if (!DOMAIN_CORRECTION_INTENT_RE.test(text)) return null;
  const local = previousEmail.split("@")[0];
  if (!local || local.length < 2) return null;
  const normalized = text
    .toLowerCase()
    .replace(/[']/g, "")
    .replace(/\b(?:dot|period|point)\b/g, ".")
    .replace(/[^a-z0-9.\s-]/g, " ")
    .replace(/\s*\.\s*/g, ".")
    .replace(/\s+/g, " ")
    .trim();
  const domain = normalized.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)+\b/)?.[0];
  if (!domain) return null;
  const candidate = `${local}@${domain}`;
  return isValidEmailCandidate(candidate) ? candidate : null;
}

export function extractAccountEmailCandidate(
  text: string,
  fallbackEmail: string | null,
): string | null {
  const candidate =
    extractSpokenEmailCandidate(text) ??
    fallbackEmail?.trim().toLowerCase() ??
    null;
  if (!candidate) return null;
  // 2026-06-10 ('at' trap): the lead-capture fallback parser happily builds
  // yes@pm.me out of "yes at pm dot me" — a consent word can never be a glued
  // local part, from ANY parser. (A real yes@... owner spells it Y-E-S; the
  // typed box bypasses this via its raw-value fallback.)
  const local = candidate.split("@")[0];
  if (SPOKEN_EMAIL_NOISE_WORDS.has(local)) return null;
  return candidate;
}

