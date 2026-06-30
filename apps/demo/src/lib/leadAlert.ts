// Lead alert: when a new contact (name + at least one of phone/email) lands
// in lead_sessions, push a tight alert to G's Telegram (ClaudeTel) and a
// richer one to G's email via Resend. Both fire fire-and-forget — the user-
// facing flow must NEVER block on alert delivery.

const TELEGRAM_API = "https://api.telegram.org";
const RESEND_API = "https://api.resend.com/emails";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";
const SUMMARY_MAX_WORDS = 30;
const EMAIL_SUMMARY_MAX_WORDS = 100;

type LeadInfo = {
  sessionId: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
};

function fmtPhone(p: string | null): string {
  if (!p) return "";
  // Display US numbers as ###-###-#### where possible
  const digits = p.replace(/\D/g, "");
  if (digits.length === 10) {
    return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `${digits.slice(1, 4)}-${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return p;
}

async function fetchSessionTranscript(
  supabaseUrl: string,
  serviceRoleKey: string,
  sessionId: string,
): Promise<string> {
  // Pull both user transcripts and assistant turns for this session, ordered.
  try {
    const headers = {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    };
    const [transcriptRes, convoRes] = await Promise.all([
      fetch(
        `${supabaseUrl}/rest/v1/transcript_events?session_id=eq.${encodeURIComponent(sessionId)}&select=created_at,transcript&order=created_at.asc&limit=200`,
        { headers },
      ),
      fetch(
        `${supabaseUrl}/rest/v1/conversation_messages?session_id=eq.${encodeURIComponent(sessionId)}&select=la_absolute_timestamp,role,message&order=la_absolute_timestamp.asc.nullslast&limit=200`,
        { headers },
      ),
    ]);
    if (!transcriptRes.ok && !convoRes.ok) return "";
    const transcripts = transcriptRes.ok
      ? ((await transcriptRes.json()) as Array<{
          created_at: string;
          transcript: string;
        }>)
      : [];
    const convos = convoRes.ok
      ? ((await convoRes.json()) as Array<{
          la_absolute_timestamp: number | null;
          role: string;
          message: string;
        }>)
      : [];
    // Use convos primarily — they have the assistant's actual speech.
    // Fall back to transcripts if convos are empty.
    if (convos.length > 0) {
      return convos
        .filter(
          (c) =>
            !c.message.startsWith("[VISION") &&
            !c.message.startsWith("[USER HAS BEEN SILENT") &&
            !c.message.startsWith("[GO LIVE"),
        )
        .map((c) => `${c.role.toUpperCase()}: ${c.message}`)
        .join("\n");
    }
    return transcripts
      .filter((t) => !t.transcript.startsWith("["))
      .map((t) => `USER: ${t.transcript}`)
      .join("\n");
  } catch {
    return "";
  }
}

async function summarizeWithHaiku(
  transcript: string,
  maxWords: number,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !transcript.trim()) return "";
  try {
    const prompt = `You are summarizing a sales lead conversation from iSolveUrProblems.ai.
Summarize the conversation below in ${maxWords} words or fewer. Capture:
- What problem the user came in with
- Whether the conversation reached the investment / company-vision stage
- Whether the user expressed financial interest in the company (mark as INTERESTED if yes)
- The vibe of the user (engaged, skeptical, rushed, etc.)

Return ONLY the summary sentence. No preamble, no headers, no quotes.

CONVERSATION:
${transcript}`;
    const res = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) return "";
    const data = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const text = data.content?.find((c) => c.type === "text")?.text ?? "";
    return text.trim();
  } catch {
    return "";
  }
}

async function sendTelegram(
  chatId: string,
  text: string,
): Promise<void> {
  const tok = process.env.CLAUDE_TELEGRAM_TOKEN;
  if (!tok || !chatId) return;
  try {
    await fetch(`${TELEGRAM_API}/bot${tok}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch {
    // swallow — alerting must not break lead capture
  }
}

async function sendEmail(
  toAddr: string,
  fromAddr: string,
  subject: string,
  htmlBody: string,
): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !toAddr) return;
  try {
    await fetch(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: fromAddr,
        to: [toAddr],
        subject,
        html: htmlBody,
      }),
    });
  } catch {
    // swallow
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Decide whether the current lead state warrants firing an alert.
 * Rule: alert when transitioning from "no contact info" to "has phone OR email"
 * AND a name is also present. This avoids spamming on every word the user says.
 */
export function shouldFireLeadAlert(
  prev: { full_name: string | null; phone: string | null; email: string | null },
  curr: { full_name: string | null; phone: string | null; email: string | null },
): boolean {
  const hadAnyContact = !!(prev.phone?.trim() || prev.email?.trim());
  const hasAnyContactNow = !!(curr.phone?.trim() || curr.email?.trim());
  const hasNameNow = !!(curr.full_name && curr.full_name.trim().length >= 2);
  // Fire when contact info just became available AND we have a name.
  if (!hadAnyContact && hasAnyContactNow && hasNameNow) return true;
  // Also fire if we already had contact info but the name JUST got captured —
  // means we now have a usable lead for the first time.
  const hadName = !!(prev.full_name && prev.full_name.trim().length >= 2);
  if (!hadName && hasNameNow && hasAnyContactNow) return true;
  return false;
}

/**
 * Fire-and-forget. Sends to both Telegram and email if their env vars exist.
 * Pulls the session transcript and runs Haiku summaries inline. Total time
 * usually under 2s; the caller should NOT await this in latency-sensitive
 * paths — use `void notifyNewLead(...)`.
 */
export async function notifyNewLead(
  lead: LeadInfo,
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<void> {
  const transcript = await fetchSessionTranscript(
    supabaseUrl,
    serviceRoleKey,
    lead.sessionId,
  );

  // Run both summaries in parallel (Haiku call is the slow leg).
  const [briefSummary, longSummary] = await Promise.all([
    summarizeWithHaiku(transcript, SUMMARY_MAX_WORDS),
    summarizeWithHaiku(transcript, EMAIL_SUMMARY_MAX_WORDS),
  ]);

  const name = lead.fullName ?? "(no name)";
  const phone = fmtPhone(lead.phone);
  const email = lead.email ?? "";
  const supaProj =
    supabaseUrl.match(/https:\/\/([^.]+)\./)?.[1] ?? "";
  const sessionLink = supaProj
    ? `https://supabase.com/dashboard/project/${supaProj}/editor/transcript_events?filter=session_id%3Deq.${encodeURIComponent(lead.sessionId)}`
    : "";

  // Telegram — tight format, ClaudeTel
  const tgChatId =
    process.env.LEAD_ALERT_TELEGRAM_CHAT_ID ?? "1271337219";
  const tgLines = [
    `🎯 <b>NEW LEAD on iSolve</b>`,
    ``,
    `<b>${escapeHtml(name)}</b>`,
    phone ? `📞 ${escapeHtml(phone)}` : "",
    email ? `✉️ ${escapeHtml(email)}` : "",
    ``,
    briefSummary
      ? `<i>${escapeHtml(briefSummary)}</i>`
      : `<i>(no summary available)</i>`,
    ``,
    `<code>session ${escapeHtml(lead.sessionId.slice(0, 8))}</code>`,
  ]
    .filter((l) => l !== "")
    .join("\n");
  void sendTelegram(tgChatId, tgLines);

  // Email — richer. Beta: leads go to G's business inbox (he fields them himself
  // and reaches out directly — the $0 concierge connect). Override via env
  // LEAD_ALERT_EMAIL_TO if needed (G 2026-06-29).
  const toAddr = process.env.LEAD_ALERT_EMAIL_TO ?? "WildWorks@pm.me";
  const fromAddr =
    process.env.LEAD_ALERT_EMAIL_FROM ?? "iSolve Leads <onboarding@resend.dev>";
  const subject = `🎯 New iSolve lead: ${name}`;
  const htmlBody = `
<!doctype html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; color: #222; max-width: 640px; margin: 0 auto; padding: 24px;">
  <h1 style="font-size: 22px; margin: 0 0 16px;">🎯 New lead on iSolveUrProblems.ai</h1>
  <table style="border-collapse: collapse; width: 100%; margin-bottom: 20px;">
    <tr><td style="padding: 6px 0; color: #666;">Name</td><td style="padding: 6px 0; font-weight: 600;">${escapeHtml(name)}</td></tr>
    ${phone ? `<tr><td style="padding: 6px 0; color: #666;">Phone</td><td style="padding: 6px 0;"><a href="tel:${escapeHtml(phone.replace(/\D/g, ""))}">${escapeHtml(phone)}</a></td></tr>` : ""}
    ${email ? `<tr><td style="padding: 6px 0; color: #666;">Email</td><td style="padding: 6px 0;"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>` : ""}
    <tr><td style="padding: 6px 0; color: #666;">Captured</td><td style="padding: 6px 0;">${escapeHtml(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }))} ET</td></tr>
  </table>
  <h2 style="font-size: 16px; margin: 0 0 8px;">Summary</h2>
  <p style="margin: 0 0 20px; line-height: 1.5;">${escapeHtml(longSummary || briefSummary || "No summary available.")}</p>
  ${sessionLink ? `<p style="margin: 0;"><a href="${escapeHtml(sessionLink)}" style="display: inline-block; background: #ff7a1a; color: white; padding: 10px 18px; border-radius: 6px; text-decoration: none; font-weight: 600;">Open full session in Supabase</a></p>` : ""}
  <p style="margin: 24px 0 0; font-size: 12px; color: #999;">Session ID: ${escapeHtml(lead.sessionId)}</p>
</body></html>`;
  void sendEmail(toAddr, fromAddr, subject, htmlBody);
}
