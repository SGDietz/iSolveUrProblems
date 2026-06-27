import { assertAllowedOrigin } from "../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../src/lib/rateLimit";
import { getSupabaseServer } from "../../../../src/lib/auth/supabaseServer";

const ISOLVE_SUPABASE_REF = "dphxcqjkzhvsdejtxdcj";
const AIASAP_SUPABASE_REF = "wqszxsqzkaatghyrqviv";

/**
 * Current auth state + resume payload for the signed-in user (ported from aiASAP,
 * trimmed per Herm TASK_032 — identity + resume first; lists/prefs/visit-counts later).
 *
 * Anonymous → { authenticated: false }
 * Signed-in → { authenticated: true, user: {email, fullName}, lists, resumeState }
 *
 * MUST return fast: the page-load voice flow waits on this before 6 greets, so
 * every Supabase call is wrapped in a hard timeout that falls back to anonymous.
 */
export async function GET(request: Request) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  const TIMEOUT_MS = 2500;
  let userEmail: string | null = null;
  let userFullName: string | null = null;

  try {
    const authResult = await Promise.race([
      (async () => {
        const supabase = await getSupabaseServer();
        const { data, error } = await supabase.auth.getUser();
        return { data, error };
      })(),
      new Promise<{ data: null; error: { message: string } }>((resolve) =>
        setTimeout(() => resolve({ data: null, error: { message: "timeout" } }), TIMEOUT_MS),
      ),
    ]);

    if (authResult.data && !authResult.error) {
      const user = (authResult.data as {
        user?: { email?: string; user_metadata?: Record<string, unknown> };
      }).user;
      if (user?.email) {
        userEmail = user.email;
        const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
        userFullName =
          typeof meta.full_name === "string"
            ? meta.full_name
            : typeof meta.fullName === "string"
              ? (meta.fullName as string)
              : null;
      }
    }
  } catch (error) {
    console.error("/api/account/me auth check threw:", error);
  }

  if (!userEmail) {
    return new Response(JSON.stringify({ authenticated: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Resume payload: latest non-stale account_email_links row for this email.
  // Stale rows are skipped for resume (freshness), but the user is STILL signed
  // in — staleness never blocks auth (G's rule). Timeout-bounded.
  let lists: unknown[] = [];
  let resumeState: unknown = null;

  const supaUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const dbOk =
    !!supaUrl && supaUrl.includes(ISOLVE_SUPABASE_REF) && !supaUrl.includes(AIASAP_SUPABASE_REF);

  if (dbOk && serviceRoleKey) {
    try {
      const nowIso = new Date().toISOString();
      const url = `${supaUrl}/rest/v1/account_email_links?email=eq.${encodeURIComponent(userEmail)}&expires_at=gte.${encodeURIComponent(nowIso)}&order=created_at.desc&limit=1&select=captured_lists`;
      const fetchResult = await Promise.race([
        fetch(url, {
          method: "GET",
          headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
        }),
        new Promise<Response>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS),
        ),
      ]);
      if (fetchResult.ok) {
        const rows = (await fetchResult.json()) as Array<{ captured_lists: unknown }>;
        const captured = rows[0]?.captured_lists;
        if (captured && typeof captured === "object" && !Array.isArray(captured)) {
          const obj = captured as Record<string, unknown>;
          if (Array.isArray(obj.lists)) lists = obj.lists;
          if (obj.resumeState && typeof obj.resumeState === "object") resumeState = obj.resumeState;
          if (!userFullName && typeof obj.fullName === "string" && obj.fullName.trim()) {
            userFullName = obj.fullName.trim();
          }
        } else if (Array.isArray(captured)) {
          lists = captured;
        }
      }
    } catch (error) {
      console.error("/api/account/me resume fetch threw:", error);
    }
  }

  return new Response(
    JSON.stringify({
      authenticated: true,
      user: { email: userEmail, fullName: userFullName },
      lists,
      resumeState,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
