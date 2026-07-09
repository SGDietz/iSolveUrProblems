import { NextResponse, type NextRequest } from "next/server";
import { verifyActionToken } from "../../../../src/lib/account/tokens";
import { cancelAccountDeletion } from "../../../../src/lib/account/deletionSchedule";

export const dynamic = "force-dynamic";

/**
 * The "Keep my account" button in every deletion email lands here. The
 * signed token IS the authorization (unsubscribe-route pattern), and
 * cancel is the ONLY action an email link can take on a deletion — the
 * destructive direction has no link, no route, no early path at all
 * (tokens.ts documents why).
 *
 * GET is render-only; the actual cancel happens on POST from the
 * one-button form the GET returns. Mail-security link scanners
 * (SafeLinks, Mimecast, corporate proxies) GET every URL in inbound
 * mail with zero human intent — a state-changing GET here would let a
 * robot silently reverse a deletion the user explicitly asked for
 * (RFC 8058 requires POST for one-click unsubscribe for the same
 * reason). Scanners don't submit forms; humans click one button.
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

function escAttr(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const INVALID_LINK = () =>
  page(
    "Link expired",
    'This link is invalid or has expired. You can still cancel by telling 6: "cancel the deletion."',
    401,
  );

export async function GET(request: NextRequest) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token || !verifyActionToken(token, "cancel")) {
    return INVALID_LINK();
  }
  // Render-only: one button, no state change until it's pressed.
  return new NextResponse(
    `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center;line-height:1.5">
<h2>Keep your account?</h2>
<p>Press the button and the scheduled deletion is canceled — your account and everything in it stays exactly as it is.</p>
<form method="POST" action="/api/account/cancel-deletion">
  <input type="hidden" name="token" value="${escAttr(token)}">
  <button type="submit" style="background:#facc15;color:#18181b;padding:12px 24px;border-radius:6px;border:none;font-weight:600;font-size:15px;cursor:pointer">Keep my account</button>
</form>
</body></html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    },
  );
}

export async function POST(request: NextRequest) {
  let token: string | null = null;
  try {
    const form = await request.formData();
    const raw = form.get("token");
    token = typeof raw === "string" ? raw : null;
  } catch {
    token = null;
  }
  if (!token) {
    return page(
      "Link not valid",
      'This link is missing its key. You can also just tell 6: "cancel the deletion."',
      400,
    );
  }
  const claims = verifyActionToken(token, "cancel");
  if (!claims) {
    return INVALID_LINK();
  }

  const result = await cancelAccountDeletion(claims.uid);
  if (!result.ok) {
    // A cancel link outliving its account isn't an error — the 30-day
    // clock already finished and the purge ran. Say so plainly instead
    // of a scary 500.
    if (result.error === "user not found") {
      return page(
        "This account is gone",
        "There's no account behind this link anymore — the deletion already finished. If that's a surprise, email us and we'll help.",
        410,
      );
    }
    return page(
      "Something went wrong",
      'We couldn\'t process this right now. Try again in a minute, or tell 6: "cancel the deletion."',
      500,
    );
  }

  return page(
    "You're all set 💛",
    result.hadSchedule
      ? "Your account is staying right where it is — we canceled the deletion and nothing was removed."
      : "There was no deletion scheduled on your account — everything is staying right where it is.",
    200,
  );
}
