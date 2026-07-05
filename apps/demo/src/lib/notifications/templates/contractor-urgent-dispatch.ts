import type {
  NotificationTemplate,
  EmailRendered,
  SmsRendered,
} from "../types";

/**
 * M4.4 — Urgent same-day dispatch invitation.
 *
 * Vision ¶33: "If contractors don't show, 6 will get contractors that do."
 *
 * Sent when the primary contractor no-shows and 6 is looking for a
 * same-day substitute. Distinct from crew.invitation.v1 in tone and
 * urgency: this is "we need someone in the next few hours", not "here's
 * a lead for tomorrow". First accept locks it in.
 */

export type ContractorUrgentDispatchData = {
  recipientName?: string | null;
  category: string;
  homeownerFirstName?: string | null;
  neededAtText: string;
  distanceKm: number;
  agenda?: string | null;
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

function humanCategory(slug: string): string {
  return slug.replace(/_/g, " ");
}

const contractorUrgentDispatchTemplate: NotificationTemplate<ContractorUrgentDispatchData> = {
  id: "contractor.urgent_dispatch.v1",
  contentType: "transactional",

  renderEmail: (data): EmailRendered => {
    const name = firstName(data.recipientName);
    const cat = humanCategory(data.category);
    const homeowner = data.homeownerFirstName?.trim() || "a homeowner";
    const agendaBlock = data.agenda?.trim()
      ? `<p style="margin:8px 0"><strong>The job:</strong> ${escape(data.agenda)}</p>`
      : "";
    const subject = `Urgent: ${cat} needed ${data.neededAtText}`;
    const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:24px auto;line-height:1.5;color:#18181b">
  <div style="border-top:4px solid #dc2626;padding-top:16px">
    <p style="margin:0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#dc2626">iSolveUrProblems · Urgent dispatch</p>
    <h2 style="margin:6px 0 0;font-size:20px">${escape(subject)}</h2>
  </div>
  <p>Hi ${escape(name)},</p>
  <p>The ${escape(cat)} originally scheduled for ${escape(homeowner)} didn't show. We're looking for a same-day replacement — you're about <strong>${data.distanceKm} km</strong> away and same-day capable.</p>
  ${agendaBlock}
  <p><strong>First to accept wins the job.</strong> Reply from your dashboard.</p>
  <p style="margin-top:20px"><a href="${escape(data.dashboardUrl)}" style="background:#dc2626;color:#ffffff;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600">Accept in dashboard</a></p>
  <p style="margin-top:24px;color:#71717a;font-size:12px">— 6</p>
</body></html>`;
    const text = `Hi ${name},

The ${cat} originally scheduled for ${homeowner} didn't show. Same-day replacement needed ${data.neededAtText} (~${data.distanceKm} km from you).
${data.agenda ? `Job: ${data.agenda}\n` : ""}
First to accept wins. Open your dashboard: ${data.dashboardUrl}

— 6`;
    return { subject, html, text };
  },

  renderSms: (data): SmsRendered => {
    const name = firstName(data.recipientName);
    const cat = humanCategory(data.category);
    const body = `Hi ${name}, urgent ${cat} needed ${data.neededAtText} (~${data.distanceKm} km). Original contractor no-showed. First to accept wins: ${data.dashboardUrl}`;
    return { body };
  },
};

export default contractorUrgentDispatchTemplate;
