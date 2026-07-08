import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
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

function canonicalLocalDevHost(host: string): string {
  if (host === "localhost") return "127.0.0.1";
  if (host.startsWith("localhost:")) return `127.0.0.1:${host.slice("localhost:".length)}`;
  if (host === "[::1]") return "127.0.0.1";
  if (host.startsWith("[::1]:")) return `127.0.0.1:${host.slice("[::1]:".length)}`;
  return host;
}

function canonicalLocalDevOrigin(origin: string): string {
  const trimmed = origin.trim().replace(/\/$/, "");
  try {
    const url = new URL(trimmed);
    const canonicalHost = canonicalLocalDevHost(url.host);
    if (canonicalHost !== url.host) {
      url.host = canonicalHost;
      return url.toString().replace(/\/$/, "");
    }
    return trimmed;
  } catch {
    return trimmed;
  }
}

/** Base for post-sign-in redirects. PUBLIC_APP_ORIGIN pins it for local/tunnel
 *  testing while canonicalizing localhost to 127.0.0.1; unset in prod =>
 *  prefer the actual Host header before NextRequest.url fallback. */
function appBase(request: NextRequest): string {
  const o = process.env.PUBLIC_APP_ORIGIN?.trim();
  if (o) return canonicalLocalDevOrigin(o);

  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const rawHost = forwardedHost || request.headers.get("host")?.split(",")[0]?.trim();
  if (rawHost) {
    const host = canonicalLocalDevHost(rawHost);
    const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
    const proto =
      forwardedProto ||
      (host.startsWith("localhost") || host.startsWith("127.0.0.1")
        ? "http"
        : "https");
    return `${proto}://${host}`.replace(/\/$/, "");
  }

  return new URL(request.url).origin;
}

const ISOLVE_AUTH_COOKIE_BASE = `sb-${ISOLVE_SUPABASE_REF}-auth-token`;
const ISOLVE_AUTH_COOKIE_RE = new RegExp(`^sb-${ISOLVE_SUPABASE_REF}-auth-token(?:\\.\\d+)?$`);
// Supabase SSR chunks large session cookies as `<base>.0`, `<base>.1`, ...;
// 12 is comfortably above any real chunk count seen in local smoke logs. Named
// so the ceiling reads as deliberate, not an arbitrary loop bound.
const MAX_ISOLVE_AUTH_COOKIE_CHUNKS = 12;

/**
 * Names of every iSolve auth-token cookie (base + chunk suffixes) that might
 * be present — scoped ONLY to iSolve's own Supabase ref. Never a blanket
 * sb-*-auth-token match: that would also clear a co-located local aiASAP
 * session sharing the same 127.0.0.1 cookie jar.
 */
function isolveAuthCookieNames(existing: { name: string }[]): string[] {
  const names = new Set<string>([ISOLVE_AUTH_COOKIE_BASE]);
  for (let i = 0; i < MAX_ISOLVE_AUTH_COOKIE_CHUNKS; i += 1) {
    names.add(`${ISOLVE_AUTH_COOKIE_BASE}.${i}`);
  }
  for (const cookie of existing) {
    if (ISOLVE_AUTH_COOKIE_RE.test(cookie.name)) names.add(cookie.name);
  }
  return [...names];
}

type VerifiedMagicLinkUser = {
  id?: string;
  email?: string;
  user_metadata?: Record<string, unknown>;
};

type VerifiedMagicLinkSession = { access_token: string; refresh_token: string };

async function verifyMagicLinkWithoutCookies(
  tokenHash: string,
  type: EmailOtpType,
): Promise<
  | { ok: true; user: VerifiedMagicLinkUser; session: VerifiedMagicLinkSession }
  | { ok: false; error: string }
> {
  const supaUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supaUrl || !anonKey) return { ok: false, error: "Supabase not configured" };
  if (supaUrl.includes(AIASAP_SUPABASE_REF) || !supaUrl.includes(ISOLVE_SUPABASE_REF)) {
    return { ok: false, error: "Wrong Supabase project" };
  }

  const res = await fetch(`${supaUrl}/auth/v1/verify`, {
    method: "POST",
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ token_hash: tokenHash, type }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error("auth/callback: token_hash verify failed", res.status, detail.slice(0, 200));
    return { ok: false, error: "Email link is invalid or has expired" };
  }

  const body = (await res.json().catch(() => ({}))) as {
    user?: VerifiedMagicLinkUser;
    access_token?: string;
    refresh_token?: string;
  };
  if (!body.access_token || !body.refresh_token) {
    console.error("auth/callback: token_hash verify returned no session tokens");
    return { ok: false, error: "Email link is invalid or has expired" };
  }
  return {
    ok: true,
    user: body.user ?? {},
    session: { access_token: body.access_token, refresh_token: body.refresh_token },
  };
}

/**
 * Establish the clicking browser's session from the tokens /auth/v1/verify
 * already returned. Clears stale/chunked iSolve auth cookies FIRST, then
 * writes ONE fresh session via the same next/headers cookies() pathway the
 * OAuth ?code= branch uses.
 *
 * Returns false on failure so the token_hash branch cannot silently redirect
 * as a success while leaving the browser with no session.
 */
async function establishSessionFromVerify(
  request: NextRequest,
  session: VerifiedMagicLinkSession,
): Promise<boolean> {
  try {
    const cookieStore = await cookies();
    for (const name of isolveAuthCookieNames(request.cookies.getAll())) {
      cookieStore.set(name, "", { path: "/", maxAge: 0 });
    }
    const supabase = await getSupabaseServer();
    const { error } = await supabase.auth.setSession(session);
    if (error) {
      console.error("auth/callback: setSession after verify failed", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error("auth/callback: session establish threw", e);
    return false;
  }
}

/**
 * Cross-browser device link: flip ONLY the exact magic-link row carrying this token
 * (matched by email + token_hash) to used — never every pending row for the email,
 * which would false-greet a second session for the same person. The live 6 session
 * polls /api/account/session-status by its session_id and, the moment its row flips,
 * greets the user by name — even though THIS browser holds the cookie, not 6's.
 * Best-effort with service role; a failure here must NEVER block the sign-in redirect.
 */
async function markDeviceLinkUsed(email: string, tokenHash: string): Promise<void> {
  const supaUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !serviceRoleKey || !tokenHash) return;
  // Wrong-project guard: never touch aiASAP's DB from iSolve.
  if (supaUrl.includes(AIASAP_SUPABASE_REF) || !supaUrl.includes(ISOLVE_SUPABASE_REF)) return;

  // Match the EXACT row carrying this link's token — never every row for the
  // email (that would false-greet a second session for the same person).
  const q = `${supaUrl}/rest/v1/account_email_links?email=eq.${encodeURIComponent(
    email.toLowerCase(),
  )}&token_hash=eq.${encodeURIComponent(tokenHash)}&used_at=is.null`;
  const res = await fetch(q, {
    method: "PATCH",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      // Return the affected row so callback smoke/logs can distinguish a true
      // device-link flip from a silent zero-row PATCH. Never log the row itself:
      // it carries the magic-link token_hash.
      Prefer: "return=representation",
    },
    body: JSON.stringify({ used_at: new Date().toISOString() }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(
      "auth/callback: account_email_links used_at patch failed",
      res.status,
      detail.slice(0, 200),
    );
    return;
  }
  const rows = await res.json().catch(() => null);
  const rowCount = Array.isArray(rows) ? rows.length : -1;
  if (rowCount !== 1) {
    console.error(
      "auth/callback: account_email_links used_at patch matched unexpected row count",
      rowCount,
    );
  }
  // Non-secret breadcrumb (count only — never the row, it carries the token_hash).
  console.error("bc:callback-row-used", JSON.stringify({ rowCount, ok: res.ok }));
}

/**
 * Stamp visit_count + last_visit_at on the auth user so the returning-greeting
 * tiers actually advance. Service-role admin update, merged onto existing
 * metadata so full_name etc. survive. Best-effort.
 */
async function stampVisit(
  userId: string,
  currentMeta: Record<string, unknown>,
): Promise<void> {
  const supaUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !serviceRoleKey) return;
  if (supaUrl.includes(AIASAP_SUPABASE_REF) || !supaUrl.includes(ISOLVE_SUPABASE_REF)) return;
  const prev =
    typeof currentMeta.visit_count === "number" ? currentMeta.visit_count : 0;
  const res = await fetch(`${supaUrl}/auth/v1/admin/users/${encodeURIComponent(userId)}`, {
    method: "PUT",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      user_metadata: {
        ...currentMeta,
        visit_count: prev + 1,
        last_visit_at: new Date().toISOString(),
      },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.error(
      "auth/callback: visit metadata stamp failed",
      res.status,
      detail.slice(0, 200),
    );
  }
}

/**
 * OAuth + magic-link callback handler.
 *
 * Two flows land here, BOTH establishing the server session cookie:
 *  - PKCE OAuth / code:        ?code=...                        -> exchangeCodeForSession
 *  - Voice-account magic link: ?token_hash=...&type=magiclink   -> verify + setSession + flip row
 *
 * The voice-account branch verifies via a direct REST call to
 * /auth/v1/verify (not supabase.auth.verifyOtp()) so it can clear stale
 * chunked iSolve auth cookies BEFORE writing the fresh session.
 *
 * Every path that does NOT establish a session (verify failure, missing
 * params, unexpected error) is a PLAIN redirect — it must never touch
 * cookies, or it can silently sign out someone else's already-valid session.
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
    if (code) {
      const supabase = await getSupabaseServer();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) {
        return NextResponse.redirect(
          new URL(`/auth/sign-in?error=${encodeURIComponent(error.message)}`, appBase(request)),
        );
      }

      try {
        const { data } = await supabase.auth.getUser();
        const user = data?.user;
        if (user?.id) {
          await stampVisit(user.id, (user.user_metadata ?? {}) as Record<string, unknown>);
        }
      } catch (e) {
        console.error("auth/callback: post-OAuth visit stamp failed", e);
      }

      return NextResponse.redirect(new URL(next, appBase(request)));
    }

    if (tokenHash) {
      // Voice-account magic link (token_hash flow from /api/account/start).
      const verified = await verifyMagicLinkWithoutCookies(tokenHash, type);
      if (!verified.ok) {
        const errorMessage =
          "error" in verified ? verified.error : "Email link is invalid or has expired";
        return NextResponse.redirect(
          new URL(`/auth/sign-in?error=${encodeURIComponent(errorMessage)}`, appBase(request)),
        );
      }

      // Establish the session before the best-effort visit stamp. If this fails,
      // still flip the device-link row for the live 6 session, but surface an
      // explicit browser error instead of silently redirecting as a success.
      const sessionEstablished = await establishSessionFromVerify(request, verified.session);

      // Row flip is the highest-priority action (6 polls for it) — its own
      // try/catch, before the best-effort visit stamp, so a stampVisit network
      // throw can never starve the flip.
      if (verified.user.email) {
        try {
          await markDeviceLinkUsed(verified.user.email, tokenHash);
        } catch (e) {
          console.error("auth/callback: device-link flip threw", e);
        }
      }
      try {
        if (verified.user.id) {
          await stampVisit(
            verified.user.id,
            (verified.user.user_metadata ?? {}) as Record<string, unknown>,
          );
        }
      } catch (e) {
        console.error("auth/callback: post-magic-link visit stamp failed", e);
      }

      if (!sessionEstablished) {
        return NextResponse.redirect(
          new URL("/auth/sign-in?error=session_establish_failed", appBase(request)),
        );
      }

      return NextResponse.redirect(new URL(next, appBase(request)));
    }

    return NextResponse.redirect(new URL(next, appBase(request)));
  } catch (e) {
    console.error("auth/callback failed", e);
    return NextResponse.redirect(
      new URL("/auth/sign-in?error=callback_failed", appBase(request)),
    );
  }
}
