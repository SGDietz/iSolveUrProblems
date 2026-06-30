import { NextResponse, type NextRequest } from "next/server";
import {
  assertAllowedOrigin,
  isAllowedImageMime,
} from "../../../../../src/lib/apiRouteSecurity";
import { getUserId } from "../../../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../../../src/lib/supabaseAdmin";
import { getActiveTierForContractor } from "../../../../../src/lib/billing/store";
import { tierUnlocks } from "../../../../../src/lib/billing/tiers";
import {
  buildJobLogStoragePath,
  extForMime,
  insertJobLog,
  listJobLogsWithUrls,
  uploadJobLogObject,
  MAX_JOB_LOG_BYTES,
  type JobLogKind,
  type JobLogPhase,
} from "../../../../../src/lib/jobLogs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * /api/jobs/[id]/log (M4.5)
 *
 * id = appointment_id.
 *
 * GET: list job-log entries for the appointment (homeowner OR claimed
 * contractor). Returns rows enriched with short-lived signed URLs.
 *
 * POST: multipart form upload. Claimed contractor only. Fields:
 *   file      File   (photo/video; required for kind=photo|video)
 *   kind      string photo|video|note
 *   phase?    string arrival|in_progress|completion
 *   caption?  string up to 500 chars
 *   gps_lat?  number
 *   gps_lng?  number
 *   gps_acc?  number (metres)
 *
 * Tier gate: bronze+ (photo_log). Free returns 402.
 */

const VIDEO_MIMES = new Set([
  "video/webm",
  "video/mp4",
  "video/quicktime",
  "video/ogg",
]);

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

type AuthzCtx = {
  appointment_id: string;
  contractor_id: string;
  is_contractor: boolean;
  is_homeowner: boolean;
};

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

async function authorize(
  appointment_id: string,
  user_id: string,
): Promise<AuthzCtx | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  // Pull the appointment row and check both ownership channels.
  const res = await fetch(
    `${url}/rest/v1/appointments?id=eq.${encodeURIComponent(
      appointment_id,
    )}&select=id,user_id,contractor_id&limit=1`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{
    id: string;
    user_id: string;
    contractor_id: string | null;
  }>;
  const appt = rows[0];
  if (!appt || !appt.contractor_id) return null;

  const isHomeowner = appt.user_id === user_id;
  let isContractor = false;
  if (!isHomeowner) {
    const claimed = await fetchClaimedContractorId(user_id);
    isContractor = claimed === appt.contractor_id;
  }
  if (!isHomeowner && !isContractor) return null;
  return {
    appointment_id: appt.id,
    contractor_id: appt.contractor_id,
    is_contractor: isContractor,
    is_homeowner: isHomeowner,
  };
}

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const userId = await getUserId();
  if (!userId) return bad("sign-in required", 401);
  const { id } = await ctx.params;
  const authz = await authorize(id, userId);
  if (!authz) return bad("forbidden", 403);
  const entries = await listJobLogsWithUrls({ appointment_id: id });
  return NextResponse.json({ entries });
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const userId = await getUserId();
  if (!userId) return bad("sign-in required", 401);
  const { id } = await ctx.params;
  const authz = await authorize(id, userId);
  if (!authz) return bad("forbidden", 403);
  // Only the contractor can write logs.
  if (!authz.is_contractor) {
    return bad("only the contractor for this job can upload logs", 403);
  }

  // Tier gate.
  const tier = await getActiveTierForContractor(authz.contractor_id);
  if (!tierUnlocks(tier, "photo_log")) {
    return NextResponse.json(
      { error: "tier_gate", required_tier: "bronze" },
      { status: 402 },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return bad("invalid form data");
  }

  const kindRaw = String(form.get("kind") ?? "").trim();
  if (kindRaw !== "photo" && kindRaw !== "video" && kindRaw !== "note") {
    return bad("kind must be photo|video|note");
  }
  const kind = kindRaw as JobLogKind;

  const phaseRaw = String(form.get("phase") ?? "").trim();
  const phase: JobLogPhase | null =
    phaseRaw === "arrival" ||
    phaseRaw === "in_progress" ||
    phaseRaw === "completion"
      ? (phaseRaw as JobLogPhase)
      : null;

  const captionRaw = String(form.get("caption") ?? "").trim();
  const caption = captionRaw ? captionRaw.slice(0, 500) : null;

  const gpsLatRaw = form.get("gps_lat");
  const gpsLngRaw = form.get("gps_lng");
  const gpsAccRaw = form.get("gps_acc");
  const gps_lat = typeof gpsLatRaw === "string" ? parseFloat(gpsLatRaw) : NaN;
  const gps_lng = typeof gpsLngRaw === "string" ? parseFloat(gpsLngRaw) : NaN;
  const gps_acc = typeof gpsAccRaw === "string" ? parseFloat(gpsAccRaw) : NaN;
  const lat = Number.isFinite(gps_lat) && gps_lat >= -90 && gps_lat <= 90 ? gps_lat : null;
  const lng = Number.isFinite(gps_lng) && gps_lng >= -180 && gps_lng <= 180 ? gps_lng : null;
  const acc = Number.isFinite(gps_acc) && gps_acc >= 0 ? gps_acc : null;

  if (kind === "note") {
    if (!caption) return bad("caption is required for note entries");
    const row = await insertJobLog({
      appointment_id: id,
      contractor_id: authz.contractor_id,
      user_id: userId,
      kind,
      phase,
      storage_path: null,
      mime_type: null,
      size_bytes: null,
      gps_lat: lat,
      gps_lng: lng,
      gps_accuracy_m: acc,
      caption,
    });
    if (!row) return bad("insert failed", 500);
    return NextResponse.json({ row });
  }

  // Media path.
  const fileOrBlob = form.get("file");
  if (!fileOrBlob) return bad("file is required");
  const value = fileOrBlob as unknown;
  const file: File | null =
    fileOrBlob instanceof File
      ? fileOrBlob
      : value instanceof Blob
        ? new File([value], "media.bin", { type: value.type })
        : null;
  if (!file) return bad("file is required");
  if (file.size === 0) return bad("file is empty");
  if (file.size > MAX_JOB_LOG_BYTES) return bad("file too large");

  const mime = (file.type || "application/octet-stream").split(";")[0].trim();
  const isImage = isAllowedImageMime(mime);
  const isVideo = VIDEO_MIMES.has(mime);
  if (kind === "photo" && !isImage) return bad("photo requires image mime");
  if (kind === "video" && !isVideo) return bad("video requires video mime");

  const storage_path = buildJobLogStoragePath({
    appointment_id: id,
    kind,
    ext: extForMime(mime),
  });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const uploaded = await uploadJobLogObject({
    storage_path,
    mime,
    bytes,
  });
  if (!uploaded) return bad("upload failed", 502);

  const row = await insertJobLog({
    appointment_id: id,
    contractor_id: authz.contractor_id,
    user_id: userId,
    kind,
    phase,
    storage_path,
    mime_type: mime,
    size_bytes: file.size,
    gps_lat: lat,
    gps_lng: lng,
    gps_accuracy_m: acc,
    caption,
  });
  if (!row) {
    return NextResponse.json(
      {
        ok: false,
        storage_path,
        warning: "uploaded but insert failed",
      },
      { status: 202 },
    );
  }
  return NextResponse.json({ row });
}
