import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "../../../../src/lib/auth/getUser";
import { generateReport } from "../../../../src/lib/reports";
import { defaultLocale, locales, type Locale } from "../../../../src/i18n/routing";
import { getSupabaseAdminConfig } from "../../../../src/lib/supabaseAdmin";
import { assertAllowedOrigin } from "../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../src/lib/rateLimit";

export const dynamic = "force-dynamic";
// Compose + render can take 15-30s on a chunky session. Bump function
// timeout for Vercel; default is 10s on Hobby, 60s on Pro.
export const maxDuration = 60;

function isSafeSessionId(s: unknown): s is string {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    s.length <= 200 &&
    /^[A-Za-z0-9_\-:.]+$/.test(s)
  );
}

async function getUserFirstName(userId: string): Promise<string | null> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const res = await fetch(
      `${url}/rest/v1/users?id=eq.${encodeURIComponent(userId)}&select=full_name&limit=1`,
      {
        method: "GET",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ full_name: string | null }>;
    const full = rows[0]?.full_name ?? null;
    if (!full) return null;
    return full.split(/\s+/)[0] ?? full;
  } catch {
    return null;
  }
}

/**
 * POST /api/reports/generate
 *
 * Body: { session_id: string, locale?: Locale }
 *
 * Requires auth (per Q1.1b — report delivery is gated on sign-in).
 * Runs the full compose → render → upload pipeline synchronously and
 * returns the final status when done.
 */
export async function POST(request: NextRequest) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  let body: { session_id?: unknown; locale?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  if (!isSafeSessionId(body.session_id)) {
    return NextResponse.json(
      { error: "session_id required" },
      { status: 400 },
    );
  }

  const localeCandidate =
    typeof body.locale === "string" ? (body.locale as Locale) : null;
  const locale: Locale =
    localeCandidate && (locales as readonly string[]).includes(localeCandidate)
      ? localeCandidate
      : defaultLocale;

  const firstName = await getUserFirstName(user.id);

  const result = await generateReport({
    userId: user.id,
    sessionId: body.session_id,
    locale,
    userFirstName: firstName,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, id: result.rowId, status: result.status, error: result.error },
      { status: 500 },
    );
  }
  return NextResponse.json({
    ok: true,
    id: result.rowId,
    status: "ready",
  });
}
