import { NextResponse, type NextRequest } from "next/server";
import { getUser } from "../../../../../src/lib/auth/getUser";
import {
  getReportRow,
  signReportAssetUrl,
} from "../../../../../src/lib/reports";
import {
  resolveChannel,
  send,
} from "../../../../../src/lib/notifications";
import type {
  NotificationChannel,
  NotificationContentType,
} from "../../../../../src/lib/notifications/types";
import { defaultLocale, type Locale } from "../../../../../src/i18n/routing";
import type { ReportDeliveryData } from "../../../../../src/lib/notifications/templates/report-delivery";
import { assertAllowedOrigin } from "../../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../../src/lib/rateLimit";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    s,
  );
}

const VALID_CHANNELS = new Set<NotificationChannel>([
  "email",
  "sms",
  "whatsapp",
]);

/**
 * POST /api/reports/[id]/send
 *
 * Body (all optional):
 *   { channel?: 'email'|'sms'|'whatsapp', override_recipient?: string }
 *
 * If `channel` is omitted, resolveChannel() picks based on the user's
 * preferred_channels + consent state (Q1.7b — fail-open with logged
 * fallback). If `override_recipient` is provided it wins; otherwise we
 * use the on-profile email/phone.
 *
 * Always signs a fresh report link before sending so the recipient
 * never lands on an expired URL.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;
  const { id } = await params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const user = await getUser();
  if (!user) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const row = await getReportRow(id);
  if (!row || row.user_id !== user.id) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (row.status !== "ready") {
    return NextResponse.json(
      { error: `report not ready (status=${row.status})` },
      { status: 409 },
    );
  }
  if (!row.pdf_path) {
    return NextResponse.json(
      { error: "report has no pdf" },
      { status: 500 },
    );
  }

  let body: { channel?: unknown; override_recipient?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // empty body OK
  }

  // Resolve channel + recipient.
  const wantChannel =
    typeof body.channel === "string" &&
    VALID_CHANNELS.has(body.channel as NotificationChannel)
      ? (body.channel as NotificationChannel)
      : undefined;

  const resolved = await resolveChannel({
    userId: user.id,
    contentType: "report" satisfies NotificationContentType,
    override: wantChannel,
  });

  const recipient =
    typeof body.override_recipient === "string" && body.override_recipient
      ? body.override_recipient
      : resolved.recipient;

  if (!recipient) {
    return NextResponse.json(
      {
        ok: false,
        error: "no recipient available for the chosen channel",
        resolved,
      },
      { status: 400 },
    );
  }

  // Fresh signed URL for the report viewer (7-day TTL by default).
  // Per Q1.4a we send a link, not an attachment.
  const reportUrl = await signReportAssetUrl(row.pdf_path);
  if (!reportUrl) {
    return NextResponse.json(
      { error: "could not sign report url" },
      { status: 500 },
    );
  }

  const locale: Locale =
    (row.locale as Locale | undefined) ?? defaultLocale;

  const data: ReportDeliveryData = {
    recipientName: user.user_metadata?.full_name ?? user.email ?? null,
    reportTitle: row.title,
    reportUrl,
  };

  const result = await send({
    channel: resolved.channel,
    recipient,
    templateId: "report.delivery.v1",
    data,
    userId: user.id,
    sessionId: row.session_id,
    locale,
    isFallback: resolved.usedFallback,
    context: {
      report_id: row.id,
      ...(resolved.fallbackReason
        ? { fallback_reason: resolved.fallbackReason }
        : {}),
    },
  });

  return NextResponse.json({
    ...result,
    resolved_channel: resolved.channel,
    used_fallback: resolved.usedFallback,
    fallback_reason: resolved.fallbackReason ?? null,
  });
}
