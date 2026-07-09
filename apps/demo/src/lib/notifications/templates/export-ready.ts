import type { NotificationTemplate, EmailRendered } from "../types";

/**
 * "Your data download link" — sent when the user asks 6 to export their
 * data ("download my data"). The link is a signed, 24-hour token URL to
 * /api/account/download; the page it opens shows checkboxes only, never
 * data (see src/lib/account/exportData.ts). Email-only on purpose — a
 * download link belongs in the inbox that proves the identity.
 */
export type ExportReadyData = {
  downloadUrl: string;
};

const exportReadyTemplate: NotificationTemplate<ExportReadyData> = {
  id: "export.ready.v1",
  contentType: "transactional",

  renderEmail: (data): EmailRendered => {
    return {
      subject: "Your iSolveUrProblems data — download link",
      html: `<!doctype html>
<html><body style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:24px auto;line-height:1.5;color:#18181b">
  <div style="border-top:4px solid #facc15;padding-top:12px">
    <div style="font-size:11px;letter-spacing:1.5px;text-transform:uppercase;color:#52525b">iSolveUrProblems &middot; Your Data</div>
    <h2 style="margin:6px 0 0;font-size:22px">Here's your copy</h2>
  </div>
  <p>You asked me for a copy of your data, so here it is. Click the button, pick what you want, and it downloads as a plain text file.</p>
  <p style="margin:24px 0">
    <a href="${data.downloadUrl}" style="background:#facc15;color:#18181b;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block">Download my data &rarr;</a>
  </p>
  <p style="font-size:13px;color:#52525b">This link works for 24 hours. Nothing shows or downloads until you click the button on that page. Didn't ask for this? Just ignore this email — nothing gets downloaded.</p>
  <p>&mdash; 6</p>
</body></html>`,
      text: `Here's your copy\n\nYou asked me for a copy of your data, so here it is. Open the link, pick what you want, and it downloads as a plain text file.\n\n${data.downloadUrl}\n\nThis link works for 24 hours. Nothing shows or downloads until you click the button on that page. Didn't ask for this? Just ignore this email — nothing gets downloaded.\n\n— 6`,
    };
  },
};

export default exportReadyTemplate;
