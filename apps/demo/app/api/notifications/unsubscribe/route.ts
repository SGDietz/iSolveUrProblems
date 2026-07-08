import { NextResponse, type NextRequest } from "next/server";
import { verifyUnsubscribeToken, setChannelConsent } from "../../../../src/lib/notifications/unsubscribe";
import type { NotificationChannel } from "../../../../src/lib/notifications/types";

const VALID_CHANNELS = new Set<NotificationChannel>(["email", "sms", "whatsapp"]);

function page(title: string, body: string, status: number): NextResponse {
  return new NextResponse(
    `<!doctype html><html><body style="font-family:system-ui,sans-serif;max-width:480px;margin:80px auto;text-align:center;line-height:1.5">
<h2>${title}</h2><p>${body}</p>
</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

/**
 * One-click unsubscribe link, the destination of the "Unsubscribe"
 * button appended to every outbound email (channels/email.ts). No auth
 * required by design — that's what makes it one-click — the HMAC
 * signature on `t` is what stops anyone from unsubscribing someone
 * else's address by guessing a URL.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const userId = searchParams.get("u");
  const channelParam = searchParams.get("c");
  const token = searchParams.get("t");

  if (!userId || !channelParam || !token || !VALID_CHANNELS.has(channelParam as NotificationChannel)) {
    return page("Link not valid", "This unsubscribe link is missing or malformed. Email us and we'll take care of it by hand.", 400);
  }
  const channel = channelParam as NotificationChannel;

  if (!verifyUnsubscribeToken(userId, channel, token)) {
    return page("Link not valid", "This unsubscribe link doesn't check out. Email us and we'll take care of it by hand.", 400);
  }

  const result = await setChannelConsent(userId, channel, false);
  if (!result.ok) {
    return page("Something went wrong", "We couldn't process this right now. Email us and we'll take care of it by hand.", 500);
  }

  return page(
    "You're unsubscribed",
    `You won't get any more ${channel === "email" ? "emails" : channel === "sms" ? "texts" : "WhatsApp messages"} from iSolveUrProblems.ai. You can turn it back on any time by telling 6, or from your account page.`,
    200,
  );
}
