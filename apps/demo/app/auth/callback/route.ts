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

/** Base for post-sign-in redirects. PUBLIC_APP_ORIGIN pins it for local/tunnel
 *  testing (a proxy may rewrite Host, stranding the phone on localhost); unset in
 *  prod => request.url (unchanged behavior). */
function appBase(request: NextRequest): string {
  const o = process.env.PUBLIC_APP_ORIGIN?.trim();
  return o ? o.replace(/\/$/, "") : request.url;
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
 * tiers actually advance (Herm TASK_037 #3 — nothing was incrementing them, so
 * returners were stuck on the "second" tier forever). Service-role admin update,
 * merged onto existing metadata so full_name etc. survive. Best-effort.
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
          new URL(`/auth/sign-in?error=${encodeURIComponent(error.message)}`, appBase(request)),
        );
      }
    } else if (tokenHash) {
      // Voice-account magic link (token_hash flow from /api/account/start).
      const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
      if (error) {
        return NextResponse.redirect(
          new URL(`/auth/sign-in?error=${encodeURIComponent(error.message)}`, appBase(request)),
        );
      }
    }

    // After either OAuth/code or voice magic-link auth succeeds, stamp visit
    // metadata so greeting tiers advance. For voice links, also stamp only the
    // exact account_email_links row carrying this token so the live 6 session
    // polling by session_id can greet without flipping other same-email rows.
    try {
      const { data } = await supabase.auth.getUser();
      const user = data?.user;
      if (user?.id) {
        await stampVisit(user.id, (user.user_metadata ?? {}) as Record<string, unknown>);
      }
      if (tokenHash && user?.email) await markDeviceLinkUsed(user.email, tokenHash);
    } catch (e) {
      console.error("auth/callback: post-auth visit/device-link stamp failed", e);
    }
  } catch (e) {
    console.error("auth/callback failed", e);
    return NextResponse.redirect(
      new URL("/auth/sign-in?error=callback_failed", appBase(request)),
    );
  }

  return NextResponse.redirect(new URL(next, appBase(request)));
}
