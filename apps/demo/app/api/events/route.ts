import { NextResponse, type NextRequest } from "next/server";
import { checkRateLimit } from "../../../src/lib/rateLimit";
import { getUserId } from "../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../src/lib/supabaseAdmin";
import { captureServerError } from "../../../src/lib/observability/serverLogger";
import {
  assertAllowedOrigin,
  isSafeTranscriptionSessionId,
} from "../../../src/lib/apiRouteSecurity";

/**
 * First-party product-event ingest (writes public.app_events via service
 * role). Event names are allowlisted server-side so the public endpoint
 * can't be used to spray arbitrary rows. Fire-and-forget from the client —
 * see src/lib/observability/clientEvents.ts.
 */
const ALLOWED_EVENTS = new Set([
  "call_consent_open",
  "call_consent_yes",
  "call_consent_dismiss",
  "contractor_website_tap",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Same shape family as the orchestrator's SAFE_SOURCE_ID (place_id etc.).
const SAFE_SOURCE_ID = /^[A-Za-z0-9_\-:.]{1,200}$/;
const MAX_CONTEXT_BYTES = 8000;

type EventPayload = {
  event?: unknown;
  session_id?: unknown;
  contractor_id?: unknown;
  context?: unknown;
};

function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

export async function POST(request: NextRequest) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;

  const limitErr = await checkRateLimit(request);
  if (limitErr) return limitErr;

  let body: EventPayload;
  try {
    body = (await request.json()) as EventPayload;
  } catch {
    return jsonError(400, "invalid json");
  }

  if (typeof body?.event !== "string" || !ALLOWED_EVENTS.has(body.event)) {
    return jsonError(400, "unknown event");
  }

  // Persisted rows send a uuid -> contractor_id; live Outscraper cards that
  // missed the persist window send a place_id -> source_id (TASK_065 lesson).
  let contractorId: string | null = null;
  let sourceId: string | null = null;
  if (typeof body.contractor_id === "string") {
    const ref = body.contractor_id.trim();
    if (UUID_RE.test(ref)) contractorId = ref;
    else if (ref && SAFE_SOURCE_ID.test(ref)) sourceId = ref;
  }

  let safeCtx: Record<string, unknown> | undefined;
  if (body.context && typeof body.context === "object") {
    try {
      const json = JSON.stringify(body.context);
      safeCtx =
        json.length > MAX_CONTEXT_BYTES
          ? { _truncated: true, _bytes: json.length }
          : (body.context as Record<string, unknown>);
    } catch {
      safeCtx = { _unserializable: true };
    }
  }

  const row = {
    event: body.event,
    user_id: await getUserId(),
    session_id: isSafeTranscriptionSessionId(body.session_id)
      ? (body.session_id as string)
      : null,
    contractor_id: contractorId,
    source_id: sourceId,
    env: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development",
    release:
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.VERCEL_DEPLOYMENT_ID ??
      null,
    user_agent: request.headers.get("user-agent"),
    context: safeCtx ?? {},
  };

  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return jsonError(503, "events store not configured");
  }

  try {
    const res = await fetch(`${url}/rest/v1/app_events`, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      await captureServerError({
        message: `app_events insert failed (${res.status})`,
        route: "/api/events",
        context: { event: body.event },
      });
      return jsonError(500, "event not stored");
    }
  } catch (e) {
    await captureServerError({
      message: "app_events insert threw",
      error: e,
      route: "/api/events",
    });
    return jsonError(500, "event not stored");
  }

  return NextResponse.json({ ok: true });
}
