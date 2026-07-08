import { NextResponse, type NextRequest } from "next/server";
import { checkRateLimit } from "../../../../src/lib/rateLimit";
import { getUserId } from "../../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../../src/lib/supabaseAdmin";
import { captureServerError } from "../../../../src/lib/observability/serverLogger";
import {
  assertAllowedOrigin,
  isSafeTranscriptionSessionId,
} from "../../../../src/lib/apiRouteSecurity";

export const dynamic = "force-dynamic";

/**
 * POST /api/media/save (G order 2026-07-02 night: "start saving all pics
 * and vids as standard. While testing, we will mostly delete them").
 *
 * Hands the client a one-shot SIGNED upload URL into the PRIVATE
 * session-media bucket and writes the media_assets ledger row. The media
 * itself never transits this route (signed PUT goes straight to Storage)
 * and never becomes public. Fire-and-forget from the client — a failed
 * save must never break the capture/analyze flow.
 */

const KINDS = new Set(["photo", "video"]);
const MAX_BYTES = 50 * 1024 * 1024; // matches the bucket file_size_limit
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/webm": "webm",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

export async function POST(request: NextRequest) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const limitErr = await checkRateLimit(request);
  if (limitErr) return limitErr;

  let body: {
    kind?: unknown;
    mime?: unknown;
    bytes?: unknown;
    session_id?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (typeof body.kind !== "string" || !KINDS.has(body.kind)) {
    return NextResponse.json({ error: "bad kind" }, { status: 400 });
  }
  const mime =
    typeof body.mime === "string" ? body.mime.split(";")[0].trim() : "";
  const ext = EXT_BY_MIME[mime] ?? (body.kind === "video" ? "webm" : "jpg");
  const bytes =
    typeof body.bytes === "number" && Number.isFinite(body.bytes)
      ? Math.floor(body.bytes)
      : null;
  if (bytes !== null && (bytes <= 0 || bytes > MAX_BYTES)) {
    return NextResponse.json({ error: "bad size" }, { status: 400 });
  }
  const sessionId = isSafeTranscriptionSessionId(body.session_id)
    ? (body.session_id as string)
    : null;

  const day = new Date().toISOString().slice(0, 10);
  const path = `${day}/${sessionId ?? "anon"}/${crypto.randomUUID()}.${ext}`;

  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return NextResponse.json({ error: "storage not configured" }, { status: 503 });
  }

  try {
    // One-shot signed upload URL into the private bucket.
    const signRes = await fetch(
      `${url}/storage/v1/object/upload/sign/session-media/${path}`,
      {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      },
    );
    if (!signRes.ok) {
      await captureServerError({
        message: `media sign failed (${signRes.status})`,
        route: "/api/media/save",
      });
      return NextResponse.json({ error: "sign failed" }, { status: 500 });
    }
    const signed = (await signRes.json()) as { url?: string };
    if (!signed.url) {
      return NextResponse.json({ error: "sign failed" }, { status: 500 });
    }

    // Ledger row BEFORE handing the signed URL to the browser (Herm
    // TASK_098 C): a serverless early-return must not orphan private
    // objects with no media_assets row. If the ledger write fails, fail
    // this best-effort save closed; the client swallows the 500 so capture
    // + analysis continue, but no browser ever receives an upload URL for
    // an untracked object.
    const ledgerRes = await fetch(`${url}/rest/v1/media_assets`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        session_id: sessionId,
        // Direct user handle for deterministic test-wipe cleanup (Herm
        // TASK_096); null for anonymous sessions.
        user_id: await getUserId().catch(() => null),
        kind: body.kind,
        storage_path: path,
        mime: mime || null,
        bytes,
        env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
      }),
    }).catch(() => null);
    if (!ledgerRes || !ledgerRes.ok) {
      await captureServerError({
        message: `media ledger insert failed (${ledgerRes ? ledgerRes.status : "network"})`,
        route: "/api/media/save",
      });
      return NextResponse.json({ error: "ledger failed" }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      upload_url: `${url}/storage/v1${signed.url}`,
      path,
    });
  } catch (e) {
    await captureServerError({
      message: "media save threw",
      error: e,
      route: "/api/media/save",
    });
    return NextResponse.json({ error: "save failed" }, { status: 500 });
  }
}
