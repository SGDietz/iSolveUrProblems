import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { getSupabaseServer } from "../../../src/lib/auth/supabaseServer";

/** Only allow safe relative redirects (block open-redirect via absolute/protocol URLs). */
function safeNext(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
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
  } catch (e) {
    console.error("auth/callback failed", e);
    return NextResponse.redirect(
      new URL("/auth/sign-in?error=callback_failed", request.url),
    );
  }

  return NextResponse.redirect(new URL(next, request.url));
}
