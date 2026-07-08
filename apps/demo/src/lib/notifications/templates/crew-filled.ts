import type {
  NotificationTemplate,
  EmailRendered,
  SmsRendered,
} from "../types";

/**
 * M4.2 — Sent to the REQUESTING contractor when one of the invited
 * helpers accepts. Their crew_request row just flipped to 'filled'.
 */

export type CrewFilledData = {
  recipientName?: string | null;
  helperName: string;
  helperPhone?: string | null;
  helperEmail?: string | null;
  category: string;
  neededAtText: string;
  dashboardUrl: string;
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

const crewFilledTemplate: NotificationTemplate<CrewFilledData> = {
  id: "crew.filled.v1",
  contentType: "transactional",

  renderEmail: (data): EmailRendered => {
    const name = firstName(data.recipientName);
    const contactLines = [
      data.helperPhone ? `Phone: ${data.helperPhone}` : null,
      data.helperEmail ? `Email: ${data.helperEmail}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    const contactBlock = contactLines
      ? `<p style="margin:8px 0;font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px">${escape(contactLines)}</p>`
      : "";
    const subject = `${data.helperName} accepted your crew request for ${data.neededAtText}`;
    const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:24px auto;line-height:1.5;color:#18181b">
  <div style="border-top:4px solid #22c55e;padding-top:16px">
    <p style="margin:0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#16a34a">iSolveUrProblems · Crew request filled</p>
    <h2 style="margin:6px 0 0;font-size:20px">${escape(subject)}</h2>
  </div>
  <p>Hey ${escape(name)},</p>
  <p><strong>${escape(data.helperName)}</strong> accepted your ${escape(data.category.replace(/_/g, " "))} request. Reach out and confirm details.</p>
  ${contactBlock}
  <p style="margin-top:20px"><a href="${escape(data.dashboardUrl)}" style="background:#facc15;color:#18181b;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600">Open dashboard</a></p>
  <p style="margin-top:24px;color:#71717a;font-size:12px">— 6</p>
</body></html>`;
    const text = `Hey ${name},

${data.helperName} accepted your ${data.category.replace(/_/g, " ")} request for ${data.neededAtText}.
${contactLines || ""}
Open dashboard: ${data.dashboardUrl}

— 6`;
    return { subject, html, text };
  },

  renderSms: (data): SmsRendered => {
    const name = firstName(data.recipientName);
    const contact = data.helperPhone
      ? ` (${data.helperPhone})`
      : data.helperEmail
        ? ` (${data.helperEmail})`
        : "";
    const body = `Hi ${name}, ${data.helperName}${contact} accepted your crew request for ${data.neededAtText}. Dashboard: ${data.dashboardUrl}`;
    return { body };
  },
};

export default crewFilledTemplate;
