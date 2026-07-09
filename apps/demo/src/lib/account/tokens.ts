import crypto from "node:crypto";
import { getSupabaseAdminConfig } from "../supabaseAdmin";

/**
 * Signed tokens for the account data-rights email links (export download
 * + deletion cancel). Same pattern as notifications/unsubscribe.ts: keys
 * are derived from SUPABASE_SERVICE_ROLE_KEY with a domain-separation
 * label rather than a dedicated secret — one fewer env var to provision,
 * and the derived key is still only ever computed server-side. Stateless,
 * like an S3 presigned URL: the claims ride in the token, the HMAC stops
 * tampering, and `exp` enforces the TTL at verify time.
 */

/**
 * The ONLY action an email link is allowed to perform on a deletion is
 * "cancel" — a non-destructive click. There is deliberately NO
 * "delete-now" action and no route that could finalize a deletion early:
 * aiASAP shipped exactly that (a bare no-login GET that purged the
 * account on click — email-client link prefetch could fire it with zero
 * human intent), and G locked it out of this build 2026-07-08: "no early
 * delete ever correct." Deletion finalizes ONLY via the daily cron once
 * the 30-day clock runs out on its own.
 */
export type AccountAction = "cancel";

export type DownloadClaims = { uid: string; email: string | null; exp: number };
export type ActionClaims = {
  action: AccountAction;
  uid: string;
  exp: number;
};

const DOWNLOAD_TTL_MS = 24 * 60 * 60 * 1000; // link works for 24 hours
// Cancel links from the day-0 email must still work at the very end of
// the 30-day grace window, so the TTL runs a day past it.
const ACTION_TTL_MS = 31 * 24 * 60 * 60 * 1000;

function derivedKey(label: string): string {
  const { serviceRoleKey } = getSupabaseAdminConfig();
  return crypto.createHmac("sha256", serviceRoleKey).update(label).digest("hex");
}

function signClaims(claims: object, key: string): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function verifySignature(token: string, key: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return payload;
}

// ─── Export download token ──────────────────────────────────────────

export function signDownloadToken(
  uid: string,
  email: string | null,
  ttlMs: number = DOWNLOAD_TTL_MS,
): string {
  const claims: DownloadClaims = { uid, email, exp: Date.now() + ttlMs };
  return signClaims(claims, derivedKey("account:export-download:v1"));
}

export function verifyDownloadToken(token: string): DownloadClaims | null {
  const payload = verifySignature(token, derivedKey("account:export-download:v1"));
  if (!payload) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as DownloadClaims;
    if (!claims || typeof claims.uid !== "string" || typeof claims.exp !== "number") {
      return null;
    }
    if (Date.now() > claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}

// ─── Deletion action token (cancel only) ────────────────────────────

export function signActionToken(
  action: AccountAction,
  uid: string,
  ttlMs: number = ACTION_TTL_MS,
): string {
  const claims: ActionClaims = { action, uid, exp: Date.now() + ttlMs };
  return signClaims(claims, derivedKey("account:deletion-action:v1"));
}

/**
 * The `expectedAction` binding means a token minted for one action can
 * never be replayed against a route expecting another — even though only
 * one action exists today, the check keeps that property if more are
 * ever added.
 */
export function verifyActionToken(
  token: string,
  expectedAction: AccountAction,
): ActionClaims | null {
  const payload = verifySignature(token, derivedKey("account:deletion-action:v1"));
  if (!payload) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as ActionClaims;
    if (!claims || typeof claims.uid !== "string" || typeof claims.exp !== "number") {
      return null;
    }
    if (claims.action !== expectedAction) return null;
    if (Date.now() > claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}
