// Spoken-command parsers ported from aiASAP (read-only source):
//   - remove-by-position(s)  <- src/lib/voiceMode/intents.ts (G dogfood
//     2026-06-13/14: "take off number one" must drop position 1, never hunt
//     for an item named "Number one"; "remove both 1 and 2" must not hunt
//     for "Both 1")
//   - clear-all              <- src/lib/listClear.ts (G said "clear the list"
//     ~26 times and nothing cleared; 6 still said "done")
//   - list-name extraction   — new for iSolve's named lists ("...to my house
//     list", "...on the Henderson job list")

/** Map a spoken 1-10 word OR digit to its number. */
const ORDINAL_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
};
function wordToNumber(raw: string): number {
  const v = raw.trim().toLowerCase();
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  return ORDINAL_WORDS[v] ?? 0;
}

/** REMOVE-BY-POSITION. Returns the 1-based position, or null when the turn is
 * not a positional remove. Covers: "take/remove/delete/cross/scratch (off/out)
 * (the) number|item|# N", "take (the) N off/out", and ordinal-word forms
 * ("take off the first one", "cross off the third item"). */
export function parseRemoveByPosition(text: string): number | null {
  const t = String(text);
  const m1 = t.match(
    /\b(?:take|remove|delete|cross|scratch)\s+(?:off\s+|out\s+)?(?:the\s+)?(?:number|item|#)\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i,
  );
  if (m1) {
    const n = wordToNumber(m1[1]);
    return n >= 1 ? n : null;
  }
  // Requires a trailing one|item|thing so a real item that merely starts with
  // an ordinal isn't swallowed.
  const m2 = t.match(
    /\b(?:take|remove|delete|cross|scratch)\s+(?:off\s+|out\s+)?(?:the\s+)?(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+)\s+(?:one|item|thing)\b/i,
  );
  if (m2) {
    const n = wordToNumber(m2[1]);
    return n >= 1 ? n : null;
  }
  const m3 = t.match(
    /\btake\s+(?:the\s+)?(?:number|item)?\s*(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(?:off|out)\b/i,
  );
  if (m3) {
    const n = wordToNumber(m3[1]);
    return n >= 1 ? n : null;
  }
  return null;
}

/** MULTI-position remove ("remove both 1 and 2", "take off numbers 1, 2 and 3").
 * Returns 1-based positions, or [] when it is not a multi-position remove. */
export function parseRemovePositions(text: string): number[] {
  const t = String(text);
  const m = t.match(
    /\b(?:take|remove|delete|cross|scratch)\s+(?:off\s+|out\s+)?(?:both\s+|the\s+)?(?:numbers?\s+|items?\s+|#\s*)?((?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)(?:\s*(?:,|and|&|\+)\s*(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten))+)\b/i,
  );
  if (!m) return [];
  const nums = m[1]
    .split(/\s*(?:,|and|&|\+)\s*/i)
    .map((w) => wordToNumber(w))
    .filter((n) => n >= 1);
  return [...new Set(nums)];
}

// "everything bagel(s)" is a real grocery item — never let it trip a clear.
const EVERYTHING_BAGEL_RE = /\beverything\s+bagels?\b/i;
const CLEAR_LIST_RE =
  /\b(?:clear|empty|wipe|reset|erase|nuke|scrap)\b(?:\s+\w+){0,4}?\s+(?:the\s+)?(?:(?:whole\s+)?list|whole\s+thing|everything|all\s+(?:items?|of\s+(?:it|them))|it\s+all|every\s+item)\b/i;
const REMOVE_EVERYTHING_RE =
  /\b(?:remove|delete|get rid of|take|drop|clear|wipe|erase|nuke|scrap)\b(?:\s+\w+){0,4}?\s+(?:everything|all\s+(?:items?|of\s+(?:it|them))|it\s+all|every\s+item|whole\s+(?:list|thing))\b/i;
const START_OVER_RE =
  /\b(?:start|begin)\b(?:\s+\w+){0,4}?\s+(?:list\s+over|over\s+with\s+(?:this|the|my)?\s*list)\b/i;

/** True when the user wants the WHOLE list emptied in one go. */
export function isClearAllCommand(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if (EVERYTHING_BAGEL_RE.test(t)) return false;
  return (
    CLEAR_LIST_RE.test(t) ||
    REMOVE_EVERYTHING_RE.test(t) ||
    START_OVER_RE.test(t)
  );
}

/**
 * Extract a NAMED list target from a spoken phrase: "…to my house list",
 * "…on the Henderson job list", "…off my shopping list". Returns the name
 * ("house", "Henderson job", "shopping") or null for the bare "my list" /
 * "the list" forms (caller falls back to the default To-Do list).
 */
export function extractListName(text: string): string | null {
  const m = text.match(
    /\b(?:my|the|our)\s+((?:[a-z0-9'][a-z0-9'-]*\s+){1,3}?)(?:to[- ]?do\s+)?list\b/i,
  );
  if (!m) return null;
  const name = m[1]
    .trim()
    .replace(/^(?:own|new|whole|entire)\s+/i, "")
    .trim();
  // Bare "to do" / "to-do" is the DEFAULT list, not a named one.
  if (!name || /^to[- ]?do$/i.test(name)) return null;
  // A real list NAME never contains command verbs / prepositions — those are
  // spillover from phrases like "take the milk off the list" (which greedily
  // captured "milk off the" and would have CREATED a list named that).
  if (
    /\b(?:off|from|on|onto|to|into|add|put|take|remove|delete|clear|check|cross|mark|out)\b/i.test(
      name,
    )
  ) {
    return null;
  }
  return name;
}
