import { NextResponse, type NextRequest } from "next/server";
import { getUserId } from "../../../../src/lib/auth/getUser";
import { getSupabaseAdminConfig } from "../../../../src/lib/supabaseAdmin";
import { locales, type Locale } from "../../../../src/i18n/routing";
import { assertAllowedOrigin } from "../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../src/lib/rateLimit";

/**
 * Persist user preferences. Anonymous callers get a silent 204 — the
 * locale is still tracked in the URL + a next-intl cookie, so anonymous
 * UX is unaffected.
 *
 * Accepted fields (any subset):
 *   - preferred_locale: 'en'|'es'|'fr'|'pt'|'de'|'zh'
 *   - phone:            E.164 string ("+15551234567")
 *   - preferred_channels: {
 *       preferred?:      'email'|'sms'|'whatsapp',
 *       sms_consent?:    boolean,
 *       whatsapp_consent?: boolean
 *     }
 *
 * The preferred_channels patch is merged onto the existing jsonb (not
 * replaced) so callers can update one key at a time.
 */

const VALID_CHANNELS = new Set(["email", "sms", "whatsapp"] as const);

function isE164ish(s: unknown): s is string {
  return typeof s === "string" && /^\+?[0-9]{7,16}$/.test(s.trim());
}

type ChannelPatch = {
  preferred?: "email" | "sms" | "whatsapp";
  sms_consent?: boolean;
  whatsapp_consent?: boolean;
};

function validateChannelPatch(input: unknown): ChannelPatch | null {
  if (typeof input !== "object" || input === null) return null;
  const obj = input as Record<string, unknown>;
  const out: ChannelPatch = {};

  if (obj.preferred !== undefined) {
    if (
      typeof obj.preferred !== "string" ||
      !VALID_CHANNELS.has(obj.preferred as "email" | "sms" | "whatsapp")
    ) {
      return null;
    }
    out.preferred = obj.preferred as "email" | "sms" | "whatsapp";
  }
  if (obj.sms_consent !== undefined) {
    if (typeof obj.sms_consent !== "boolean") return null;
    out.sms_consent = obj.sms_consent;
  }
  if (obj.whatsapp_consent !== undefined) {
    if (typeof obj.whatsapp_consent !== "boolean") return null;
    out.whatsapp_consent = obj.whatsapp_consent;
  }
  return out;
}

export async function PATCH(request: NextRequest) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  const userId = await getUserId();
  if (!userId) {
    return new NextResponse(null, { status: 204 });
  }

  let body: {
    preferred_locale?: unknown;
    phone?: unknown;
    preferred_channels?: unknown;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const payload: Record<string, unknown> = {};

  if (typeof body.preferred_locale === "string") {
    if (!(locales as readonly string[]).includes(body.preferred_locale)) {
      return NextResponse.json(
        { error: `unsupported locale; valid: ${locales.join(", ")}` },
        { status: 400 },
      );
    }
    payload.preferred_locale = body.preferred_locale as Locale;
  }

  if (body.phone !== undefined) {
    if (body.phone === null || body.phone === "") {
      payload.phone = null;
    } else if (!isE164ish(body.phone)) {
      return NextResponse.json(
        { error: "phone must be E.164-ish digits" },
        { status: 400 },
      );
    } else {
      const cleaned = (body.phone as string).trim().replace(/[^+\d]/g, "");
      payload.phone = cleaned.startsWith("+") ? cleaned : `+${cleaned}`;
    }
  }

  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return NextResponse.json({ error: "supabase not configured" }, { status: 500 });
  }

  // preferred_channels requires a read-merge-write because we're patching
  // jsonb values key-by-key (PostgREST doesn't natively support `||` merge
  // via REST without RPC).
  if (body.preferred_channels !== undefined) {
    const patch = validateChannelPatch(body.preferred_channels);
    if (!patch) {
      return NextResponse.json(
        { error: "invalid preferred_channels" },
        { status: 400 },
      );
    }
    const cur = await fetch(
      `${url}/rest/v1/users?id=eq.${encodeURIComponent(userId)}&select=preferred_channels&limit=1`,
      {
        method: "GET",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      },
    );
    let existing: Record<string, unknown> = {};
    if (cur.ok) {
      const rows = (await cur.json()) as Array<{
        preferred_channels: Record<string, unknown> | null;
      }>;
      existing = rows[0]?.preferred_channels ?? {};
    }
    payload.preferred_channels = { ...existing, ...patch };
  }

  if (Object.keys(payload).length === 0) {
    return NextResponse.json({ ok: true, updated: 0 });
  }

  const res = await fetch(
    `${url}/rest/v1/users?id=eq.${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return NextResponse.json(
      { error: `update failed (${res.status}): ${detail}` },
      { status: 500 },
    );
  }
  return NextResponse.json({ ok: true });
}
