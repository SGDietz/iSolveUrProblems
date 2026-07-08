import type { EmailRendered, NotificationTemplate } from "../types";

export type HomeownerContractorIntroData = {
  contractorName: string;
  homeownerName: string;
  homeownerEmail: string;
  message?: string | null;
  category?: string | null;
  homeownerLocation?: string | null;
};

function firstName(full: string): string {
  return full.trim().split(/\s+/)[0] || "there";
}

function safeText(value?: string | null): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const homeownerContractorIntroTemplate: NotificationTemplate<HomeownerContractorIntroData> = {
  id: "homeowner.contractor_intro.v1",
  contentType: "transactional",

  renderEmail: (data): EmailRendered => {
    const contractorName = safeText(data.contractorName) || "there";
    const homeownerName = safeText(data.homeownerName) || "a homeowner";
    const homeownerEmail = safeText(data.homeownerEmail);
    const category = safeText(data.category);
    const homeownerLocation = safeText(data.homeownerLocation);
    const message = safeText(data.message);
    const subject = category
      ? `${homeownerName} asked iSolve about ${category}`
      : `${homeownerName} asked iSolve to connect`;

    const detailBits = [
      category ? `Job type: ${category}` : "",
      homeownerLocation ? `Area: ${homeownerLocation}` : "",
    ].filter(Boolean);
    const detailHtml = detailBits.length
      ? `<ul>${detailBits.map((bit) => `<li>${escapeHtml(bit)}</li>`).join("")}</ul>`
      : "";
    const noteHtml = message
      ? `<blockquote style="border-left:4px solid #facc15;margin:18px 0;padding:10px 14px;background:#fefce8;color:#3f2a05">${escapeHtml(message)}</blockquote>`
      : "";

    const html = `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:24px auto;line-height:1.5;color:#18181b">
  <div style="border-top:4px solid #facc15;padding-top:16px">
    <p style="margin:0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#a16207">iSolveUrProblems · Homeowner request</p>
    <h2 style="margin:6px 0 0;font-size:22px">Hi ${escapeHtml(firstName(contractorName))}, ${escapeHtml(homeownerName)} wants to connect</h2>
  </div>
  <p>${escapeHtml(homeownerName)} asked 6 from iSolveUrProblems to reach out about a possible job.</p>
  ${detailHtml}
  ${noteHtml}
  <p>You can reply directly to the homeowner at <a href="mailto:${escapeHtml(homeownerEmail)}">${escapeHtml(homeownerEmail)}</a>.</p>
  <p style="font-size:13px;color:#52525b">This was sent only after the homeowner tapped the Email button in iSolve. — 6</p>
</body></html>`;

    const text = `Hi ${firstName(contractorName)}, ${homeownerName} asked 6 from iSolveUrProblems to connect you about a possible job.

${detailBits.length ? `${detailBits.join("\n")}\n\n` : ""}${message ? `Homeowner note: ${message}\n\n` : ""}Reply directly to the homeowner at ${homeownerEmail}.

This was sent only after the homeowner tapped the Email button in iSolve.

— 6`;

    return { subject, html, text };
  },
};

export default homeownerContractorIntroTemplate;
