import { NextResponse, type NextRequest } from "next/server";
import { verifyDownloadToken } from "../../../../src/lib/account/tokens";
import {
  buildExportFile,
  gatherUserExport,
  renderChooserHtml,
} from "../../../../src/lib/account/exportData";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/account/download?token=...            → the checkbox chooser page
 * GET /api/account/download?token=...&format=file&include=profile,history
 *                                                 → the plain-text data file
 *
 * The signed 24-hour token IS the authorization (unsubscribe-route
 * pattern — no login, works from any email client; the HMAC stops anyone
 * from downloading someone else's data by guessing a URL). Under /api/
 * the intl middleware skips this route entirely, so the emailed link
 * never gets locale-rewritten.
 *
 * A human clicked this from an email, so every response — including the
 * failures — is a small HTML page, never JSON. The chooser page renders
 * NO user data; the file only assembles after a deliberate click.
 */

function page(title: string, body: string, status: number): NextResponse {
  return new NextResponse(
    `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center;line-height:1.5">
<h2>${title}</h2><p>${body}</p>
</body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return page(
      "Link not valid",
      "This download link is missing its key. Ask 6 for a fresh one.",
      400,
    );
  }
  const claims = verifyDownloadToken(token);
  if (!claims) {
    return page(
      "Link expired",
      "This download link is invalid or has expired — they only work for 24 hours. Ask 6 for a fresh one.",
      401,
    );
  }

  if (url.searchParams.get("format") !== "file") {
    // The chooser. Nothing but the account email renders here.
    return new NextResponse(renderChooserHtml(claims.email), {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  }

  const payload = await gatherUserExport(claims.uid, claims.email);
  const inc = (url.searchParams.get("include") ?? "profile").toLowerCase();
  const file = buildExportFile(payload, {
    profile: inc.includes("profile"),
    history: inc.includes("history"),
  });
  const fname = `iSolveUrProblems-my-data-${payload.exported_at.slice(0, 10)}.txt`;
  return new NextResponse(file, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": `attachment; filename="${fname}"`,
      "Cache-Control": "no-store",
    },
  });
}
