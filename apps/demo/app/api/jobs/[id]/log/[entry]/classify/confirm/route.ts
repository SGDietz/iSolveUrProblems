import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../../../../../src/lib/rateLimit";
import { getUserId } from "../../../../../../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../../../../../../src/lib/supabaseAdmin";
import { getJobLogEntryById } from "../../../../../../../../src/lib/jobLogs";
import {
  confirmCvLabel,
  getCvLabelById,
} from "../../../../../../../../src/lib/vision";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/jobs/[id]/log/[entry]/classify/confirm (M4.6)
 *
 * Worker taps "yes / correct" or "no / actually {X}" on the sticky
 * confirm chip. Writes the confirmation into cv_labels so the
 * confirmed-label anchor set grows.
 *
 * Vision ¶27 says accuracy improves over time — that improvement
 * loop starts here: each worker correction feeds a future v2
 * fine-tune. v1 doesn't consume the anchor set for anything.
 *
 * Body:
 *   {
 *     cv_label_id: uuid,
 *     correct: boolean,
 *     corrected_label?: string   // required when correct=false
 *   }
 *
 * Auth: only the claimed contractor for the log entry can confirm.
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

  let body: {
    cv_label_id?: unknown;
    correct?: unknown;
    corrected_label?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return bad("invalid JSON");
  }
  if (
    typeof body.cv_label_id !== "string" ||
    !UUID_RE.test(body.cv_label_id)
  ) {
    return bad("cv_label_id is required (uuid)");
  }
  if (typeof body.correct !== "boolean") {
    return bad("correct is required (boolean)");
  }
  const correctedLabel =
    typeof body.corrected_label === "string"
      ? body.corrected_label.trim().slice(0, 60)
      : null;
  if (!body.correct && !correctedLabel) {
    return bad(
      "when correct=false, corrected_label is required so the anchor set stays clean",
    );
  }

  // Fetch the row so we can (a) authz check via the underlying entry
  // and (b) look up the predicted_label to copy through on correct=true.
  const label = await getCvLabelById(body.cv_label_id);
  if (!label) return bad("cv label not found", 404);

  const entry = await getJobLogEntryById(label.job_log_entry_id);
  if (!entry || entry.appointment_id !== appointmentId || entry.id !== entryId) {
    return bad("cv label doesn't belong to this entry", 404);
  }
  const claimed = await fetchClaimedContractorId(userId);
  if (claimed !== entry.contractor_id) {
    return bad("only the claimed contractor may confirm", 403);
  }

  const row = await confirmCvLabel({
    id: body.cv_label_id,
    user_id: userId,
    correct: body.correct,
    corrected_label: correctedLabel,
    predicted_label: label.predicted_label,
  });
  if (!row) return bad("failed to persist confirmation", 500);

  return NextResponse.json({ row });
}
