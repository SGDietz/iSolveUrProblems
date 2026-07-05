import { NextResponse, type NextRequest } from "next/server";
import { getUserId } from "../../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../../src/lib/supabaseAdmin";
import type { MemoryFactKind } from "../../../../src/lib/memory/types";
import { assertAllowedOrigin } from "../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../src/lib/rateLimit";

const MAX_RETURN = 200;

function isUuid(s: unknown): s is string {
  return (
    typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  );
}

/**
 * GET — list the current user's stored memory facts.
 *
 * Used by the "What 6 remembers" panel (GDPR right-to-view).
 * Returns the most-recent facts first.
 */
export async function GET() {
  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return NextResponse.json({ error: "supabase not configured" }, { status: 500 });
  }

  const res = await fetch(
    `${url}/rest/v1/user_memory_facts?user_id=eq.${encodeURIComponent(userId)}&select=id,kind,content,created_at&order=created_at.desc&limit=${MAX_RETURN}`,
    {
      method: "GET",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    },
  );
  if (!res.ok) {
    return NextResponse.json(
      { error: `list failed (${res.status})` },
      { status: 500 },
    );
  }
  const rows = (await res.json()) as Array<{
    id: string;
    kind: MemoryFactKind;
    content: string;
    created_at: string;
  }>;
  return NextResponse.json({ facts: rows });
}

/**
 * DELETE — forget a single fact (GDPR right-to-delete) or all facts
 * if no id is supplied.
 *
 * Query: ?id=<uuid>  → delete that one fact
 *        (no id)     → delete all of the user's facts
 */
export async function DELETE(request: NextRequest) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  const userId = await getUserId();
  if (!userId) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return NextResponse.json({ error: "supabase not configured" }, { status: 500 });
  }

  const id = request.nextUrl.searchParams.get("id");

  let query: string;
  if (id !== null) {
    if (!isUuid(id)) {
      return NextResponse.json({ error: "invalid id" }, { status: 400 });
    }
    // Both filters required so a user can't delete another user's fact
    // even if they knew the id.
    query = `id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}`;
  } else {
    query = `user_id=eq.${encodeURIComponent(userId)}`;
  }

  const res = await fetch(`${url}/rest/v1/user_memory_facts?${query}`, {
    method: "DELETE",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      Prefer: "return=representation",
    },
  });
  if (!res.ok) {
    return NextResponse.json(
      { error: `delete failed (${res.status})` },
      { status: 500 },
    );
  }
  const deleted = (await res.json()) as unknown[];
  return NextResponse.json({ ok: true, deleted: deleted.length });
}
