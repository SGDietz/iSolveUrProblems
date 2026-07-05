import type {
  NotificationTemplate,
  EmailRendered,
  SmsRendered,
} from "../types";

/**
 * M4.8 — Coaching nudge email shell.
 *
 * The LLM has already composed `subject` + `body`. This template is the
 * branded HTML chrome wrapped around that content. Keeping the LLM
 * payload at the template level (not inside the chrome) means we can
 * swap models without touching the template, and the dashboard banner
 * can re-display the same body without re-rendering anything.
 */

export type CoachingNudgeData = {
  recipientName?: string | null;
  /** LLM-composed subject. */
  subject: string;
  /** LLM-composed plain-text body. ≤ 90 words. */
  body: string;
};

function firstName(full?: string | null): string {
  if (!full) return "there";
  return full.split(/\s+/)[0] || "there";
}

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const coachingNudgeTemplate: NotificationTemplate<CoachingNudgeData> = {
  id: "coaching.nudge.v1",
  contentType: "transactional",

  renderEmail: (data): EmailRendered => {
    const name = firstName(data.recipientName);
    const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:24px auto;line-height:1.55;color:#18181b">
  <div style="border-top:4px solid #facc15;padding-top:16px">
    <p style="margin:0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#52525b">iSolveUrProblems · A note from 6</p>
    <h2 style="margin:6px 0 16px;font-size:20px;color:#18181b">${escape(data.subject)}</h2>
  </div>
  <p style="white-space:pre-wrap;font-size:15px">${escape(data.body)}</p>
  <p style="margin-top:24px;color:#71717a;font-size:12px">— 6</p>
</body></html>`;
    const text = `${data.subject}

${data.body}

— 6`;
    return { subject: data.subject, html, text };
  },

  renderSms: (data): SmsRendered => {
    // Coaching nudges are email-first. SMS variant is a short prompt
    // pointing at the dashboard banner (where the full body lives).
    const name = firstName(data.recipientName);
    const body = `Hi ${name}, a note from 6: ${data.subject.slice(0, 120)} — full message in your dashboard.`;
    return { body };
  },
};

export default coachingNudgeTemplate;
