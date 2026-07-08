import { useCallback } from "react";
import { useLiveAvatarContext } from "./context";

// Ported from aiASAP (G 2026-06-13 HARD RULE: 6 must NEVER say the same line
// twice; resurfaced on the 2026-07-07 13:09 iSolve ride — "you already said
// that"): one output chokepoint that drops a line identical — or nearly
// identical, since re-reads often differ by a trailing clause — to the one
// just spoken. Module-scoped, not per-hook: there is one 6 per page and
// every spoken line funnels through repeat() below. Short lines ("Got it!")
// are exempt — only substantial lines (12+ chars) can be duplicates.
const DUPLICATE_SPEECH_WINDOW_MS = 8_000;
const lastSpokenLine = { text: "", at: 0 };

function normalizeSpokenLine(text: string): string {
  return (text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isNearDuplicateLine(prev: string, next: string): boolean {
  if (!prev || !next) return false;
  if (prev === next) return true;
  const shorter = prev.length <= next.length ? prev : next;
  const longer = prev.length > next.length ? prev : next;
  return (
    shorter.length >= 40 &&
    longer.startsWith(shorter.slice(0, Math.floor(shorter.length * 0.9)))
  );
}

function isDuplicateSpokenLine(text: string): boolean {
  const norm = normalizeSpokenLine(text);
  if (!norm) return true;
  const now = Date.now();
  if (
    norm.length >= 12 &&
    now - lastSpokenLine.at < DUPLICATE_SPEECH_WINDOW_MS &&
    isNearDuplicateLine(lastSpokenLine.text, norm)
  ) {
    return true;
  }
  lastSpokenLine.text = norm;
  lastSpokenLine.at = now;
  return false;
}

export const useAvatarActions = (mode: "FULL" | "CUSTOM") => {
  const { sessionRef } = useLiveAvatarContext();

  const interrupt = useCallback(() => {
    return sessionRef.current.interrupt();
  }, [sessionRef]);

  const repeat = useCallback(
    async (message: string) => {
      if (isDuplicateSpokenLine(message)) return;
      if (mode === "FULL") {
        return sessionRef.current.repeat(message);
      } else if (mode === "CUSTOM") {
        const res = await fetch("/api/elevenlabs-text-to-speech", {
          method: "POST",
          body: JSON.stringify({ text: message }),
        });
        const { audio } = await res.json();
        return sessionRef.current.repeatAudio(audio);
      }
    },
    [sessionRef, mode],
  );

  const startListening = useCallback(() => {
    return sessionRef.current.startListening();
  }, [sessionRef]);

  const stopListening = useCallback(() => {
    return sessionRef.current.stopListening();
  }, [sessionRef]);

  return {
    interrupt,
    repeat,
    startListening,
    stopListening,
  };
};
