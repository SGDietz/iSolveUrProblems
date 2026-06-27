import { createHash } from "node:crypto";

const SUCCESS_CODE = 1000;

type UpstashOk = { result: unknown };
type UpstashErr = { error: string };
type PipelineRow = UpstashOk | UpstashErr;

function assertUpstashRow(row: PipelineRow): unknown {
  if ("error" in row && row.error) throw new Error(row.error);
  return (row as UpstashOk).result;
}

/** Single command: POST base URL with body `["CMD", ...args]`. */
async function redisCmd(command: (string | number)[]): Promise<unknown> {
  const base = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) throw new Error("Upstash Redis env not configured");
  const res = await fetch(base, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(command),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Upstash ${res.status}: ${t}`);
  }
  const json = (await res.json()) as PipelineRow;
  return assertUpstashRow(json);
}

/** Pipeline: POST `{base}/pipeline` with 2D command array. */
async function upstashPipeline(
  commands: (string | number)[][],
): Promise<unknown[]> {
  const base = process.env.UPSTASH_REDIS_REST_URL?.replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) throw new Error("Upstash Redis env not configured");
  const res = await fetch(`${base}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify(commands),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Upstash ${res.status}: ${t}`);
  }
  const json = (await res.json()) as PipelineRow[];
  return json.map((row) => assertUpstashRow(row));
}

let redisConfigured: boolean | undefined;

function isRedisConfigured(): boolean {
  if (redisConfigured !== undefined) return redisConfigured;
  const base = process.env.UPSTASH_REDIS_REST_URL?.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  redisConfigured = Boolean(base && token);
  return redisConfigured;
}

export function isLiveAvatarCreditLimitEnabled(): boolean {
  if (process.env.LIVEAVATAR_CREDIT_LIMIT_DISABLED === "1") return false;
  return isRedisConfigured();
}

export function getDailyCreditLimit(): number {
  const v = process.env.LIVEAVATAR_DAILY_CREDIT_LIMIT;
  if (v === undefined || v === "") return 1000;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1000;
}

export function getCreditsPerMinute(): number {
  const v = process.env.LIVEAVATAR_CREDITS_PER_MINUTE;
  if (v === undefined || v === "") return 2;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

export const OUT_OF_CREDITS_MESSAGE =
  "Today's usage limit has been reached. Please try again tomorrow.";

export function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function sessionTokenFromAuthHeader(
  auth: string | null,
): string | null {
  if (!auth?.startsWith("Bearer ")) return null;
  const t = auth.slice(7).trim();
  return t || null;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function isLiveAvatarSuccessPayload(data: unknown): boolean {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { code?: number }).code === SUCCESS_CODE
  );
}

export async function getCreditsUsedToday(): Promise<number> {
  if (!isRedisConfigured()) return 0;
  const key = `la:credits:${utcDayKey()}`;
  const v = await redisCmd(["GET", key]);
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : 0;
}

export async function assertCanMintSessionToken(): Promise<
  { ok: true } | { ok: false; message: string }
> {
  // Explicit opt-out (local/dev only): cap deliberately turned off via env.
  if (process.env.LIVEAVATAR_CREDIT_LIMIT_DISABLED === "1") return { ok: true };

  // MONEY GUARD (safety posture ported from aiASAP): when no credit store is
  // configured we cannot enforce the daily cap. FAIL CLOSED in production so the
  // live site can never mint uncapped paid LiveAvatar sessions. (Was fail-open.)
  if (!isLiveAvatarCreditLimitEnabled()) {
    if (process.env.NODE_ENV === "production") {
      return {
        ok: false,
        message:
          "Usage limit could not be verified. Please try again in a few minutes.",
      };
    }
    return { ok: true };
  }

  try {
    const used = await getCreditsUsedToday();
    const limit = getDailyCreditLimit();
    if (used >= limit) return { ok: false, message: OUT_OF_CREDITS_MESSAGE };
    return { ok: true };
  } catch {
    return {
      ok: false,
      message:
        "Usage limit could not be verified. Please try again in a few minutes.",
    };
  }
}

export async function recordSessionStreamStarted(
  sessionToken: string,
): Promise<void> {
  try {
    if (!isRedisConfigured() || process.env.LIVEAVATAR_CREDIT_LIMIT_DISABLED === "1")
      return;
    const key = `la:ses:${hashSessionToken(sessionToken)}`;
    const payload = JSON.stringify({ t: Date.now() });
    await redisCmd(["SET", key, payload, "EX", 172800]);
  } catch (e) {
    console.error("liveavatarCredits: recordSessionStreamStarted", e);
  }
}

export async function recordSessionStreamStopped(
  sessionToken: string,
): Promise<void> {
  try {
    if (!isRedisConfigured() || process.env.LIVEAVATAR_CREDIT_LIMIT_DISABLED === "1")
      return;
    const key = `la:ses:${hashSessionToken(sessionToken)}`;
    const raw = await redisCmd(["GET", key]);
    await redisCmd(["DEL", key]);
    if (raw == null) return;
    const s = typeof raw === "string" ? raw : String(raw);
    let started: number;
    try {
      started = JSON.parse(s).t as number;
    } catch {
      return;
    }
    if (!Number.isFinite(started)) return;
    const elapsedMs = Date.now() - started;
    const minutes = Math.max(1, Math.ceil(elapsedMs / 60_000));
    const credits = minutes * getCreditsPerMinute();
    const dayKey = `la:credits:${utcDayKey()}`;
    await upstashPipeline([
      ["INCRBY", dayKey, credits],
      ["EXPIRE", dayKey, 4 * 86_400],
    ]);
  } catch (e) {
    console.error("liveavatarCredits: recordSessionStreamStopped", e);
  }
}
