/** Shared limits and validation for public API routes (abuse / injection hardening). */

const ALLOWED_ORIGINS = new Set([
  "https://isolveurproblems.ai",
  "https://www.isolveurproblems.ai",
]);

/**
 * Returns a 403 Response if the request origin is not allowed, otherwise null.
 * Skipped in non-production (local dev) and on Vercel Preview deployments
 * (branch previews have auto-generated domains that can't be pre-listed).
 * Production Vercel deployments still enforce the allowlist.
 */
export function assertAllowedOrigin(request: Request): Response | null {
  if (process.env.NODE_ENV !== "production") return null;
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== "production") {
    // Vercel Preview / Development — skip origin check so branch previews work.
    return null;
  }

  const origin = request.headers.get("origin");
  if (origin !== null) {
    if (ALLOWED_ORIGINS.has(origin)) return null;
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  const referer = request.headers.get("referer");
  if (referer !== null) {
    const ok = [...ALLOWED_ORIGINS].some((o) => referer.startsWith(o));
    if (ok) return null;
    return new Response(JSON.stringify({ error: "Forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  // No origin or referer in production — block direct API calls
  return new Response(JSON.stringify({ error: "Forbidden" }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}


export const MAX_OPENAI_USER_MESSAGE_CHARS = 16_000;
export const MAX_OPENAI_IMAGE_ANALYSIS_CHARS = 48_000;
export const MAX_ELEVENLABS_TEXT_CHARS = 5_000;
export const MAX_TRANSCRIPTION_TEXT_CHARS = 4_000;
export const MAX_TRANSCRIPTION_SESSION_ID_CHARS = 200;
export const MAX_ANALYZE_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_ANALYZE_IMAGE_QUESTION_CHARS = 2_000;
export const MAX_VIDEO_FRAMES = 24;
/** Max length of one base64 frame string (~1.5 MiB decoded). */
export const MAX_VIDEO_FRAME_BASE64_CHARS = 2_200_000;

const BEARER_TOKEN_MAX_LEN = 8192;

/**
 * Verify an `Authorization: Bearer <ADMIN_SECRET>` header in constant
 * time. Used by every /api/admin/* route — keep the comparison routed
 * through here so future routes can't accidentally regress to `===`.
 *
 * Returns `{ ok: true }` only when the header is present, well-formed,
 * and matches the configured secret. All failure modes collapse to
 * `{ ok: false }` without leaking which check failed.
 */
export function verifyAdminBearer(
  authHeader: string | null,
  adminSecret: string,
): { ok: boolean } {
  if (!adminSecret) return { ok: false };
  if (!authHeader || !authHeader.startsWith("Bearer ")) return { ok: false };
  const token = authHeader.slice(7).trim();
  if (!token) return { ok: false };
  if (token.length !== adminSecret.length) return { ok: false };
  // Constant-time XOR compare. Buffer.from + crypto.timingSafeEqual would
  // also work; the manual loop avoids importing node:crypto into this
  // edge-runtime-friendly module.
  let mismatch = 0;
  for (let i = 0; i < token.length; i++) {
    mismatch |= token.charCodeAt(i) ^ adminSecret.charCodeAt(i);
  }
  return { ok: mismatch === 0 };
}

/** Reject C0 controls, DEL, and Unicode line/paragraph separators (CRLF header injection). */
function isUnsafeBearerTokenChar(code: number): boolean {
  if (code <= 0x1f || code === 0x7f) return true;
  return code === 0x2028 || code === 0x2029;
}

function bearerTokenHasUnsafeChars(t: string): boolean {
  for (let i = 0; i < t.length; i++) {
    if (isUnsafeBearerTokenChar(t.charCodeAt(i))) return true;
  }
  return false;
}

/** ElevenLabs voice id: alphanumeric, typical length ~20. */
const SAFE_VOICE_ID = /^[a-zA-Z0-9_-]{10,128}$/;

const ALLOWED_IMAGE_MIMES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export function truncateUtf8String(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return input.slice(0, maxChars);
}

/**
 * Returns a safe bearer token or null. Blocks CRLF/control chars and oversized values;
 * allows any other characters (JWT, opaque ASCII, or Unicode) that APIs may issue.
 */
export function parseSafeBearerToken(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t || t.length > BEARER_TOKEN_MAX_LEN) return null;
  if (bearerTokenHasUnsafeChars(t)) return null;
  return t;
}

/**
 * Validates `Authorization: Bearer <token>` and returns the token, or null.
 */
export function sessionTokenFromRequestAuthHeader(
  authHeader: string | null,
): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return parseSafeBearerToken(authHeader.slice(7));
}

/** Rebuild header so only a validated token is forwarded upstream. */
export function authorizationBearerHeader(token: string): string {
  return `Bearer ${token}`;
}

export function isAllowedImageMime(mime: string): boolean {
  const m = mime.split(";")[0]?.trim().toLowerCase() || "";
  return ALLOWED_IMAGE_MIMES.has(m);
}

export function isSafeElevenLabsVoiceId(voiceId: unknown): voiceId is string {
  return typeof voiceId === "string" && SAFE_VOICE_ID.test(voiceId);
}

const BASE64_CHUNK = /^[A-Za-z0-9+/]*={0,2}$/;
// LiveAvatar/HeyGen ids can contain punctuation beyond UUID-ish `-_`.
// Keep this aligned with /api/auth/link-session so account rows, transcript sync,
// and post-auth re-keying all accept the same session id shape.
const SAFE_TRANSCRIPTION_SESSION_ID = /^[a-zA-Z0-9_\-:.]{8,200}$/;

export function isReasonableBase64Frame(s: unknown): s is string {
  if (typeof s !== "string" || s.length === 0) return false;
  if (s.length > MAX_VIDEO_FRAME_BASE64_CHARS) return false;
  if (s.length % 4 !== 0) return false;
  return BASE64_CHUNK.test(s);
}

export function isSafeTranscriptionSessionId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const v = value.trim();
  if (v.length < 8 || v.length > MAX_TRANSCRIPTION_SESSION_ID_CHARS) {
    return false;
  }
  return SAFE_TRANSCRIPTION_SESSION_ID.test(v);
}
