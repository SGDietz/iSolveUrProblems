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

export type PillFlightSoundFlavor =
  | "bubble"
  | "sparkle"
  | "boop"
  | "whoop"
  | "zing"
  | "plop"
  | "twinkle"
  | "waka"
  | "coin"
  | "boing"
  | "slide"
  | "pew"
  | "boom";

export function playChime(intensity: "soft" | "pop" = "pop"): void {
  try {
    const ctx = getCtx();
    if (!ctx) return;
    const t = ctx.currentTime;
    const base = 720 + Math.random() * 110;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(
      intensity === "pop" ? 0.12 : 0.07,
      t + 0.018,
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    gain.connect(ctx.destination);

    [0, 1].forEach((step) => {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      const at = t + step * 0.045;
      osc.frequency.setValueAtTime(base * (step ? 1.5 : 1), at);
      osc.detune.setValueAtTime((Math.random() - 0.5) * 18, at);
      osc.connect(gain);
      osc.start(at);
      osc.stop(t + 0.22 + step * 0.045);
    });
  } catch {
    /* sound must never break the app */
  }
}

/**
 * Happy, TikTok-ish UI motion sounds without copyrighted samples: airy whoosh,
 * bubble pop, pentatonic sparkle/boop/whoop. These are generic synthesized
 * transition cues, not ripped online audio files.
 */
/**
 * ARCADE/VIRAL character cues (G 2026-07-07 late: "pac man sounds-ish...
 * what other viral sounds do people love"). All ORIGINAL synthesized
 * patterns in the CHARACTER of the classics — 8-bit square waves, springs,
 * slide whistles, lasers, a soft boom — never ripped or cloned melodies.
 */
function playArcadeCue(
  ctx: AudioContext,
  phase: "enter" | "exit",
  flavor: "waka" | "coin" | "boing" | "slide" | "pew" | "boom",
): void {
  const t = ctx.currentTime;
  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, t);
  master.gain.exponentialRampToValueAtTime(flavor === "boom" ? 0.14 : 0.1, t + 0.015);
  master.connect(ctx.destination);

  // hold=true keeps the gain at peak until ~70% of the cue then decays —
  // multi-note flavors (waka's chomps, coin's held fifth) were fading to
  // near-silence mid-phrase under a whole-cue decay (review 2026-07-07).
  const endAt = (d: number, hold = false) => {
    if (hold) {
      master.gain.setValueAtTime(flavor === "boom" ? 0.14 : 0.1, t + d * 0.7);
    }
    master.gain.exponentialRampToValueAtTime(0.0001, t + d);
  };

  if (flavor === "waka") {
    // 8-bit chomp: alternating two-tone square, four quick steps.
    const tones = phase === "enter" ? [659, 494, 659, 494] : [494, 659, 494, 659];
    tones.forEach((hz, i) => {
      const osc = ctx.createOscillator();
      osc.type = "square";
      const at = t + i * 0.062;
      osc.frequency.setValueAtTime(hz, at);
      osc.frequency.exponentialRampToValueAtTime(hz * (i % 2 ? 1.25 : 0.8), at + 0.055);
      osc.connect(master);
      osc.start(at);
      osc.stop(at + 0.058);
    });
    endAt(0.32, true);
  } else if (flavor === "coin") {
    // Arcade coin: short square blip then a held rising fifth.
    [[988, 0, 0.06], [1480, 0.06, 0.24]].forEach(([hz, off, d]) => {
      const osc = ctx.createOscillator();
      osc.type = "square";
      osc.frequency.setValueAtTime(hz, t + off);
      osc.connect(master);
      osc.start(t + off);
      osc.stop(t + off + d);
    });
    endAt(0.34, true);
  } else if (flavor === "boing") {
    // Spring: sine dropping fast with a wobble LFO on pitch.
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(phase === "enter" ? 340 : 300, t);
    osc.frequency.exponentialRampToValueAtTime(110, t + 0.4);
    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.setValueAtTime(22, t);
    lfoGain.gain.setValueAtTime(38, t);
    lfoGain.gain.exponentialRampToValueAtTime(4, t + 0.4);
    lfo.connect(lfoGain);
    lfoGain.connect(osc.frequency);
    osc.connect(master);
    lfo.start(t);
    osc.start(t);
    osc.stop(t + 0.42);
    lfo.stop(t + 0.42);
    endAt(0.42);
  } else if (flavor === "slide") {
    // Slide whistle: long triangle portamento — up on enter, down on exit.
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    if (phase === "enter") {
      osc.frequency.setValueAtTime(380, t);
      osc.frequency.exponentialRampToValueAtTime(1450, t + 0.42);
    } else {
      osc.frequency.setValueAtTime(1350, t);
      osc.frequency.exponentialRampToValueAtTime(260, t + 0.42);
    }
    osc.connect(master);
    osc.start(t);
    osc.stop(t + 0.44);
    endAt(0.44);
  } else if (flavor === "pew") {
    // Laser: sawtooth screaming down, gone in a blink.
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(1900, t);
    osc.frequency.exponentialRampToValueAtTime(190, t + 0.15);
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(3200, t);
    osc.connect(filter);
    filter.connect(master);
    osc.start(t);
    osc.stop(t + 0.16);
    endAt(0.18);
  } else {
    // boom: soft deep thump (the meme-boom, at polite volume) + click.
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.34);
    osc.connect(master);
    osc.start(t);
    osc.stop(t + 0.36);
    const click = ctx.createOscillator();
    click.type = "square";
    click.frequency.setValueAtTime(900, t);
    const clickGain = ctx.createGain();
    clickGain.gain.setValueAtTime(0.04, t);
    clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
    click.connect(clickGain);
    clickGain.connect(ctx.destination);
    click.start(t);
    click.stop(t + 0.03);
    endAt(0.38);
  }
}

export function playPillFlightSound(
  phase: "enter" | "exit",
  flavor: PillFlightSoundFlavor = "sparkle",
): void {
  try {
    const ctx = getCtx();
    if (!ctx) return;
    if (
      flavor === "waka" ||
      flavor === "coin" ||
      flavor === "boing" ||
      flavor === "slide" ||
      flavor === "pew" ||
      flavor === "boom"
    ) {
      playArcadeCue(ctx, phase, flavor);
      return;
    }
    const t = ctx.currentTime;
    const dur = phase === "enter" ? 0.44 : 0.34;

    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, t);
    master.gain.exponentialRampToValueAtTime(phase === "enter" ? 0.105 : 0.085, t + 0.018);
    master.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    master.connect(ctx.destination);

    // Soft filtered noise sweep = the standard web/app "thing flew" cue.
    const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) * 0.42;
    }
    const noise = ctx.createBufferSource();
    noise.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    if (phase === "enter") {
      filter.frequency.setValueAtTime(420, t);
      filter.frequency.exponentialRampToValueAtTime(3600 + Math.random() * 900, t + dur * 0.58);
      filter.frequency.exponentialRampToValueAtTime(820, t + dur);
    } else {
      filter.frequency.setValueAtTime(3200 + Math.random() * 800, t);
      filter.frequency.exponentialRampToValueAtTime(360, t + dur);
    }
    filter.Q.setValueAtTime(0.7, t);
    noise.connect(filter);
    filter.connect(master);
    noise.start(t);
    noise.stop(t + dur);

    // Sound audition set (G live-ride 19:58: "let me hear different sounds,
    // I'll let you know whether I like them or not") — zing = quick laser
    // rise, plop = low bubbly drop, twinkle = fast high fairy-arpeggio.
    const root =
      flavor === "whoop" ? 392
      : flavor === "boop" ? 523.25
      : flavor === "zing" ? 660
      : flavor === "plop" ? 220
      : flavor === "twinkle" ? 880
      : 587.33;
    const intervals =
      flavor === "twinkle"
        ? [0, 4, 9, 16]
        : flavor === "zing" || flavor === "plop"
          ? [0]
          : phase === "enter"
            ? [0, 7, 12]
            : [12, 7, 0];
    intervals.forEach((semi, step) => {
      const osc = ctx.createOscillator();
      osc.type =
        flavor === "bubble" || flavor === "plop"
          ? "sine"
          : flavor === "zing"
            ? "sawtooth"
            : "triangle";
      const at =
        t +
        step *
          (flavor === "sparkle" ? 0.055 : flavor === "twinkle" ? 0.04 : 0.07);
      const hz = root * Math.pow(2, semi / 12);
      osc.frequency.setValueAtTime(hz, at);
      if (flavor === "whoop") {
        osc.frequency.exponentialRampToValueAtTime(hz * (phase === "enter" ? 1.22 : 0.82), at + 0.12);
      } else if (flavor === "zing") {
        osc.frequency.exponentialRampToValueAtTime(hz * (phase === "enter" ? 1.9 : 0.55), at + 0.14);
      } else if (flavor === "plop") {
        osc.frequency.exponentialRampToValueAtTime(hz * 0.6, at + 0.11);
      }
      osc.detune.setValueAtTime((Math.random() - 0.5) * 16, at);
      osc.connect(master);
      osc.start(at);
      osc.stop(at + (flavor === "twinkle" ? 0.12 : 0.16));
    });
  } catch {
    /* sound must never break the app */
  }
}
