import { NextResponse, type NextRequest } from "next/server";
import { checkRateLimit } from "../../../../src/lib/rateLimit";
import { getUserId } from "../../../../src/lib/auth/getUser";
import { captureServerError } from "../../../../src/lib/observability/serverLogger";
import type { ClientLogPayload, LogLevel } from "../../../../src/lib/observability/types";
import { assertAllowedOrigin } from "../../../../src/lib/apiRouteSecurity";

const VALID_LEVELS: ReadonlySet<LogLevel> = new Set(["error", "warn", "info"]);
const MAX_MESSAGE = 4000;
const MAX_STACK = 16000;
const MAX_ROUTE = 1000;
const MAX_CONTEXT_BYTES = 16000;

function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

function clamp(s: unknown, max: number): string | undefined {
  if (typeof s !== "string") return undefined;
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Ingest endpoint for browser-side error reports. Validates the payload,
 * resolves the caller's user_id from cookies, and forwards to the
 * server-side logger which writes to public.error_logs via service role.
 */
export async function POST(request: NextRequest) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;

  // Rate-limit so a buggy client loop can't fill the table.
  const limitErr = await checkRateLimit(request);
  if (limitErr) return limitErr;

  let body: ClientLogPayload;
  try {
    body = (await request.json()) as ClientLogPayload;
  } catch {
    return jsonError(400, "invalid json");
  }

  if (!body || typeof body.message !== "string" || !body.message.trim()) {
    return jsonError(400, "message is required");
  }

  const level: LogLevel = VALID_LEVELS.has(body.level as LogLevel)
    ? (body.level as LogLevel)
    : "error";

  // Cap context size so a runaway object doesn't bloat the row.
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

  const userId = await getUserId();
  const userAgent = request.headers.get("user-agent") ?? null;

  await captureServerError({
    runtime: "client",
    level,
    user_id: userId,
    session_id: clamp(body.session_id, 200) ?? null,
    message: clamp(body.message, MAX_MESSAGE) ?? body.message.slice(0, MAX_MESSAGE),
    error: undefined, // already have the stack from the client
    route: clamp(body.route, MAX_ROUTE) ?? null,
    user_agent: userAgent,
    context: {
      ...(safeCtx ?? {}),
      ...(body.stack ? { client_stack: clamp(body.stack, MAX_STACK) } : {}),
    },
  });

  return NextResponse.json({ ok: true });
}
