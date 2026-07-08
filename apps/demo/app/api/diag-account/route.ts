import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin, truncateUtf8String } from "../../../src/lib/apiRouteSecurity";

export const dynamic = "force-dynamic";
export const maxDuration = 5;

const MAX_KEYS = 24;
const MAX_VALUE_CHARS = 160;

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return truncateUtf8String(value.replace(/\s+/g, " ").trim(), MAX_VALUE_CHARS);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return value;
  }
  if (Array.isArray(value)) return `[array:${value.length}]`;
  if (typeof value === "object") return "[object]";
  return String(value).slice(0, MAX_VALUE_CHARS);
}

function sanitizePayload(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw).slice(0, MAX_KEYS)) {
    const safeKey = truncateUtf8String(key.replace(/[^a-zA-Z0-9_.:-]/g, "_"), 64);
    if (/token|secret|password|authorization|cookie|email|phone|name/i.test(safeKey)) {
      out[safeKey] = "[redacted]";
      continue;
    }
    out[safeKey] = sanitizeValue(value);
  }
  return out;
}

export async function POST(request: NextRequest) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;

  let payload: unknown = null;
  try {
    payload = await request.json();
  } catch {
    payload = null;
  }

  const env = process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "development";
  if (env !== "production") {
    console.info("[diag-account]", sanitizePayload(payload));
  }

  return NextResponse.json({ ok: true });
}
