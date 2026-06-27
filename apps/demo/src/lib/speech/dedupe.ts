// STT double-fire dedupe (2026-06-11). The speech pipeline regularly delivers
// the SAME utterance twice within a second or two ("Perfect." ... "Perfect.").
// Every duplicate used to dispatch twice — that's how one "make it bigger"
// stepped sizes twice (G: "the pillboxes keep getting smaller even though I'm
// not wanting them to"), and how a duplicated "Perfect." first confirmed the
// email was correct and then, one beat later, satisfied the just-armed SEND
// gate — mailing the sign-in link before consent was ever asked (G 2026-06-11:
// "You sent it without me giving you permission"). One normalized-identical
// utterance inside the window is an echo, never the user repeating themselves.

/** Lowercase, strip punctuation and whitespace — STT echoes differ only there. */
export function normalizeUtterance(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export const STT_ECHO_WINDOW_MS = 2500;

/**
 * True when `text` is an STT echo of the previous utterance: normalized-
 * identical and within the window. An intentional human repeat ("bigger" ...
 * pause ... "bigger") lands well outside 2.5 seconds.
 */
export function isDuplicateUtterance(
  prevText: string | null,
  prevAtMs: number,
  text: string,
  nowMs: number,
  windowMs: number = STT_ECHO_WINDOW_MS,
): boolean {
  if (!prevText) return false;
  if (nowMs - prevAtMs > windowMs) return false;
  const norm = normalizeUtterance(text);
  if (!norm) return false;
  return norm === normalizeUtterance(prevText);
}
