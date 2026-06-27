import { assertAllowedOrigin, truncateUtf8String } from "../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../src/lib/rateLimit";
import { buildMagicLinkEmailHtml } from "../../../../src/lib/magicLinkEmail";

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

// iSolve's own Supabase project ref. We HARD-REFUSE if the configured URL is
// aiASAP's project — a successful write to the wrong DB is worse than a failure
// (Herm TASK_032, highest-risk invisible bug).
const ISOLVE_SUPABASE_REF = "dphxcqjkzhvsdejtxdcj";
const AIASAP_SUPABASE_REF = "wqszxsqzkaatghyrqviv";

/**
 * Voice-driven account setup endpoint (ported from aiASAP, adapted for iSolve).
 *
 * Called by LiveAvatarSession after 6 walks the user through email collection +
 * on-chest confirmation. Generates a Supabase magic-link token_hash server-side,
 * sends OUR branded email via Resend, and points the link at iSolve's
 * /auth/callback?token_hash=...&type=magiclink so the callback writes the server
 * cookie deterministically (same proven path as ?code= OAuth).
 *
 * Also saves { lists, resumeState, fullName } to account_email_links.captured_lists
 * (service role, bypasses RLS) so on return 6 can say "You talked, I remembered."
 */
export async function POST(request: Request) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  const supaUrl =
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey =
    process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supaUrl || !anonKey) {
    return new Response(
      JSON.stringify({ ok: false, emailSent: false, error: "Supabase not configured" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  // Wrong-project guard: never touch aiASAP's DB from iSolve.
  if (supaUrl.includes(AIASAP_SUPABASE_REF) || !supaUrl.includes(ISOLVE_SUPABASE_REF)) {
    console.error("account/start: SUPABASE_URL is not iSolve's project — refusing.");
    return new Response(
      JSON.stringify({ ok: false, emailSent: false, error: "Wrong Supabase project — refusing" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }

  let email = "";
  let fullName: string | null = null;
  let sessionId: string | null = null;
  let lists: unknown[] = [];
  let resumeState: unknown = null;

  try {
    const body = await request.json();
    email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    fullName =
      typeof body.fullName === "string"
        ? truncateUtf8String(body.fullName.trim(), 200)
        : null;
    sessionId =
      typeof body.sessionId === "string"
        ? truncateUtf8String(body.sessionId.trim(), 100)
        : null;
    lists = Array.isArray(body.lists) ? body.lists.slice(0, 50) : [];
    resumeState =
      body.resumeState && typeof body.resumeState === "object" ? body.resumeState : null;
  } catch {
    return new Response(
      JSON.stringify({ ok: false, emailSent: false, error: "Invalid request body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!EMAIL_RE.test(email)) {
    return new Response(
      JSON.stringify({ ok: false, emailSent: false, error: "Invalid email address" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  // token_hash flow: generate the link server-side and point it at OUR
  // /auth/callback so the session cookie reaches the browser deterministically.
  const origin = (() => {
    try { return new URL(request.url).origin; } catch { return supaUrl.replace(/\/$/, ""); }
  })();
  const callbackBase = `${origin}/auth/callback`;
  const nextParam = encodeURIComponent("/?account=verified");
  const redirectTo = `${callbackBase}?next=${nextParam}`;

  let emailSent = false;
  let sendError: string | null = null;
  const resendKey = process.env.RESEND_API_KEY;

  if (!serviceRoleKey) {
    sendError = "service role key required";
  } else if (!resendKey) {
    sendError = "RESEND_API_KEY not configured";
  } else {
    const adminHeaders = {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    };
    try {
      // 1) Ensure the user exists (passwordless, pre-confirmed). Idempotent.
      await fetch(`${supaUrl}/auth/v1/admin/users`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          email,
          email_confirm: true,
          user_metadata: { full_name: fullName, session_id: sessionId },
        }),
      });

      // 2) Generate a magic-link token_hash for this user.
      const genRes = await fetch(`${supaUrl}/auth/v1/admin/generate_link`, {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({
          type: "magiclink",
          email,
          options: { redirect_to: redirectTo },
        }),
      });
      if (!genRes.ok) {
        const detail = await genRes.text();
        sendError = `generate_link failed (${genRes.status})`;
        console.error("generate_link failed:", genRes.status, detail.slice(0, 200));
      } else {
        const gen = await genRes.json();
        const hashedToken =
          (gen && (gen.hashed_token || (gen.properties && gen.properties.hashed_token))) || null;
        if (!hashedToken) {
          sendError = "generate_link returned no token_hash";
        } else {
          // 3) Build OUR token_hash link → iSolve /auth/callback.
          const magicLink = `${callbackBase}?token_hash=${encodeURIComponent(hashedToken)}&type=magiclink&next=${nextParam}`;
          const fromEmail =
            process.env.RESEND_FROM_EMAIL || "iSolveUrProblems <onboarding@resend.dev>";
          const html = buildMagicLinkEmailHtml(magicLink);
          const sendRes = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${resendKey}`,
              "Content-Type": "application/json",
              // DEDUP: the transcript-sync auto-trigger may send for the SAME
              // signup. Same key (session+email) => Resend sends ONCE.
              "Idempotency-Key": `magiclink:${(sessionId ?? "").trim()}:${email.trim().toLowerCase()}`,
            },
            body: JSON.stringify({
              from: fromEmail,
              to: [email],
              subject: "Your iSolveUrProblems sign-in link",
              html,
            }),
          });
          if (sendRes.ok || sendRes.status === 409 || sendRes.status === 422) {
            emailSent = true; // 409/422 = idempotency conflict: already sent. Counts.
          } else {
            const detail = await sendRes.text();
            sendError = `Resend send failed (${sendRes.status})`;
            console.error("Resend send failed:", sendRes.status, detail.slice(0, 200));
          }
        }
      }
    } catch (error) {
      sendError = "token_hash send threw";
      console.error("/api/account/start token_hash threw:", error);
    }
  }

  // Save { lists, resumeState, fullName } to account_email_links for return recovery.
  // Service role bypasses RLS. Failures here don't block the response — the magic
  // link is the critical path. expires_at gates RESUME freshness, not sign-in.
  let pendingStateToken: string | null = null;
  if (serviceRoleKey && sessionId) {
    try {
      pendingStateToken = crypto.randomUUID();
      const tokenHash = await hashToken(pendingStateToken);
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const captured = { lists, resumeState, fullName };
      const insertRes = await fetch(`${supaUrl}/rest/v1/account_email_links`, {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          email,
          session_id: sessionId,
          token_hash: tokenHash,
          captured_lists: captured,
          expires_at: expiresAt,
        }),
      });
      if (!insertRes.ok) {
        const detail = await insertRes.text();
        console.error("account_email_links insert failed:", insertRes.status, detail.slice(0, 200));
        pendingStateToken = null;
      }
    } catch (error) {
      console.error("account_email_links insert threw:", error);
      pendingStateToken = null;
    }
  }

  if (!emailSent) {
    return new Response(
      JSON.stringify({ ok: false, emailSent: false, error: sendError || "Failed to send magic link" }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  return new Response(
    JSON.stringify({ ok: true, emailSent: true, pendingStateToken }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
