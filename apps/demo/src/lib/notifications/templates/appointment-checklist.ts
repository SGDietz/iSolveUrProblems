import type {
  NotificationTemplate,
  EmailRendered,
  SmsRendered,
  WhatsappRendered,
} from "../types";

/**
 * M4.3 — Pre-departure checklist notification.
 *
 * Vision ¶24: "rarely forget a tool or the right materials."
 *
 * Sent to the CONTRACTOR ~2h before the appointment, alongside the
 * existing M3.5 reminder. Contains the generated items inline plus a
 * deep link to the dashboard where they can check things off.
 */

export type ChecklistItemForTemplate = {
  kind: "tool" | "material" | "confirmation";
  text: string;
};

export type AppointmentChecklistData = {
  recipientName?: string | null;
  /** Human-readable local time (same shape as the reminder template). */
  whenText: string;
  /** Short description of what the meeting is for. */
  agenda?: string | null;
  /** Items grouped by kind in the renderer. */
  items: ChecklistItemForTemplate[];
  /** Deep link to the contractor dashboard's checklist tile. */
  dashboardUrl: string;
};

function firstName(full?: string | null): string {
  if (!full) return "there";
  return full.split(/\s+/)[0] || "there";
}

function bucketLabel(kind: ChecklistItemForTemplate["kind"]): string {
  switch (kind) {
    case "tool":
      return "Tools";
    case "material":
      return "Materials";
    case "confirmation":
      return "Confirm before you go";
  }
}

function groupByKind(items: ChecklistItemForTemplate[]) {
  return {
    tool: items.filter((i) => i.kind === "tool"),
    material: items.filter((i) => i.kind === "material"),
    confirmation: items.filter((i) => i.kind === "confirmation"),
  };
}

const appointmentChecklistTemplate: NotificationTemplate<AppointmentChecklistData> = {
  id: "appointment.checklist.v1",
  contentType: "transactional",

  renderEmail: (data): EmailRendered => {
    const name = firstName(data.recipientName);
    const buckets = groupByKind(data.items);
    const renderList = (label: string, items: ChecklistItemForTemplate[]) => {
      if (items.length === 0) return "";
      const lis = items
        .map((i) => `<li style="margin:4px 0">${escape(i.text)}</li>`)
        .join("");
      return `<h3 style="margin:16px 0 4px;font-size:14px;color:#3f3f46">${escape(
        label,
      )}</h3><ul style="margin:0;padding-left:20px">${lis}</ul>`;
    };
    const agendaLine = data.agenda?.trim()
      ? `<p>Job: <strong>${escape(data.agenda)}</strong></p>`
      : "";
    const subject = `Pre-departure checklist — your job ${data.whenText}`;
    const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:24px auto;line-height:1.5;color:#18181b">
  <div style="border-top:4px solid #facc15;padding-top:16px">
    <p style="margin:0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#52525b">iSolveUrProblems · Pre-departure Checklist</p>
    <h2 style="margin:6px 0 0;font-size:22px">Heads up ${escape(name)} — your job is ${escape(data.whenText)}</h2>
  </div>
  ${agendaLine}
  ${renderList(bucketLabel("tool"), buckets.tool)}
  ${renderList(bucketLabel("material"), buckets.material)}
  ${renderList(bucketLabel("confirmation"), buckets.confirmation)}
  <p style="margin-top:20px"><a href="${escape(data.dashboardUrl)}" style="background:#facc15;color:#18181b;text-decoration:none;padding:10px 16px;border-radius:6px;font-weight:600">Open checklist in dashboard</a></p>
  <p style="margin-top:24px;color:#71717a;font-size:12px">— 6. Check items off on the dashboard as you load the truck.</p>
</body></html>`;
    const text = `Hey ${name},

Pre-departure checklist for your job ${data.whenText}.
${data.agenda ? `Job: ${data.agenda}\n` : ""}
${data.items.map((i) => `[ ] (${i.kind}) ${i.text}`).join("\n")}

Open on dashboard: ${data.dashboardUrl}

— 6`;
    return { subject, html, text };
  },

  renderSms: (data): SmsRendered => {
    const name = firstName(data.recipientName);
    const top = data.items
      .slice(0, 3)
      .map((i) => `• ${i.text}`)
      .join("\n");
    const extra =
      data.items.length > 3
        ? `\n…and ${data.items.length - 3} more — ${data.dashboardUrl}`
        : `\n${data.dashboardUrl}`;
    const body = `Hi ${name}, pre-departure checklist for your ${data.whenText} job:\n${top}${extra}\n— 6`;
    return { body };
  },

  renderWhatsapp: (data): WhatsappRendered => {
    return {
      template_name: `appointment_checklist_v1`,
      parameters: [
        firstName(data.recipientName),
        data.whenText,
        String(data.items.length),
        data.dashboardUrl,
      ],
    };
  },
};

function escape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export default appointmentChecklistTemplate;
