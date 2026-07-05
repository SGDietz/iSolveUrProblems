import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../../src/lib/rateLimit";
import { getSupabaseAdminConfig } from "../../../../../src/lib/supabaseAdmin";
import {
  getContractorSummary,
  getContractorWithReviews,
  isSummaryStale,
  summarizeReviews,
  upsertContractorSummary,
} from "../../../../../src/lib/contractors";
import type { SummarizeFailureReason } from "../../../../../src/lib/contractors/summarize";

/**
 * Map each internal failure reason to a SHORT, user-facing message
 * (rendered in the inline panel) and a stable HTTP status code. The
 * raw diagnostic ('debug' field) is set separately and surfaces in
 * the JSON response body for DevTools inspection.
 */
const FAILURE_COPY: Record<
  SummarizeFailureReason,
  { status: number; userMessage: string }
> = {
  openai_not_configured: {
    status: 503,
    userMessage: "6's summarizer is offline right now. Try again later.",
  },
  too_few_reviews: {
    status: 422,
    userMessage:
      "Not enough reviews yet — 6 needs at least 3 with text to summarize.",
  },
  llm_http_error: {
    status: 502,
    userMessage: "6 couldn't reach the summarizer. Try again in a moment.",
  },
  llm_fetch_threw: {
    status: 502,
    userMessage: "6 couldn't reach the summarizer. Try again in a moment.",
  },
  llm_parse_failed: {
    status: 502,
    userMessage: "6's summarizer returned something odd. Try again.",
  },
  llm_empty_summary: {
    status: 502,
    userMessage: "6 couldn't produce a useful summary. Try again.",
  },
};

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/contractors/[id]/summary
 *
 * Lazy-generated review synthesis (M2.3 — Vision ¶11).
 *
 *   - Returns the cached summary if present and fresh.
 *   - If missing or stale (>30d or ≥5 new reviews), regenerates from
 *     the contractor's review corpus and caches the result.
 *   - Returns 404 if the contractor isn't in our DB.
 *   - Returns 422 if there isn't enough review signal to summarize.
 *
 * No auth required — summaries are derived from public review text and
 * are safe to surface to anonymous browsers (origin + rate-limit gate
 * the route).
 */

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s,
  );
}

// Live Outscraper cards fall back to their provider place_id as the card id
// when the DB-UUID rehydration misses the persist window (liveFind's 2.5s
// bound). Same shape rule as apiRouteSecurity's session ids: bounded, no
// control chars, URL-safe punctuation only.
const SAFE_SOURCE_ID = /^[a-zA-Z0-9_\-:.]{4,200}$/;

/** Resolve a non-UUID (place_id) card id to the persisted row's DB UUID —
 * mirrors the orchestrator's fetchContractorById fallback (Herm ship-blocker
 * 2026-07-02: this route hard-rejected non-UUIDs, so summary could fail on
 * the persistence-timeout path). Null = no persisted row (or no DB). */
async function resolveSourceIdToUuid(sourceId: string): Promise<string | null> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const qs = new URLSearchParams();
    qs.set("select", "id");
    qs.set("source", "eq.outscraper_live");
    qs.set("source_id", `eq.${sourceId}`);
    qs.set("limit", "1");
    const res = await fetch(`${url}/rest/v1/contractors?${qs.toString()}`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ id: string }>;
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  let { id } = await context.params;
  if (!isUuid(id)) {
    if (!SAFE_SOURCE_ID.test(id)) {
      return NextResponse.json(
        {
          error: "That contractor link doesn't look right.",
          debug: `received id did not match UUID or source-id shape`,
        },
        { status: 400 },
      );
    }
    const resolved = await resolveSourceIdToUuid(id);
    if (!resolved) {
      return NextResponse.json(
        {
          error: "We couldn't find that contractor.",
          debug: `no persisted contractor row for source_id card id`,
        },
        { status: 404 },
      );
    }
    id = resolved;
  }

  let existing;
  try {
    existing = await getContractorSummary(id);
  } catch (e) {
    return NextResponse.json(
      {
        error: "Something went wrong on our end. Try again in a moment.",
        debug: `getContractorSummary threw: ${e instanceof Error ? e.message : "unknown"}`,
      },
      { status: 500 },
    );
  }

  let data;
  try {
    data = await getContractorWithReviews(id);
  } catch (e) {
    return NextResponse.json(
      {
        error: "Something went wrong on our end. Try again in a moment.",
        debug: `getContractorWithReviews threw: ${e instanceof Error ? e.message : "unknown"}`,
      },
      { status: 500 },
    );
  }
  if (!data) {
    return NextResponse.json(
      {
        error: "We couldn't find that contractor.",
        debug: `no contractor row for id '${id}'`,
      },
      { status: 404 },
    );
  }

  const stale = isSummaryStale({
    existing,
    currentReviewCount: data.reviews.length,
  });

  if (existing && !stale) {
    return NextResponse.json({
      cached: true,
      summary: existing,
    });
  }

  const fresh = await summarizeReviews({
    contractorName: data.contractor.name,
    reviews: data.reviews,
  });

  if (!fresh.ok) {
    // Stale cache is better than nothing — serve it if we have one.
    if (existing) {
      return NextResponse.json({ cached: true, summary: existing });
    }
    const copy = FAILURE_COPY[fresh.reason];
    return NextResponse.json(
      {
        error: copy.userMessage,
        reason: fresh.reason,
        debug: fresh.debug,
        // Helpful counts so inspection can confirm DB shape at a glance.
        review_count_total: data.reviews.length,
        review_count_with_body: data.reviews.filter(
          (r) => typeof r.body === "string" && r.body.trim().length > 0,
        ).length,
      },
      { status: copy.status },
    );
  }

  try {
    await upsertContractorSummary({
      contractorId: id,
      summary: fresh.summary,
    });
  } catch (e) {
    return NextResponse.json(
      {
        error: "Couldn't save the summary just now. Try again in a moment.",
        debug: `upsertContractorSummary threw: ${e instanceof Error ? e.message : "unknown"}`,
      },
      { status: 500 },
    );
  }

  return NextResponse.json({
    cached: false,
    summary: {
      ...fresh.summary,
      contractor_id: id,
      generated_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });
}
