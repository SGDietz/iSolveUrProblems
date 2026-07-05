import { NextResponse, type NextRequest } from "next/server";
import { getUserId } from "../../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../../src/lib/supabaseAdmin";
import { assertAllowedOrigin } from "../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../src/lib/rateLimit";

/**
 * Re-key anonymous rows to the authenticated user.
 *
 * Called from AuthProvider on the first SIGNED_IN transition. The browser
 * has been stashing every avatar session_id in localStorage; we send the
 * recent ones here and update all session-keyed tables in one pass.
 *
 * Idempotent: rows already owned by another user are left alone.
 */
const LINKABLE_TABLES = [
  "transcript_events",
  "conversation_messages",
  "media_events",
  "lead_sessions",
  "contact_entities",
] as const;

const MAX_IDS = 50;

function isSafeSessionId(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && s.length <= 200 && /^[A-Za-z0-9_\-:.]+$/.test(s);
}

export async function POST(request: NextRequest) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const rawIds = (body as { session_ids?: unknown })?.session_ids;
  if (!Array.isArray(rawIds)) {
    return NextResponse.json(
      { error: "session_ids must be an array" },
      { status: 400 },
    );
  }
  const ids = rawIds.filter(isSafeSessionId).slice(0, MAX_IDS);
  if (ids.length === 0) {
    return NextResponse.json({ ok: true, linked: 0, tables: {} });
  }

  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return NextResponse.json({ error: "supabase not configured" }, { status: 500 });
  }

  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  } as const;

  // Build a PostgREST `in.(...)` filter once.
  const inFilter = `in.(${ids.map((id) => `"${id.replace(/"/g, '""')}"`).join(",")})`;

  const perTable: Record<string, number | string> = {};
  let total = 0;

  for (const table of LINKABLE_TABLES) {
    try {
      // Only re-key rows that are currently un-owned. Rows already linked
      // to another user are left alone (safety).
      const res = await fetch(
        `${url}/rest/v1/${table}?session_id=${inFilter}&user_id=is.null`,
        {
          method: "PATCH",
          headers,
          body: JSON.stringify({ user_id: userId }),
        },
      );
      if (!res.ok) {
        // 404 here usually means the table doesn't exist yet. Skip silently.
        if (res.status === 404) {
          perTable[table] = "skip:404";
          continue;
        }
        perTable[table] = `error:${res.status}`;
        continue;
      }
      const rows = (await res.json()) as unknown[];
      perTable[table] = rows.length;
      total += rows.length;
    } catch (e) {
      console.error(`link-session: ${table} failed`, e);
      perTable[table] = "error:throw";
    }
  }

  return NextResponse.json({ ok: true, linked: total, tables: perTable });
}
