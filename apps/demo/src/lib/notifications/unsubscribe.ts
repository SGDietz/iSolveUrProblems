import crypto from "node:crypto";
import { getSupabaseAdminConfig } from "../supabaseAdmin";
import type { NotificationChannel } from "./types";

const CONSENT_KEY: Record<NotificationChannel, string> = {
  email: "email_consent",
  sms: "sms_consent",
  whatsapp: "whatsapp_consent",
};

/**
 * Signs and verifies one-click unsubscribe links. Derived from
 * SUPABASE_SERVICE_ROLE_KEY with a domain-separation label rather than a
 * dedicated secret — one fewer env var to provision, and the derived key
 * is still only ever computed server-side.
 */
function signingKey(): string {
  const { serviceRoleKey } = getSupabaseAdminConfig();
  return crypto
    .createHmac("sha256", serviceRoleKey)
    .update("notifications:unsubscribe:v1")
    .digest("hex");
}

export function signUnsubscribeToken(userId: string, channel: NotificationChannel): string {
  return crypto
    .createHmac("sha256", signingKey())
    .update(`${userId}:${channel}`)
    .digest("base64url");
}

export function verifyUnsubscribeToken(
  userId: string,
  channel: NotificationChannel,
  token: string,
): boolean {
  const expected = signUnsubscribeToken(userId, channel);
  const a = Buffer.from(expected);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Build a one-click unsubscribe URL for a specific user + channel.
 * `origin` should be the request's own origin (or PUBLIC_APP_ORIGIN) —
 * never hardcode the domain here, mirrors the rest of the app's origin
 * handling.
 */
export function buildUnsubscribeUrl(
  origin: string,
  userId: string,
  channel: NotificationChannel,
): string {
  const token = signUnsubscribeToken(userId, channel);
  const params = new URLSearchParams({ u: userId, c: channel, t: token });
  return `${origin.replace(/\/$/, "")}/api/notifications/unsubscribe?${params.toString()}`;
}

/**
 * The single place that actually flips a channel's consent flag. Called
 * by both the email unsubscribe link (API route) and the voice intent
 * ("stop emailing me") — one source of truth so the two paths can never
 * drift out of sync with each other.
 *
 * Read-merge-write into users.preferred_channels, same jsonb shape as
 * app/api/user/preferences/route.ts already uses for sms_consent /
 * whatsapp_consent.
 */
export async function setChannelConsent(
  userId: string,
  channel: NotificationChannel,
  consent: boolean,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return { ok: false, error: "supabase not configured" };
  }

  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };

  const cur = await fetch(
    `${url}/rest/v1/users?id=eq.${encodeURIComponent(userId)}&select=preferred_channels&limit=1`,
    { method: "GET", headers },
  );
  if (!cur.ok) {
    return { ok: false, error: `lookup failed: ${cur.status}` };
  }
  const rows = (await cur.json().catch(() => [])) as Array<{
    preferred_channels: Record<string, unknown> | null;
  }>;
  if (rows.length === 0) {
    return { ok: false, error: "user not found" };
  }
  const existing = rows[0]?.preferred_channels ?? {};
  const updated = { ...existing, [CONSENT_KEY[channel]]: consent };

  const res = await fetch(`${url}/rest/v1/users?id=eq.${encodeURIComponent(userId)}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ preferred_channels: updated }),
  });
  if (!res.ok) {
    return { ok: false, error: `update failed: ${res.status}` };
  }
  return { ok: true };
}

/**
 * True when the channel is explicitly opted out. Default (key absent,
 * or explicitly true) is opted IN — matches the existing sms_consent /
 * whatsapp_consent default-on behavior elsewhere in this app.
 */
export function isChannelOptedOut(
  preferredChannels: Record<string, unknown> | null | undefined,
  channel: NotificationChannel,
): boolean {
  if (!preferredChannels) return false;
  return preferredChannels[CONSENT_KEY[channel]] === false;
}

/**
 * Fetch just the preferred_channels jsonb for a user. Fails soft (null)
 * so callers can treat "couldn't check" the same as "no preference set"
 * rather than blocking a send on a transient lookup error.
 */
export async function getPreferredChannels(
  userId: string,
): Promise<Record<string, unknown> | null> {
  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return null;
  }
  try {
    const res = await fetch(
      `${url}/rest/v1/users?id=eq.${encodeURIComponent(userId)}&select=preferred_channels&limit=1`,
      {
        method: "GET",
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ preferred_channels: Record<string, unknown> | null }>;
    return rows[0]?.preferred_channels ?? null;
  } catch {
    return null;
  }
}
