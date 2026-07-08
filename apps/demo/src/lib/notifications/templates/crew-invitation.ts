import type {
  NotificationTemplate,
  EmailRendered,
  SmsRendered,
} from "../types";

/**
 * M4.2 — Contractor-to-contractor "come help me on this job" invitation.
 *
 * Vision ¶24: "can find them new laborers and subcontractors when they
 * need help."
 *
 * Sent by the M4.2 fan-out to each ranked helper. Deep links to the
 * dashboard where they see Accept / Decline. First accept wins the
 * job (compare-and-swap in the requester's request row).
 */

export type CrewInvitationData = {
  recipientName?: string | null;
  requesterName: string;
  category: string;
  neededAtText: string;
  scope?: string | null;
  distanceKm: number;
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

const crewInvitationTemplate: NotificationTemplate<CrewInvitationData> = {
  id: "crew.invitation.v1",
  contentType: "transactional",

  renderEmail: (data): EmailRendered => {
    const name = firstName(data.recipientName);
    const cat = humanCategory(data.category);
    const scopeBlock = data.scope?.trim()
      ? `<p style="margin:8px 0"><strong>What's needed:</strong> ${escape(data.scope)}</p>`
      : "";
    const subject = `${data.requesterName} needs a ${cat} on ${data.neededAtText}`;
    const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:24px auto;line-height:1.5;color:#18181b">
  <div style="border-top:4px solid #facc15;padding-top:16px">
    <p style="margin:0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#52525b">iSolveUrProblems · Crew request</p>
    <h2 style="margin:6px 0 0;font-size:20px">${escape(subject)}</h2>
  </div>
  <p>Hi ${escape(name)},</p>
  <p><strong>${escape(data.requesterName)}</strong> is looking for a ${escape(cat)} to help on a job at <strong>${escape(data.neededAtText)}</strong>, about ${data.distanceKm} km from you.</p>
  ${scopeBlock}
  <p>First contractor to accept locks it in — the others get a pass. Reply from your dashboard.</p>
  <p style="margin-top:20px"><a href="${escape(data.dashboardUrl)}" style="background:#facc15;color:#18181b;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600">Open dashboard</a></p>
  <p style="margin-top:24px;color:#71717a;font-size:12px">— 6</p>
</body></html>`;
    const text = `Hi ${name},

${data.requesterName} needs a ${cat} on ${data.neededAtText}, ~${data.distanceKm} km from you.
${data.scope ? `Scope: ${data.scope}\n` : ""}
Accept or decline from your dashboard: ${data.dashboardUrl}

— 6`;
    return { subject, html, text };
  },

  renderSms: (data): SmsRendered => {
    const name = firstName(data.recipientName);
    const cat = humanCategory(data.category);
    const body = `Hi ${name}, ${data.requesterName} needs a ${cat} on ${data.neededAtText} (~${data.distanceKm} km). Accept in your dashboard: ${data.dashboardUrl}`;
    return { body };
  },
};

export default crewInvitationTemplate;
