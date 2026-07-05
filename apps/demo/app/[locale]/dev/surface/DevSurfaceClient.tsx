"use client";

import { notFound } from "next/navigation";
import { useAssistantSurface } from "../../../../src/lib/assistantSurface";

const mockHits = [
  {
    id: "00000000-0000-0000-0000-000000000001",
    name: "Acme Plumbing",
    rating_avg: 4.8,
    rating_count: 312,
    distance_km: 2.1,
    price_tier: 2,
    locally_owned: true,
    same_day_flag: true,
    licensed_flag: true,
    phone: "+15551234567",
    website: "https://example.com/acme",
  },
  {
    id: "00000000-0000-0000-0000-000000000002",
    name: "Sunrise Drainworks",
    rating_avg: 4.7,
    rating_count: 185,
    distance_km: 3.4,
    price_tier: 2,
    locally_owned: false,
    same_day_flag: true,
    licensed_flag: true,
    phone: "+15557654321",
    website: null,
  },
  {
    id: "00000000-0000-0000-0000-000000000003",
    name: "Heritage Pipe Co",
    rating_avg: 4.6,
    rating_count: 96,
    distance_km: 5.0,
    price_tier: 3,
    locally_owned: true,
    same_day_flag: false,
    licensed_flag: true,
    phone: "+15559998888",
    website: "https://example.com/heritage",
  },
];

const mockSummary = {
  contractor_id: "00000000-0000-0000-0000-000000000001",
  contractor_name: "Acme Plumbing",
  summary:
    "Reviewers consistently praise quick response and fair pricing. A few mention scheduling delays during busy weeks.",
  strengths_md:
    "- On-time arrivals\n- Honest quotes — no hidden fees\n- Clean job sites",
  weaknesses_md:
    "- Occasional 1–2 day scheduling delay\n- Limited weekend availability",
  sample_quotes: [
    {
      quote: "Showed up exactly when promised. Five stars.",
      rating: 5,
    },
    {
      quote: "Fair price, no upsell, did it right the first time.",
      rating: 5,
    },
    {
      quote: "Took a couple extra days but the work was solid.",
      rating: 4,
    },
  ],
};

const mockPicks = mockHits.slice(0, 3).map((h, i) => ({
  ...h,
  reason:
    [
      "Top rating and they're the closest to you — easy call.",
      "Same-day capable and almost as well-reviewed as the top pick.",
      "Locally owned and licensed — fits your stated preference.",
    ][i] ?? "Strong overall match.",
}));

const mockPickResult = {
  winner: {
    contractor_id: mockHits[0].id,
    name: mockHits[0].name,
    channel: "sms",
    delivered: true,
  },
  losers: mockHits.slice(1).map((h) => ({
    contractor_id: h.id,
    name: h.name,
    channel: "email",
    delivered: false,
    error: "no_recipient",
  })),
  total_sent: 1,
  total_failed: 2,
};

const mockTodo = {
  list_id: "dev-chest-list",
  list_title: "House list",
  transient: true,
  persistence_note: "Not saved in dev sandbox.",
  changed: { added: ["painter", "plumber", "roofer"] },
  items: [
    { id: "dev-1", title: "painter", position: 1 },
    { id: "dev-2", title: "plumber", position: 2 },
    { id: "dev-3", title: "roofer", position: 3 },
  ],
};

export default function DevSurfaceClient() {
  // DEV-ONLY (G 2026-07-02: no fake data anywhere real users can see) —
  // canned sample payloads must never render on a production deployment.
  // Same belt-and-suspenders lock as dev/cards.
  const onProdDomain =
    typeof window !== "undefined" &&
    /(^|\.)isolveurproblems\.ai$/i.test(window.location.hostname);
  if (process.env.NEXT_PUBLIC_VERCEL_ENV === "production" || onProdDomain) {
    notFound();
  }
  return <DevSurfaceInner />;
}

function DevSurfaceInner() {
  const showContractors = useAssistantSurface((s) => s.showContractors);
  const showSummary = useAssistantSurface((s) => s.showSummary);
  const showRecommendations = useAssistantSurface((s) => s.showRecommendations);
  const showPickResult = useAssistantSurface((s) => s.showPickResult);
  const showTodo = useAssistantSurface((s) => s.showTodo);
  const dismiss = useAssistantSurface((s) => s.dismiss);
  const reset = useAssistantSurface((s) => s.reset);

  return (
    <main className="w-full max-w-2xl flex flex-col gap-6 px-6 py-12">
      <header className="flex flex-col gap-2">
        <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">
          M3.0b · Dev Sandbox
        </p>
        <h1 className="text-2xl font-semibold">Assistant Surface variants</h1>
        <p className="text-sm text-zinc-400">
          Each button pushes a canned payload into the surface store. The
          drawer mounts at the locale layout and persists across navigation
          to other routes — try opening one variant, then navigating to
          /contractors or the home page to confirm it stays.
        </p>
      </header>

      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => showContractors(mockHits, 12)}
          className="rounded-md bg-amber-400 text-zinc-900 px-4 py-2 text-sm font-medium hover:bg-amber-300"
        >
          1. Show contractors panel (3 mock plumbers)
        </button>
        <button
          type="button"
          onClick={() => showSummary(mockSummary, false)}
          className="rounded-md bg-amber-400 text-zinc-900 px-4 py-2 text-sm font-medium hover:bg-amber-300"
        >
          2. Show summary panel (Acme review synthesis, &quot;Fresh&quot;)
        </button>
        <button
          type="button"
          onClick={() => showSummary(mockSummary, true)}
          className="rounded-md bg-amber-400/70 text-zinc-900 px-4 py-2 text-sm font-medium hover:bg-amber-300/70"
        >
          2b. Show summary panel (&quot;Cached&quot; variant)
        </button>
        <button
          type="button"
          onClick={() =>
            showRecommendations(mockPicks, [
              "prefers locally-owned",
              "quality over price",
            ])
          }
          className="rounded-md bg-amber-400 text-zinc-900 px-4 py-2 text-sm font-medium hover:bg-amber-300"
        >
          3. Show 6&apos;s picks (3 ranked with reasons)
        </button>
        <button
          type="button"
          onClick={() => showPickResult(mockPickResult)}
          className="rounded-md bg-amber-400 text-zinc-900 px-4 py-2 text-sm font-medium hover:bg-amber-300"
        >
          4. Show pick result (1 win, 2 lose with vendor failures)
        </button>
        <button
          type="button"
          onClick={() => showTodo(mockTodo)}
          className="rounded-md bg-amber-400 text-zinc-900 px-4 py-2 text-sm font-medium hover:bg-amber-300"
        >
          5. Show todo chest box (bottom half of 6)
        </button>

        <div className="flex gap-3 pt-2">
          <button
            type="button"
            onClick={dismiss}
            className="rounded-md bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
          >
            Dismiss (keeps variant)
          </button>
          <button
            type="button"
            onClick={reset}
            className="rounded-md bg-zinc-800 px-4 py-2 text-sm text-zinc-200 hover:bg-zinc-700"
          >
            Reset (clears variant)
          </button>
        </div>
      </div>

      <p className="text-xs text-zinc-500 mt-4 border-t border-zinc-800 pt-3">
        Also available in DevTools console:{" "}
        <code className="font-mono">window.__assistantSurface</code>
      </p>
    </main>
  );
}
