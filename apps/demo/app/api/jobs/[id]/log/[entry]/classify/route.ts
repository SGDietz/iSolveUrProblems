import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../../../../src/lib/rateLimit";
import { getUserId } from "../../../../../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../../../../../src/lib/supabaseAdmin";
import {
  getJobLogEntryById,
  signJobLogUrl,
} from "../../../../../../../src/lib/jobLogs";
import {
  classifyJobLogPhoto,
  insertCvLabel,
  getLatestCvLabelForEntry,
} from "../../../../../../../src/lib/vision";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/jobs/[id]/log/[entry]/classify (M4.6)
 *
 * Vision ¶27: "6 identifies which plants are weeds and which are
 * flowers ... over time, the Ai will learn and improve its accuracy."
 *
 * Triggered by the claimed contractor after uploading a photo (they
 * tap "identify this" on the log entry). Fetches the entry, signs the
 * storage URL, runs the OpenAI vision classifier, and persists the
 * prediction in cv_labels for the follow-up worker confirmation.
 *
 * Auth: signed-in user must be the claimed contractor for the
 * appointment attached to the log entry. Homeowners don't get to
 * trigger classification (they can see confirmed labels via RLS but
 * the tier gate + cost lives with the contractor).
 *
 * Tier gate: gold (billing/tiers.ts `cv_labeling`). classifyJobLogPhoto
 * handles the gate — a non-gold contractor gets 402 back.
 *
 * URL params:
 *   [id]    = appointment_id
 *   [entry] = job_log_entry_id
 *
 * Body (all optional):
 *   { prompt_hint?: string }
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function fetchClaimedContractorId(
  userId: string,
): Promise<string | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/users?id=eq.${encodeURIComponent(
      userId,
    )}&select=contractor_id&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ contractor_id: string | null }>;
  return rows[0]?.contractor_id ?? null;
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; entry: string }> },
) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  const userId = await getUserId();
  if (!userId) return bad("sign-in required", 401);

  const { id: appointmentId, entry: entryId } = await ctx.params;
  if (!UUID_RE.test(appointmentId)) return bad("invalid appointment id");
  if (!UUID_RE.test(entryId)) return bad("invalid entry id");

  const entry = await getJobLogEntryById(entryId);
  if (!entry || entry.appointment_id !== appointmentId) {
    return bad("log entry not found or not on this appointment", 404);
  }
  if (entry.kind !== "photo" || !entry.storage_path) {
    return bad("classify only applies to photo entries", 422);
  }

  const claimed = await fetchClaimedContractorId(userId);
  if (claimed !== entry.contractor_id) {
    return bad("only the claimed contractor may classify their photos", 403);
  }

  let body: { prompt_hint?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    /* empty body is OK */
  }
  const promptHint =
    typeof body.prompt_hint === "string"
      ? body.prompt_hint.trim().slice(0, 240)
      : null;

  // Dedupe: if there's a recent prediction for this entry (React
  // strict-mode double-render, double-tap, retry storm), return it
  // instead of spending another gpt-4o call. Fresh classify only on
  // rows older than DEDUPE_WINDOW_MS.
  const DEDUPE_WINDOW_MS = 30_000;
  const existing = await getLatestCvLabelForEntry(entry.id);
  if (
    existing &&
    Date.now() - new Date(existing.created_at).getTime() < DEDUPE_WINDOW_MS
  ) {
    return NextResponse.json({ row: existing, deduped: true });
  }

  const imageUrl = await signJobLogUrl(entry.storage_path);
  if (!imageUrl) return bad("couldn't sign storage URL", 500);

  const startedAt = Date.now();
  const result = await classifyJobLogPhoto({
    contractor_id: entry.contractor_id,
    image_url: imageUrl,
    prompt_hint: promptHint,
  });
  const latencyMs = Date.now() - startedAt;

  if (!result.ok) {
    if (result.reason === "tier_gate") {
      return NextResponse.json(
        {
          error:
            "cv_labeling is a gold-tier feature — upgrade the contractor subscription to enable it",
        },
        { status: 402 },
      );
    }
    return NextResponse.json(
      {
        error: `classification failed: ${result.reason}`,
        debug: result.debug ?? null,
      },
      { status: 502 },
    );
  }

  const row = await insertCvLabel({
    job_log_entry_id: entry.id,
    model: result.prediction.model,
    predicted_label: result.prediction.label,
    predicted_confidence: result.prediction.confidence,
    alternatives: result.prediction.alternatives,
    context: {
      latency_ms: latencyMs,
      prompt_hint: promptHint,
    },
  });
  if (!row) return bad("failed to persist cv label", 500);

  return NextResponse.json({ row });
}

/**
 * GET returns the latest prediction for the entry — used by the
 * worker-facing confirm chip to hydrate on page load without needing
 * to re-run classification. Same authz as POST.
 */
export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string; entry: string }> },
) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;

  const userId = await getUserId();
  if (!userId) return bad("sign-in required", 401);

  const { id: appointmentId, entry: entryId } = await ctx.params;
  if (!UUID_RE.test(appointmentId)) return bad("invalid appointment id");
  if (!UUID_RE.test(entryId)) return bad("invalid entry id");

  const entry = await getJobLogEntryById(entryId);
  if (!entry || entry.appointment_id !== appointmentId) {
    return bad("log entry not found or not on this appointment", 404);
  }
  const claimed = await fetchClaimedContractorId(userId);
  if (claimed !== entry.contractor_id) {
    return bad("only the claimed contractor may read their pending labels", 403);
  }

  const row = await getLatestCvLabelForEntry(entryId);
  return NextResponse.json({ row });
}
