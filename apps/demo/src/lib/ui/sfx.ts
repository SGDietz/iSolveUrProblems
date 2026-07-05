"use client";

/**
 * Synthesized UI sound effects — no audio files. Ported from the dev cards
 * page (app/[locale]/dev/cards/page.tsx) into a shared helper so the REAL
 * ContractorsPanel gets the whoosh (G spec via Herm 2026-07-01).
 *
 * Browser-safe: AudioContext is created lazily, resumed if suspended, and
 * every path fails SOFT — if autoplay policy blocks audio (no user gesture
 * yet), we simply stay silent. Sound must never break the app.
 */

type WindowWithWebkitAC = Window & {
  webkitAudioContext?: typeof AudioContext;
};

let sharedCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  try {
    if (typeof window === "undefined") return null;
    const AC =
      window.AudioContext ?? (window as WindowWithWebkitAC).webkitAudioContext;
    if (!AC) return null;
    if (!sharedCtx) sharedCtx = new AC();
    if (sharedCtx.state === "suspended") {
      // Fire-and-forget — if the gesture policy blocks it, this whoosh is
      // skipped and a later one (after the user interacts) will play.
      void sharedCtx.resume().catch(() => {});
    }
    return sharedCtx.state === "running" ? sharedCtx : null;
  } catch {
    return null;
  }
}

/**
 * Decaying noise swept through a lowpass that opens then closes — a short
 * "whoosh". `variant` nudges the sweep so entries and exits sound related
 * but not identical; gain is capped so staggered cards never get loud.
 */
export function playWhoosh(variant: "in" | "out" = "in"): void {
  try {
    const ctx = getCtx();
    if (!ctx) return;
    const dur = 0.5;
    const buffer = ctx.createBuffer(
      1,
      Math.floor(ctx.sampleRate * dur),
      ctx.sampleRate,
    );
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    }
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    const t = ctx.currentTime;
    if (variant === "in") {
      filter.frequency.setValueAtTime(350, t);
      filter.frequency.exponentialRampToValueAtTime(4200, t + 0.16);
      filter.frequency.exponentialRampToValueAtTime(280, t + dur);
    } else {
      // Exit sweeps DOWN — starts open, closes away.
      filter.frequency.setValueAtTime(3800, t);
      filter.frequency.exponentialRampToValueAtTime(240, t + dur);
    }
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35, t + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start();
  } catch {
    /* sound must never break the app */
  }
}
