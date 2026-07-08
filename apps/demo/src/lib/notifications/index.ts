import type { Locale } from "../../i18n/routing";
import { defaultLocale } from "../../i18n/routing";
import { sendEmail } from "./channels/email";
import { sendSms } from "./channels/sms";
import { sendWhatsapp } from "./channels/whatsapp";
import { getTemplate } from "./templates";
import {
  insertNotification,
  updateNotificationById,
} from "./store";
import type {
  DeliveryResult,
  NotificationChannel,
  NotificationTemplate,
  NotificationContentType,
} from "./types";

export { resolveChannel } from "./resolver";
export type {
  NotificationChannel,
  NotificationContentType,
  DeliveryResult,
} from "./types";
export {
  updateNotificationByProviderId,
  updateNotificationById,
} from "./store";

/**
 * Render + dispatch a notification through a specific channel.
 *
 * Flow:
 *   1. Insert audit row with status='queued'
 *   2. Resolve + render template for the channel + locale
 *   3. Call channel implementation
 *   4. Patch row with provider_id + status='sent'/'failed'
 *
 * Caller picks the channel — use `resolveChannel()` first if you want
 * the preference logic. This split lets callers force a specific
 * channel (e.g. "send the magic link by email regardless of prefs").
 *
 * Failures never throw. Result is structured.
 */
export async function send<TData>(args: {
  channel: NotificationChannel;
  recipient: string;
  templateId: string;
  data: TData;
  userId?: string | null;
  sessionId?: string | null;
  locale?: Locale;
  isFallback?: boolean;
  /** Optional durable dedupe key. Duplicate active keys skip provider dispatch. */
  idempotencyKey?: string | null;
  /** Optional extra context echoed into notifications_sent.context. */
  context?: Record<string, unknown>;
}): Promise<DeliveryResult> {
  const locale: Locale = args.locale ?? defaultLocale;
  const template = getTemplate(args.templateId) as
    | NotificationTemplate<TData>
    | null;

  const insertResult = await insertNotification({
    user_id: args.userId ?? null,
    session_id: args.sessionId ?? null,
    channel: args.channel,
    recipient: args.recipient,
    template_id: args.templateId,
    locale,
    status: "queued",
    is_fallback: args.isFallback ?? false,
    idempotency_key: args.idempotencyKey ?? null,
    context: args.context ?? {},
  });
  if (insertResult.status === "duplicate") {
    return {
      ok: true,
      channel: args.channel,
      provider_id: "already-sent",
      row_id: insertResult.rowId ?? "already-sent",
    };
  }
  const rowId = insertResult.rowId;

  if (!template) {
    const error = `unknown template: ${args.templateId}`;
    await updateNotificationById(rowId, { status: "failed", error });
    return { ok: false, channel: args.channel, error, row_id: rowId };
  }

  // Render for the chosen channel.
  let providerResult:
    | { ok: true; providerId: string }
    | { ok: false; error: string };

  try {
    if (args.channel === "email") {
      if (!template.renderEmail) {
        providerResult = { ok: false, error: "template has no email variant" };
      } else {
        providerResult = await sendEmail({
          to: args.recipient,
          rendered: template.renderEmail(args.data, locale),
        });
      }
    } else if (args.channel === "sms") {
      if (!template.renderSms) {
        providerResult = { ok: false, error: "template has no sms variant" };
      } else {
        providerResult = await sendSms({
          to: args.recipient,
          rendered: template.renderSms(args.data, locale),
        });
      }
    } else if (args.channel === "whatsapp") {
      if (!template.renderWhatsapp) {
        providerResult = {
          ok: false,
          error: "template has no whatsapp variant",
        };
      } else {
        providerResult = await sendWhatsapp({
          to: args.recipient,
          rendered: template.renderWhatsapp(args.data, locale),
        });
      }
    } else {
      providerResult = { ok: false, error: "unknown channel" };
    }
  } catch (e) {
    providerResult = {
      ok: false,
      error: e instanceof Error ? e.message : "render/send threw",
    };
  }

  if (providerResult.ok) {
    await updateNotificationById(rowId, {
      status: "sent",
      provider_id: providerResult.providerId,
    });
    return {
      ok: true,
      channel: args.channel,
      provider_id: providerResult.providerId,
      row_id: rowId ?? "",
    };
  }

  await updateNotificationById(rowId, {
    status: "failed",
    error: providerResult.error,
  });
  return {
    ok: false,
    channel: args.channel,
    error: providerResult.error,
    row_id: rowId,
  };
}
