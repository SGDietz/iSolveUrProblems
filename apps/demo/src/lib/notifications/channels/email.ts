import { RESEND_API_KEY, RESEND_FROM_EMAIL } from "../../../../app/api/secrets";
import { buildUnsubscribeUrl } from "../unsubscribe";
import type { EmailRendered } from "../types";

const RESEND_URL = "https://api.resend.com/emails";
const APP_ORIGIN = (process.env.PUBLIC_APP_ORIGIN?.trim() || "https://www.isolveurproblems.ai").replace(/\/$/, "");

// CAN-SPAM requires a valid physical postal address on commercial email.
// Appended here, at the single send choke point, so every template gets
// it without having to repeat it in all 11 templates individually.
const MAILING_ADDRESS = "DietzX LLC, 30 N Gould St Ste N, Sheridan, WY 82801";

function withComplianceFooter(rendered: EmailRendered, unsubscribeUrl: string | null): EmailRendered {
  const unsubHtml = unsubscribeUrl
    ? ` &middot; <a href="${unsubscribeUrl}" style="color:#888">Unsubscribe</a>`
    : "";
  const unsubText = unsubscribeUrl ? `\nUnsubscribe: ${unsubscribeUrl}` : "";
  return {
    ...rendered,
    html: `${rendered.html}<p style="font-family:system-ui,sans-serif;font-size:12px;color:#888;margin-top:24px">${MAILING_ADDRESS}${unsubHtml}</p>`,
    text: rendered.text ? `${rendered.text}\n\n${MAILING_ADDRESS}${unsubText}` : undefined,
  };
}

export type EmailSendResult =
  | { ok: true; providerId: string }
  | { ok: false; error: string };

/**
 * Send an email via Resend. Reads RESEND_API_KEY + RESEND_FROM_EMAIL
 * from secrets. Returns a structured result; never throws.
 *
 * `userId` is optional (some sends are pre-account, e.g. magic links) —
 * when present, a signed one-click unsubscribe link is appended.
 */
export async function sendEmail(args: {
  to: string;
  rendered: EmailRendered;
  userId?: string | null;
}): Promise<EmailSendResult> {
  if (!RESEND_API_KEY) {
    return { ok: false, error: "RESEND_API_KEY not configured" };
  }
  if (!args.to.trim()) {
    return { ok: false, error: "empty recipient" };
  }

  const unsubscribeUrl = args.userId ? buildUnsubscribeUrl(APP_ORIGIN, args.userId, "email") : null;
  const rendered = withComplianceFooter(args.rendered, unsubscribeUrl);

  try {
    const res = await fetch(RESEND_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: RESEND_FROM_EMAIL,
        to: [args.to],
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      message?: string;
      name?: string;
    };
    if (!res.ok) {
      return {
        ok: false,
        error: data.message || data.name || `resend ${res.status}`,
      };
    }
    if (!data.id) {
      return { ok: false, error: "resend response missing id" };
    }
    return { ok: true, providerId: data.id };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "email send threw",
    };
  }
}
