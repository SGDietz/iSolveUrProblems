// Ported from aiASAP src/lib/listAddOffer.ts (ITEM 4, 2026-06-14). Pure
// string logic for the add-OFFER slot: when 6 OFFERS to add an item ("Want me
// to add milk?") the client arms a pending slot from his spoken line; the
// next bare "yes" resolves it into a real add BEFORE the brain sees the yes.
//
// NOT yet wired into LiveAvatarSession — that touches the speak-gate G froze
// on 2026-07-01; wire it as its own reviewed change. The helpers are here so
// the wiring is a small diff when it lands.

import { isPlausibleListItem } from "./itemSanity";

// 6's spoken line is an add-OFFER ("want me to add X", "shall I put X on").
export const ADD_OFFER_RE =
  /\b(?:want me to|do you want me to|shall i|should i|i can|i could|want (?:me )?to)\s+(?:add|put|throw|toss|drop|stick)\b/i;

// Whole-utterance affirmative ONLY (a long sentence that merely contains
// "yeah" must not fire). Repeatable so "Yeah, do it" matches while a sentence
// that veers off ("yeah but take milk off") cannot.
export const ADD_OFFER_AFFIRM_RE =
  /^[\s,.!'-]*(?:(?:well|um|uh|so|okay then|alright|all right|yes|yeah|yea|yep|yup|sure|ok|okay|please|do it|go ahead|go for it|add (?:it|them|that)|put (?:it|them|that) on|sounds good|why not|let'?s do it|absolutely|definitely)[\s,.!'-]*)+$/i;

// A bare filler ("so", "um") must NOT count as a yes (aiASAP: Supabase caught
// "so" -> item added). Require at least one REAL affirmative token.
export const ADD_OFFER_REAL_AFFIRM_RE =
  /\b(?:yes|yeah|yea|yep|yup|sure|ok|okay|alright|all right|please|do it|go ahead|go for it|add (?:it|them|that)|put (?:it|them|that) on|sounds good|why not|let'?s do it|absolutely|definitely)\b/i;

// Any clear negative clears the slot.
export const ADD_OFFER_NEGATE_RE =
  /\b(?:no|nope|nah|not now|don'?t|do not|never mind|nevermind|cancel|wait|hold on|stop|leave it|skip it)\b/i;

export function isAddOfferAffirmative(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (ADD_OFFER_NEGATE_RE.test(t)) return false;
  return ADD_OFFER_AFFIRM_RE.test(t) && ADD_OFFER_REAL_AFFIRM_RE.test(t);
}

/** Pull the offered item(s) from 6's offer line. Cuts at the question mark /
 * end and at trailing "to your list" / "to it" / "for you" / "too", splits on
 * commas + "and", strips spoken articles, sanity-filters, caps at 5. */
export function parseOfferedAddItems(spoken: string): string[] {
  const m = spoken.match(ADD_OFFER_RE);
  if (!m || m.index === undefined) return [];
  let tail = spoken.slice(m.index + m[0].length);
  tail = tail.split(/[?!.]/)[0] ?? tail;
  tail = tail.replace(
    /\s+(?:to|on)\s+(?:the|your|my|this|that)?\s*(?:grocery|shopping|house|job|to[-\s]?do)?\s*list\b.*$/i,
    "",
  );
  tail = tail.replace(/\s+(?:to it|for you|as well|too|then|now)\b.*$/i, "");
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
    .filter((s) => s.length >= 2 && s.length <= 40)
    .slice(0, 5);
}
