import {
  MAX_TRANSCRIPTION_TEXT_CHARS,
  truncateUtf8String,
} from "../apiRouteSecurity";
import { getSupabaseAdminConfig } from "../supabaseAdmin";

const TABLE = "feature_requests";
const TELEGRAM_API = "https://api.telegram.org";
const MAX_RAW_TEXT_CHARS = Math.min(MAX_TRANSCRIPTION_TEXT_CHARS, 2_000);
const MAX_REQUESTED_CHANNEL_CHARS = 80;
const MAX_CONTEXT_JSON_CHARS = 2_000;

export type FeatureRequestKind = "channel" | "feature" | "bug";

export type FeatureRequestCapture = {
  sessionId: string;
  userId?: string | null;
  kind?: FeatureRequestKind;
  rawText: string;
  requestedChannel?: string | null;
  source?: "voice" | "send_answer" | "contractor_email_pill" | "manual";
  context?: Record<string, unknown>;
  /** Default true. Set false for tests/backfills. */
  notify?: boolean;
};

export type FeatureRequestCaptureResult =
  | { ok: true; rowId: string | null; skipped?: boolean }
  | { ok: false; rowId: null; error: string };

const CHANNEL_ALIASES: Array<[RegExp, string]> = [
  [/\bwe\s*chat\b/i, "wechat"],
  [/\bsignal\b/i, "signal"],
  [/\bdiscord\b/i, "discord"],
  [/\bslack\b/i, "slack"],
  [/\btelegram\b/i, "telegram"],
  [/\bwhats\s*app\b/i, "whatsapp"],
  [/\b(?:sms|text(?:\s+message)?|text\s+me)\b/i, "sms"],
  [/\be[-\s]?mail\b/i, "email"],
  [/\bmessenger\b/i, "messenger"],
  [/\binstagram\b/i, "instagram"],
  [/\bfacebook\b/i, "facebook"],
];

const SUPPORTED_OR_GREENLIT_CHANNELS = new Set([
  "email",
  "sms",
  "whatsapp",
  "telegram",
]);

const BUG_WORD_RE =
  /\b(?:bug|broken|glitch|wrong|error|issue|not\s+working|doesn'?t\s+work|didn'?t\s+work|failed|stuck)\b/i;
const FEATURE_WORD_RE =
  /\b(?:feature\s+request|add\s+(?:a|an|the)?|can\s+you\s+add|could\s+you\s+add|wish\s+(?:you|it)\s+could|you\s+should\s+add|support\s+(?:for|this)|build\s+(?:a|the|that)?)\b/i;
const UI_TEXT_SIZE_REQUEST_RE =
  /\b(?:make|turn|bump|increase)\s+(?:the\s+)?(?:text|font|letters?|words?)\s+(?:bigger|larger|up)|\b(?:bigger|larger)\s+(?:text|font|letters?|words?)\b|\b(?:text|font)\s+size\b/i;
const INJECTED_CONTEXT_RE = /^\s*\[[^\]]{0,120}not spoken by user\]/i;
const SECRETISH_KEY_RE = /(?:secret|token|api[_-]?key|password|authorization|cookie|credential)/i;

function cleanText(value: string, maxChars: number): string {
  return truncateUtf8String(value.replace(/\s+/g, " ").trim(), maxChars);
}

export function detectRequestedChannel(rawText: string): string | null {
  for (const [pattern, channel] of CHANNEL_ALIASES) {
    if (pattern.test(rawText)) return channel;
  }
  return null;
}

export function detectFeatureRequestCapture(rawText: string):
  | { kind: FeatureRequestKind; requestedChannel: string | null; reason: string }
  | null {
  if (INJECTED_CONTEXT_RE.test(rawText)) return null;

  const requestedChannel = detectRequestedChannel(rawText);
  if (
    requestedChannel &&
    !SUPPORTED_OR_GREENLIT_CHANNELS.has(requestedChannel)
  ) {
    return { kind: "channel", requestedChannel, reason: "unsupported_channel" };
  }

  if (BUG_WORD_RE.test(rawText)) {
    return { kind: "bug", requestedChannel, reason: "bug_words" };
  }

  if (FEATURE_WORD_RE.test(rawText) || UI_TEXT_SIZE_REQUEST_RE.test(rawText)) {
    return { kind: "feature", requestedChannel, reason: UI_TEXT_SIZE_REQUEST_RE.test(rawText) ? "ui_text_size" : "feature_words" };
  }

  return null;
}

function safeContext(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (SECRETISH_KEY_RE.test(key)) continue;
    if (value === null || typeof value === "boolean" || typeof value === "number") {
      out[key] = value;
    } else if (typeof value === "string") {
      out[key] = cleanText(value, 300);
    }
  }
  const json = JSON.stringify(out);
  if (json.length <= MAX_CONTEXT_JSON_CHARS) return out;
  return { truncated: true };
}

function restHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function notifyFeatureRequest(args: {
  rowId: string | null;
  sessionId: string;
  kind: FeatureRequestKind;
  rawText: string;
  requestedChannel: string | null;
}): Promise<void> {
  const token = process.env.CLAUDE_TELEGRAM_TOKEN;
  const chatId = process.env.LEAD_ALERT_TELEGRAM_CHAT_ID ?? "1271337219";
  if (!token || !chatId) return;

  const lines = [
    "🧩 <b>iSolve feature request</b>",
    "",
    `<b>Kind:</b> ${escapeHtml(args.kind)}`,
    args.requestedChannel
      ? `<b>Channel:</b> ${escapeHtml(args.requestedChannel)}`
      : "",
    `<b>Session:</b> <code>${escapeHtml(args.sessionId.slice(-12))}</code>`,
    args.rowId ? `<b>Row:</b> <code>${escapeHtml(args.rowId.slice(0, 8))}</code>` : "",
    "",
    `<i>${escapeHtml(args.rawText)}</i>`,
  ].filter(Boolean);

  try {
    await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: lines.join("\n"),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch {
    // Alerting must never break the user-facing flow.
  }
}

export async function captureFeatureRequest(
  args: FeatureRequestCapture,
): Promise<FeatureRequestCaptureResult> {
  const sessionId = cleanText(args.sessionId, 200);
  const rawText = cleanText(args.rawText, MAX_RAW_TEXT_CHARS);
  if (!sessionId || !rawText || INJECTED_CONTEXT_RE.test(rawText)) {
    return { ok: true, rowId: null, skipped: true };
  }

  const detected = detectFeatureRequestCapture(rawText);
  const requestedChannel = cleanText(
    args.requestedChannel ?? detected?.requestedChannel ?? "",
    MAX_REQUESTED_CHANNEL_CHARS,
  ) || null;
  const kind = args.kind ?? detected?.kind ?? (requestedChannel ? "channel" : "feature");

  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return { ok: false, rowId: null, error: "supabase not configured" };
  }

  try {
    const res = await fetch(`${url}/rest/v1/${TABLE}`, {
      method: "POST",
      headers: restHeaders(serviceRoleKey),
      body: JSON.stringify([
        {
          session_id: sessionId,
          user_id: args.userId ?? null,
          kind,
          raw_text: rawText,
          requested_channel: requestedChannel,
          source: args.source ?? "voice",
          status: "new",
          context: safeContext(args.context),
        },
      ]),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("feature_requests.capture failed", res.status, text.slice(0, 180));
      return { ok: false, rowId: null, error: `insert failed (${res.status})` };
    }

    const rows = (await res.json()) as Array<{ id?: string }>;
    const rowId = rows[0]?.id ?? null;
    if (args.notify !== false) {
      void notifyFeatureRequest({
        rowId,
        sessionId,
        kind,
        rawText,
        requestedChannel,
      });
    }
    return { ok: true, rowId };
  } catch (e) {
    console.error("feature_requests.capture threw", e);
    return { ok: false, rowId: null, error: "insert threw" };
  }
}
