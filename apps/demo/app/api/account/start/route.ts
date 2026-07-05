import {
  assertAllowedOrigin,
  isSafeTranscriptionSessionId,
  MAX_TRANSCRIPTION_SESSION_ID_CHARS,
  truncateUtf8String,
} from "../../../../src/lib/apiRouteSecurity";
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
    const rawSessionId =
      typeof body.sessionId === "string"
        ? truncateUtf8String(body.sessionId.trim(), MAX_TRANSCRIPTION_SESSION_ID_CHARS)
        : null;
    sessionId = isSafeTranscriptionSessionId(rawSessionId) ? rawSessionId : null;
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

  // P0 truth gate: a voice-account email without a safe LiveAvatar session id
  // cannot be linked back to the live 6 session. Do not send and then degrade;
  // force the client to wait/retry once the minted/SDK session id is available.
  if (!sessionId) {
    return new Response(
      JSON.stringify({
        ok: false,
        emailSent: false,
        linkRowInserted: false,
        fullSuccess: false,
        errorCode: "missing_session_id",
        error: "LiveAvatar session id required before sending magic link",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // token_hash flow: generate the link server-side and point it at OUR
  // /auth/callback so the session cookie reaches the browser deterministically.
  // PUBLIC_APP_ORIGIN pins the email-link origin for local/tunnel testing — the
  // phone can't reach localhost, and a proxy (cloudflared) may hand the server a
  // localhost Host header. Unset in prod => identical behavior (request origin).
  const origin = (() => {
    const override = process.env.PUBLIC_APP_ORIGIN?.trim();
    if (override) return override.replace(/\/$/, "");
    try { return new URL(request.url).origin; } catch { return supaUrl.replace(/\/$/, ""); }
  })();
  const callbackBase = `${origin}/auth/callback`;
  const nextParam = encodeURIComponent("/?account=verified");
  const redirectTo = `${callbackBase}?next=${nextParam}`;

  let emailSent = false;
  let sendError: string | null = null;
  // The Supabase magic-link token in the email — stored on the row so /auth/callback
  // flips the EXACT row for this link (not every row for the email). Herm TASK_036.
  let deviceLinkTokenHash: string | null = null;
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
          // Remember THIS link's token as the device-link match key (callback flips
          // only the row carrying it).
          deviceLinkTokenHash = hashedToken;
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
              "Idempotency-Key": `magiclink:${sessionId.trim()}:${email.trim().toLowerCase()}`,
            },
            body: JSON.stringify({
              from: fromEmail,
              to: [email],
              subject: "Your iSolveUrProblems sign-in link",
              html,
            }),
          });
          if (sendRes.ok || sendRes.status === 409) {
            // 200 = sent; 409 = idempotency duplicate (already sent). 422 is a
            // validation/config FAILURE, NOT proof of delivery — counting it as
            // sent was a false-green (Herm TASK_037 #2). Treat it as a failure.
            emailSent = true;
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
  // Only insert a device-link row when there's a real magic-link token to match
  // later (deviceLinkTokenHash) AND a sessionId to poll by. token_hash = the
  // Supabase link token so /auth/callback flips exactly this row.
  let pendingStateToken: string | null = null;
  // TRUTH-GATE (audit 2026-06-28): the email can send while the device-link row
  // insert fails — in which case the return-greeting poll has nothing to find.
  // Surface the durable-persistence truth so the client doesn't promise a
  // device-link it can't honor.
  let linkRowInserted = false;
  if (serviceRoleKey && sessionId && deviceLinkTokenHash) {
    try {
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
          token_hash: deviceLinkTokenHash,
          captured_lists: captured,
          expires_at: expiresAt,
        }),
      });
      if (insertRes.ok) {
        // Client breadcrumb only (localStorage); not a lookup key.
        pendingStateToken = crypto.randomUUID();
        linkRowInserted = true;
        console.error(
          "bc:link-row-inserted",
          JSON.stringify({ inserted: true, emailSent, hasName: Boolean(fullName) }),
        );
      } else {
        const detail = await insertRes.text();
        console.error("account_email_links insert failed:", insertRes.status, detail.slice(0, 200));
        console.error("bc:link-row-inserted", JSON.stringify({ inserted: false, status: insertRes.status }));
      }
    } catch (error) {
      console.error("account_email_links insert threw:", error);
    }
  }

  // LEAD-SESSION SEED (Herm TASK_041 #4): the account flow is the authoritative
  // name source (user confirmed it on-chest) but never wrote lead_sessions — so
  // that table kept re-asking for a name 6 already has. Seed it best-effort with
  // merge-duplicates; a later spoken pass uses pickBetterFullName so this won't
  // clobber a better name. Must NOT block the magic-link response.
  let leadSeeded = false;
  if (serviceRoleKey && sessionId) {
    try {
      // Seed the lead_sessions row for the EXACT live session that sent the link —
      // even when no name was captured yet. The old `&& fullName` gate skipped the
      // write entirely on name-less sends, leaving last_prompted_field stuck on
      // 'full_name' forever (Herm TASK_041 #7). When the name IS known, clear the
      // ask-loop; otherwise just record email + consent and let a later spoken name
      // fill it (pickBetterFullName means this can't clobber a better name).
      const seedRow: Record<string, unknown> = {
        session_id: sessionId,
        email,
        consent_status: "accepted",
        updated_at: new Date().toISOString(),
      };
      if (fullName) {
        seedRow.full_name = fullName;
        seedRow.last_prompted_field = null;
        seedRow.last_prompted_at = null;
      }
      const seedRes = await fetch(`${supaUrl}/rest/v1/lead_sessions?on_conflict=session_id`, {
        method: "POST",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify([seedRow]),
      });
      leadSeeded = seedRes.ok;
      console.error(
        "bc:lead-session-seeded",
        JSON.stringify({ ok: seedRes.ok, status: seedRes.status, hasName: Boolean(fullName) }),
      );
    } catch (error) {
      console.error("lead_sessions seed threw:", error);
    }
  }

  if (!emailSent) {
    return new Response(
      JSON.stringify({
        ok: false,
        emailSent: false,
        linkRowInserted: false,
        fullSuccess: false,
        error: sendError || "Failed to send magic link",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  const fullSuccess = linkRowInserted;

  return new Response(
    JSON.stringify({
      ok: fullSuccess,
      emailSent: true,
      linkRowInserted,
      leadSeeded,
      fullSuccess,
      pendingStateToken,
      ...(fullSuccess
        ? {}
        : {
            degraded: true,
            error: "Email sent but account session was not durably saved",
          }),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
