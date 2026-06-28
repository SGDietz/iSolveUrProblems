import {
  assertAllowedOrigin,
  isSafeTranscriptionSessionId,
} from "../../../../src/lib/apiRouteSecurity";

const NO_STORE = { "Content-Type": "application/json", "Cache-Control": "no-store" };

const ISOLVE_SUPABASE_REF = "dphxcqjkzhvsdejtxdcj";
const AIASAP_SUPABASE_REF = "wqszxsqzkaatghyrqviv";

/**
 * Cross-browser device-link poll (2026-06-27).
 *
 * The voice magic link signs in whatever browser OPENS it — usually the user's
 * phone, NOT the browser running 6 (Comet). So the live 6 session never sees the
 * sign-in cookie and can't greet the returning user by name.
 *
 * Fix: /auth/callback stamps account_email_links.used_at only on the exact row
 * carrying the clicked magic-link token (server-side, no cookie needed here). The
 * live 6 session POLLS this endpoint by its OWN session_id; the moment its row
 * flips to used, it pulls the name + resume
 * SERVER-SIDE and 6 greets them. Same gap aiASAP has.
 *
 * Read-only, service-role, keyed by an unguessable LiveAvatar session id. No rate
 * limit on purpose — the client polls this every few seconds and a 429 would lose
 * the sign-in event; the session-id gate + origin check are the protection.
 * Returns { signedIn:false } until the link is clicked.
 */
export async function GET(request: Request) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;

  const url = new URL(request.url);
  const sessionId = (url.searchParams.get("sessionId") || "").trim();

  const notSignedIn = () =>
    new Response(JSON.stringify({ signedIn: false }), {
      status: 200,
      headers: NO_STORE,
    });

  // Strict: LiveAvatar session ids pass this (same gate as transcription routes).
  if (!isSafeTranscriptionSessionId(sessionId)) return notSignedIn();

  const supaUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const dbOk =
    !!supaUrl && supaUrl.includes(ISOLVE_SUPABASE_REF) && !supaUrl.includes(AIASAP_SUPABASE_REF);
  if (!dbOk || !serviceRoleKey) return notSignedIn();

  try {
    const q = `${supaUrl}/rest/v1/account_email_links?session_id=eq.${encodeURIComponent(
      sessionId,
    )}&used_at=not.is.null&order=created_at.desc&limit=1&select=email,used_at,captured_lists`;
    const res = await Promise.race([
      fetch(q, {
        method: "GET",
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      }),
      new Promise<Response>((_, reject) => setTimeout(() => reject(new Error("timeout")), 2500)),
    ]);
    if (!res.ok) return notSignedIn();

    const rows = (await res.json()) as Array<{
      email: string;
      used_at: string | null;
      captured_lists: unknown;
    }>;
    const row = rows[0];
    if (!row || !row.used_at) return notSignedIn();

    let fullName: string | null = null;
    let lists: unknown[] = [];
    let resumeState: unknown = null;
    const cap = row.captured_lists;
    if (cap && typeof cap === "object" && !Array.isArray(cap)) {
      const obj = cap as Record<string, unknown>;
      if (typeof obj.fullName === "string" && obj.fullName.trim()) fullName = obj.fullName.trim();
      if (Array.isArray(obj.lists)) lists = obj.lists;
      if (obj.resumeState && typeof obj.resumeState === "object") resumeState = obj.resumeState;
    }

    return new Response(
      JSON.stringify({ signedIn: true, email: row.email, fullName, lists, resumeState }),
      { status: 200, headers: NO_STORE },
    );
  } catch {
    return notSignedIn();
  }
}
