// Ported from aiASAP src/lib/listItemSanity.ts (G 2026-06-14, recurring rage:
// "why do non-list things keep coming up on the lists"): ONE tested sanity
// gate at the add chokepoint. A real list item is a short, noun-ish thing
// (milk, wax ring, 3/8 supply line, paint rollers) — never a name, a pronoun,
// a meta/command word, an app term, a number+time fragment, or a sentence.
// Belt-and-suspenders final filter; the intent gate still runs first.

// Standalone junk words (exact, whole-string match, lowercased): fillers,
// agent names, bare command verbs, app terms.
const EXACT_JUNK = new Set([
  // agent / people names that kept leaking
  "herm", "claude", "six", "6", "buddy", "buddies", "pal", "perm", "adam",
  // bare pronouns / possessives (Herm TASK_081: "my" moved here from the
  // contains-regex so "mow my grass" survives as a real chore)
  "me", "my", "our",
  // acknowledgments / fillers
  "wow", "great", "okay", "ok", "yeah", "yes", "no", "nope", "sure", "well",
  "hmm", "again", "more", "look", "same", "vision", "obsession", "caught",
  "going", "gave", "stuff", "thing", "things", "here",
  // bare command verbs
  "put", "add", "list", "get", "grab", "buy", "throw", "need", "want", "have",
  "had", "move", "change", "changes",
  // app / mechanic terms + stray fragments
  "zip", "results", "through", "then", "also", "problem", "problems", "silent",
  "two", "people", "second", "seconds", "minute", "minutes",
  // iSolve-specific terms that must never become items
  "contractor", "contractors", "plumber", "appointment", "appointments",
  "camera", "video", "gallery",
]);

// Sentence / meta markers — if an "item" contains these it's talk, not a thing
// you put on a list. (Whole-word matches so "herbal"/"cheese" stay safe.)
const META_CONTAINS_RE =
  /\b(?:i|i'?m|you|your|we|they|them|he|she|him|her|me|gonna|wanna|figure|investigate|that'?s|to be|when i|full ?page|search ?results?|zip ?code|second list|another list|new list|people get|up people|been silent|up and running|talking|reality|issue|changes here|appointments?|meetings?|bookings?|visits?|contractors?|plumbers?|electricians?|handym(?:a|e)n|roofers?|painters?|landscapers?|estimates?|contracts?|disputes?|calls?)\b/i;

// True when `item` reads like a real thing someone would put on a list.
export function isPlausibleListItem(item: string): boolean {
  const t = (item ?? "").trim();
  if (t.length < 2 || t.length > 40) return false;
  if (t.split(/\s+/).length > 4) return false; // real items are short
  if (EXACT_JUNK.has(t.toLowerCase())) return false;
  if (META_CONTAINS_RE.test(t)) return false;
  // leading connective / preposition (an interrupted scrap, not an item)
  if (
    /^(?:and|or|but|so|to|for|up|down|over|under|with|without|of|at|in|on|except|page|number|item)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  // bare number, or number + time unit ("2", "2 second", "3rd")
  if (/^\d+$/.test(t)) return false;
  if (/^\d+\s*(?:st|nd|rd|th|secs?|seconds?|mins?|minutes?|hours?)\b/i.test(t)) {
    return false;
  }
  // profanity / question words = chatter, never an item
  if (
    /\b(?:fuck|fucking|fucked|shit|goddamn|damn|hell|what|why|how|where|when|who|which)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  return true;
}

/**
 * Split a spoken items tail into clean item candidates — the aiASAP
 * parseOfferedAddItems split logic (listAddOffer.ts): Oxford-comma aware
 * ("bread, butter, and jam" → 3 items, never "and jam"), strips spoken
 * articles, drops bare pronouns, caps at 5 per utterance.
 */
export function splitSpokenItems(tail: string): string[] {
  return tail
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
    .map((s) =>
      s
        .replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "")
        .replace(/^(?:and|or)\s+/i, "")
        .replace(/^(?:a|an|the|some|of)\s+/i, "")
        .trim(),
    )
    .filter((s) => !/^(?:it|them|that|those|these|this)$/i.test(s))
    .filter(isPlausibleListItem)
    .slice(0, 5);
}

/**
 * PENDING-ANSWER splitter (Herm TASK_094 blocker #2): when 6 just asked
 * "what should I put on it?", the reply IS items — including trade nouns
 * ("a painter, a plumber, and a roofer") the strict gate rejects as
 * contractor chatter everywhere else. Runs ONLY on the one turn after the
 * ask (ctx.pendingListAdd). Still drops pronouns/fillers/app words, strips
 * spoken "I need(ed)" prefixes, caps at 5.
 */
export function splitSpokenPendingListItems(tail: string): string[] {
  return tail
    .split(/\s*,\s*(?:and\s+)?|\s+and\s+/i)
    .map((s) =>
      s
        .replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, "")
        .replace(/^(?:and|or|so|well|um|uh|okay|ok)\s+/i, "")
        .replace(/^(?:i\s+(?:need(?:ed)?|want(?:ed)?|have|had)\s+)/i, "")
        .replace(/^(?:a|an|the|some|of)\s+/i, "")
        .replace(/[.!?]+$/g, "")
        .trim(),
    )
    .filter((s) => s.length >= 2 && s.length <= 40)
    .filter((s) => s.split(/\s+/).length <= 4)
    .filter(
      (s) =>
        !/^(?:it|them|that|those|these|this|you|yes|yeah|no|nope|okay|ok|sure|please|thanks?)$/i.test(
          s,
        ),
    )
    .filter((s) => !/\b(?:zip|search|camera|video|gallery|screen|list|lists)\b/i.test(s))
    .slice(0, 5);
}
