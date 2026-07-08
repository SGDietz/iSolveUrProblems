import type { Locale } from "../../i18n/routing";

export type NotificationChannel = "email" | "sms" | "whatsapp";

export type NotificationStatus =
  | "queued"
  | "sent"
  | "failed"
  | "delivered"
  | "bounced"
  | "opened"
  | "clicked"
  | "spam"
  | "unsubscribed";

/** Logical content classes — drive channel selection in resolveChannel(). */
export type NotificationContentType =
  | "transactional"   // sign-in links, account events — email-first
  | "report"          // fix-it report delivery — user picks channel
  | "marketing";      // future — email-only by default

/** Rendered output per channel. */
export type EmailRendered = {
  subject: string;
  html: string;
  text?: string;
};

export type SmsRendered = {
  body: string;
};

/**
 * Meta-approved WhatsApp templates take a template_name and ordered
 * parameter list (mapped to {{1}}, {{2}}, ... placeholders). Free-text
 * messages are only allowed inside a 24-hour user-initiated window.
 */
export type WhatsappRendered = {
  template_name: string;
  parameters: string[];
};

/** A template knows how to render itself for each channel + locale. */
export type NotificationTemplate<TData = unknown> = {
  id: string;
  contentType: NotificationContentType;
  renderEmail?: (data: TData, locale: Locale) => EmailRendered;
  renderSms?: (data: TData, locale: Locale) => SmsRendered;
  renderWhatsapp?: (data: TData, locale: Locale) => WhatsappRendered;
};

export type DeliveryResult =
  | {
      ok: true;
      channel: NotificationChannel;
      provider_id: string;
      row_id: string;
    }
  | {
      ok: false;
      channel: NotificationChannel;
      error: string;
      row_id: string | null;
    };

/** Shape inserted into public.notifications_sent. */
export type NotificationRow = {
  user_id?: string | null;
  session_id?: string | null;
  channel: NotificationChannel;
  recipient: string;
  template_id: string;
  locale?: string | null;
  provider_id?: string | null;
  idempotency_key?: string | null;
  status: NotificationStatus;
  error?: string | null;
  is_fallback?: boolean;
  context?: Record<string, unknown>;
};

export type ResolvedChannel = {
  channel: NotificationChannel;
  recipient: string | null;
  usedFallback: boolean;
  /** Human-readable reason for fallback (logged into notifications_sent.context). */
  fallbackReason?: string;
};
