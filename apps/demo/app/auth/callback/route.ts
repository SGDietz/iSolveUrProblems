import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { getSupabaseServer } from "../../../src/lib/auth/supabaseServer";

const ISOLVE_SUPABASE_REF = "dphxcqjkzhvsdejtxdcj";
const AIASAP_SUPABASE_REF = "wqszxsqzkaatghyrqviv";

/** Only allow safe relative redirects (block open-redirect via absolute/protocol URLs). */
function safeNext(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}

/**
 * Cross-browser device link: flip every pending magic-link row for this email to
 * used. The live 6 session polls /api/account/session-status by its session_id and,
 * the moment its row flips, greets the user by name — even though THIS browser holds
 * the cookie, not 6's. Best-effort with service role; a failure here must NEVER block
 * the sign-in redirect.
 */
async function markDeviceLinkUsed(email: string): Promise<void> {
  const supaUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !serviceRoleKey) return;
  // Wrong-project guard: never touch aiASAP's DB from iSolve.
  if (supaUrl.includes(AIASAP_SUPABASE_REF) || !supaUrl.includes(ISOLVE_SUPABASE_REF)) return;

  const q = `${supaUrl}/rest/v1/account_email_links?email=eq.${encodeURIComponent(
    email.toLowerCase(),
  )}&used_at=is.null`;
  await fetch(q, {
    method: "PATCH",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ used_at: new Date().toISOString() }),
  });
}

/**
 * OAuth + magic-link callback handler.
 *
 * Two flows land here, both establishing the server session cookie:
 *  - PKCE OAuth / code:        ?code=...                        -> exchangeCodeForSession
 *  - Voice-account magic link: ?token_hash=...&type=magiclink   -> verifyOtp
 *
 * Then forwards to a safe relative `next` (default "/"). next-intl middleware
 * skips /auth/callback, so this stays a fixed, non-localized route.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const type = (url.searchParams.get("type") || "magiclink") as EmailOtpType;
  const next = safeNext(url.searchParams.get("next"));

  try {
    const supabase = await getSupabaseServer();

    if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        return NextResponse.redirect(
          new URL(`/auth/sign-in?error=${encodeURIComponent(error.message)}`, request.url),
        );
      }
    } else if (tokenHash) {
      // Voice-account magic link (token_hash flow from /api/account/start).
      const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      if (error) {
        return NextResponse.redirect(
          new URL(`/auth/sign-in?error=${encodeURIComponent(error.message)}`, request.url),
        );
      }
    }

    // A session was just established — stamp the device link so the live 6
    // session (polling by session_id) can pick up this cross-browser sign-in.
    if (code || tokenHash) {
      try {
        const { data } = await supabase.auth.getUser();
        const email = data?.user?.email;
        if (email) await markDeviceLinkUsed(email);
      } catch (e) {
        console.error("auth/callback: device-link mark failed", e);
      }
    }
  } catch (e) {
    console.error("auth/callback failed", e);
    return NextResponse.redirect(
      new URL("/auth/sign-in?error=callback_failed", request.url),
    );
  }

  return NextResponse.redirect(new URL(next, request.url));
}
