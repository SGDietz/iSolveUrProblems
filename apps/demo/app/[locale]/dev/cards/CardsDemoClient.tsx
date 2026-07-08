"use client";

// MINT-FREE demo of the contractor-find cards whooshing onto 6's chest
// (G spec 2026-06-30). No avatar, no LiveAvatar session, no cost — safe to open
// and replay all day to tune the animation + whoosh sound before wiring onto 6.
// Route: /en/dev/cards  (also /es, /fr, …). Tap "Find plumbers" to play it.
//
// DEV-ONLY (Herm TASK_068/TASK_069): sample cards are hardcoded real Austin
// pros from a previous live Outscraper response. The server page 404s in
// production; this client keeps a second domain guard as belt-and-suspenders.

import { notFound } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

type Pro = {
  name: string;
  rating: number;
  reviews: number;
  phone: string;
  badges: string[];
};

type Phase = "idle" | "entering" | "settled" | "exiting";

// Sample = the real Austin plumbers the live Outscraper call returned, so the
// look is honest. In production these come from /api/contractors/find.
const SAMPLE: Pro[] = [
  { name: "Beyond Wow Plumbing & Drains", rating: 4.8, reviews: 2494, phone: "+1 512-601-6173", badges: ["Licensed", "Same-day"] },
  { name: "Reliant Plumbing", rating: 4.7, reviews: 2911, phone: "+1 512-222-6029", badges: ["Licensed", "Locally owned"] },
  { name: "Cascade Plumbing & Drain", rating: 4.7, reviews: 1564, phone: "+1 512-675-4220", badges: ["Same-day"] },
];

const ENTRY_ANIM = ["card-whoosh-right", "card-whoosh-left", "card-whoosh-bottom"];
const EXIT_ANIM = ["card-whoosh-exit-right", "card-whoosh-exit-left", "card-whoosh-exit-bottom"];
const STAGGER_MS = [0, 230, 470]; // boom — boom — boom
const EXIT_STAGGER_MS = [0, 110, 220];
const ENTRY_SETTLE_MS = 1120;
const EXIT_DONE_MS = 720;

// Synthesized whoosh: decaying noise swept through a lowpass that opens then
// closes. No audio file needed.
function playWhoosh(ctx: AudioContext) {
  const dur = 0.5;
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  const t = ctx.currentTime;
  filter.frequency.setValueAtTime(350, t);
  filter.frequency.exponentialRampToValueAtTime(4200, t + 0.16);
  filter.frequency.exponentialRampToValueAtTime(280, t + dur);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.5, t + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(filter);
  filter.connect(gain);
  gain.connect(ctx.destination);
  src.start();
}

export default function CardsDemoClient() {
  // Domain guard mirrors the server production guard. This catches accidental
  // exposure on the real domain even if env mirroring changes later.
  const onProdDomain =
    typeof window !== "undefined" &&
    /(^|\.)isolveurproblems\.ai$/i.test(window.location.hostname);
  if (process.env.NEXT_PUBLIC_VERCEL_ENV === "production" || onProdDomain) {
    notFound();
  }
  return <CardsDemoInner />;
}

function CardsDemoInner() {
  const [runKey, setRunKey] = useState(0);
  const [phase, setPhase] = useState<Phase>("idle");
  const ctxRef = useRef<AudioContext | null>(null);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  const ensureAudio = useCallback(() => {
    if (!ctxRef.current) {
      const AC = window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef.current = new AC();
    }
    void ctxRef.current.resume();
    return ctxRef.current;
  }, []);

  const scheduleWhooshes = useCallback((ctx: AudioContext, delays: number[]) => {
    delays.forEach((ms) => {
      timersRef.current.push(
        setTimeout(() => {
          if (ctxRef.current) playWhoosh(ctx);
        }, ms),
      );
    });
  }, []);

  const startEnter = useCallback(() => {
    const ctx = ensureAudio();
    setRunKey((k) => k + 1); // remount cards → restart CSS whoosh
    setPhase("entering");
    scheduleWhooshes(ctx, STAGGER_MS);
    timersRef.current.push(
      setTimeout(() => setPhase("settled"), ENTRY_SETTLE_MS),
    );
  }, [ensureAudio, scheduleWhooshes]);

  const play = useCallback(() => {
    const ctx = ensureAudio();
    clearTimers();
    if (phase === "entering" || phase === "settled") {
      setPhase("exiting");
      scheduleWhooshes(ctx, EXIT_STAGGER_MS);
      timersRef.current.push(setTimeout(startEnter, EXIT_DONE_MS));
      return;
    }
    startEnter();
  }, [clearTimers, ensureAudio, phase, scheduleWhooshes, startEnter]);

  const clear = useCallback(() => {
    if (phase === "idle") return;
    const ctx = ensureAudio();
    clearTimers();
    setPhase("exiting");
    scheduleWhooshes(ctx, EXIT_STAGGER_MS);
    timersRef.current.push(
      setTimeout(() => setPhase("idle"), EXIT_DONE_MS),
    );
  }, [clearTimers, ensureAudio, phase, scheduleWhooshes]);

  useEffect(() => clearTimers, [clearTimers]);

  const visible = phase !== "idle";
  const exiting = phase === "exiting";

  return (
    <div className="site-bg fixed inset-0 flex h-screen w-screen flex-col items-center justify-center overflow-hidden">
      {/* 6's chest backdrop so the cards land where they really will */}
      <div className="relative aspect-[9/16] h-[94vh] max-h-[80rem] max-w-[95vw] overflow-hidden rounded-[2.25rem] border border-[#d7a05a]/40 shadow-[0_0_0_1px_rgba(215,160,90,0.45),0_30px_90px_rgba(0,0,0,0.72)]">
        <img src="/startscreen.png" alt="6" className="absolute inset-0 h-full w-full object-cover object-top" />
        <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/55 to-transparent" />

        {/* Header line so it reads as a real find only after the find fires. */}
        {visible && (
          <div className="absolute inset-x-0 top-0 z-10 px-4 pt-10 text-center">
            <p className="brand-grad-text text-lg font-bold drop-shadow-[0_2px_14px_rgba(0,0,0,0.85)]">
              Here are 3 plumbers near you
            </p>
          </div>
        )}

        {/* Cards stacked on the chest */}
        {visible && (
          <div className="absolute left-1/2 top-[56%] z-10 flex w-[88%] max-w-[24rem] -translate-x-1/2 -translate-y-1/2 flex-col gap-3">
            {SAMPLE.map((pro, i) => (
              <div
                key={`${runKey}-${i}`}
                className="rounded-2xl border-2 border-[#e0aa62]/85 bg-gradient-to-b from-[#341d07]/95 to-[#130a03]/95 px-4 py-3 shadow-[inset_0_1px_10px_rgba(255,255,255,0.10),0_10px_28px_rgba(0,0,0,0.5)] backdrop-blur-[3px]"
                style={{
                  animation: exiting
                    ? `${EXIT_ANIM[i]} 0.5s cubic-bezier(0.7,0,0.84,0) both`
                    : `${ENTRY_ANIM[i]} 0.62s cubic-bezier(0.16,1,0.3,1) both`,
                  animationDelay: `${(exiting ? EXIT_STAGGER_MS : STAGGER_MS)[i]}ms`,
                  willChange: "transform, opacity, filter",
                }}
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="brand-grad-text text-[1.05rem] font-black leading-tight">{pro.name}</span>
                  <span className="shrink-0 text-sm font-bold text-[#ffd98a]">★ {pro.rating.toFixed(1)}</span>
                </div>
                <div className="mt-0.5 text-xs text-[#e8b96a]/80">{pro.reviews.toLocaleString()} reviews</div>
                <div className="mt-1 font-mono text-sm font-bold text-[#ffe9c2]">{pro.phone}</div>
                {pro.badges.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {pro.badges.map((b) => (
                      <span key={b} className="rounded-full border border-[#e0aa62]/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-[#e8b96a]">
                        {b}
                      </span>
                    ))}
                  </div>
                )}
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <button type="button" className="rounded-full border border-[#e0aa62]/70 bg-black/30 py-2 text-xs font-semibold text-[#e8b96a] active:brightness-90">
                    Check them out
                  </button>
                  <a href={`tel:${pro.phone}`} className="rounded-full bg-gradient-to-b from-[#ffe9c2] via-[#d7a05a] to-[#9e6a35] py-2 text-center text-xs font-bold text-[#2a1606] active:brightness-90">
                    {i === 0 ? "Call the top one" : "Call"}
                  </a>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Trigger */}
        <div className="absolute inset-x-0 bottom-6 z-20 flex flex-wrap justify-center gap-3 px-4">
          <button
            type="button"
            onClick={play}
            className="rounded-full border-2 border-[#e0aa62]/85 bg-gradient-to-b from-[#ffe9c2] via-[#d7a05a] to-[#9e6a35] px-8 py-3 text-base font-bold text-[#2a1606] shadow-[0_8px_26px_rgba(0,0,0,0.45)] active:brightness-90 disabled:opacity-70"
            disabled={phase === "exiting"}
          >
            {visible ? "↻ Replay the whoosh" : "▶ Find plumbers"}
          </button>
          {visible && (
            <button
              type="button"
              onClick={clear}
              className="rounded-full border-2 border-[#e0aa62]/70 bg-black/45 px-6 py-3 text-base font-bold text-[#e8b96a] shadow-[0_8px_26px_rgba(0,0,0,0.35)] active:brightness-90 disabled:opacity-70"
              disabled={phase === "exiting"}
            >
              Clear cards
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
