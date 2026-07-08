import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseAdminConfig } from "../../../../../src/lib/supabaseAdmin";
import { getContractByEnvelopeId } from "../../../../../src/lib/payments";
import type { EsignEnvelopeStatus } from "../../../../../src/lib/esign";
import { mapDropboxStatus } from "../../../../../src/lib/esign/providers/dropbox-sign";
import {
  DROPBOX_SIGN_API_KEY,
} from "../../../../api/secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/webhooks/esign/[provider] (M3.7)
 *
 * Generic e-signature webhook sink. The provider-name URL segment lets
 * us add real providers (dropbox_sign, docusign) without changing the
 * route shape — each provider's signature verification + payload parsing
 * happens in its branch below.
 *
 * v1 ships with the `mock` provider, which:
 *   - Accepts any payload shape: { envelope_id, status, role?, signed_at? }
 *   - No signature verification (mock is dev-only)
 *   - Updates the matching contracts row
 *
 * When SG Dietz hands over Dropbox Sign sandbox keys, add a `dropbox_sign`
 * branch with HMAC signature verification (mirrors the Stripe webhook
 * pattern in apps/demo/app/api/webhooks/stripe/route.ts).
 */

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

type EsignWebhookPayload = {
  envelope_id?: unknown;
  status?: unknown;
  role?: unknown;       // "user" | "contractor"
  signed_at?: unknown;  // ISO string
};

const VALID_STATUSES: EsignEnvelopeStatus[] = [
  "draft",
  "sent",
  "awaiting_signature",
  "signed",
  "declined",
  "cancelled",
  "expired",
];

async function patchContractByEnvelope(args: {
  envelope_id: string;
  status: EsignEnvelopeStatus | null;
  role: "user" | "contractor" | null;
  signed_at: string | null;
}): Promise<void> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const payload: Record<string, unknown> = {};
  if (args.status) payload.esign_envelope_status = args.status;
  if (args.role && args.signed_at) {
    if (args.role === "user") payload.signed_at_user = args.signed_at;
    else payload.signed_at_contractor = args.signed_at;
  }
  if (Object.keys(payload).length === 0) return;
  await fetch(
    `${url}/rest/v1/contracts?esign_envelope_id=eq.${encodeURIComponent(
      args.envelope_id,
    )}`,
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
}

/**
 * Dropbox Sign signs its webhook payload as HMAC-SHA256 of
 * `<event_time><event_type>` using the API key as the secret. The
 * payload arrives as form-encoded `json=<stringified-json>` per
 * https://developers.hellosign.com/api/eventsAndCallbacks/eventsAndCallbacks/#callback-event-hash
 *
 * If the API key isn't set we cannot verify — reject so we don't
 * accept spoofed events.
 */
function verifyDropboxSignWebhook(args: {
  event_time: string;
  event_type: string;
  event_hash: string;
}): boolean {
  if (!DROPBOX_SIGN_API_KEY) return false;
  const expected = createHmac("sha256", DROPBOX_SIGN_API_KEY)
    .update(args.event_time + args.event_type)
    .digest("hex");
  const a = Buffer.from(args.event_hash, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

type DropboxSignWebhookPayload = {
  event: {
    event_time: string;
    event_type: string;
    event_hash: string;
  };
  signature_request?: {
    signature_request_id: string;
    is_complete?: boolean;
    is_declined?: boolean;
    has_error?: boolean;
    signatures?: Array<{
      signer_email_address?: string;
      signer_role?: string;
      signed_at?: number; // unix
      status_code?: string;
    }>;
  };
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider } = await context.params;
  const validProviders = new Set(["mock", "dropbox_sign"]);
  if (!validProviders.has(provider)) {
    return bad(`unknown provider: ${provider}`, 404);
  }

  // ─── Dropbox Sign ─────────────────────────────────────────────────
  if (provider === "dropbox_sign") {
    // Dropbox Sign sends form-encoded body: `json=<stringified-json>`
    // and expects the verbatim string "Hello API Event Received" back
    // (200). They retry on anything else.
    let parsed: DropboxSignWebhookPayload;
    try {
      const text = await request.text();
      const params = new URLSearchParams(text);
      const jsonStr = params.get("json");
      if (!jsonStr) return bad("missing json field");
      parsed = JSON.parse(jsonStr) as DropboxSignWebhookPayload;
    } catch {
      return bad("invalid Dropbox Sign payload");
    }

    if (
      !verifyDropboxSignWebhook({
        event_time: parsed.event.event_time,
        event_type: parsed.event.event_type,
        event_hash: parsed.event.event_hash,
      })
    ) {
      return bad("dropbox_sign signature verification failed", 401);
    }

    const sr = parsed.signature_request;
    if (!sr?.signature_request_id) {
      // Some event types don't include a signature_request — just ack.
      return new NextResponse("Hello API Event Received", { status: 200 });
    }

    const contract = await getContractByEnvelopeId(sr.signature_request_id);
    if (!contract) {
      return new NextResponse("Hello API Event Received", { status: 200 });
    }

    const status = mapDropboxStatus({
      is_complete: sr.is_complete,
      is_declined: sr.is_declined,
      has_error: sr.has_error,
    });

    // Find the per-role signed_at timestamp (if any signature in this
    // event has signed_at set, it's the one that just signed).
    let role: "user" | "contractor" | null = null;
    let signed_at_iso: string | null = null;
    for (const sig of sr.signatures ?? []) {
      if (sig.signed_at && sig.signer_role) {
        if (sig.signer_role === "user" || sig.signer_role === "contractor") {
          role = sig.signer_role;
          signed_at_iso = new Date(sig.signed_at * 1000).toISOString();
          break;
        }
      }
    }

    await patchContractByEnvelope({
      envelope_id: sr.signature_request_id,
      status,
      role,
      signed_at: signed_at_iso,
    });

    // Dropbox Sign requires this exact response body.
    return new NextResponse("Hello API Event Received", { status: 200 });
  }

  // ─── Mock provider (dev-only) ─────────────────────────────────────

  // HARD prod gate (Herm ship-blocker 2026-07-02): the mock branch has no
  // signature verification, so in production it was an unauthenticated
  // contract-state write. Mock e-sign exists for dev/preview wiring only —
  // same fail-closed doctrine as getEsignProvider().
  if (process.env.VERCEL_ENV === "production") {
    return bad("mock e-sign webhook is disabled in production", 404);
  }

  let body: EsignWebhookPayload;
  try {
    body = (await request.json()) as EsignWebhookPayload;
  } catch {
    return bad("invalid JSON");
  }

  if (typeof body.envelope_id !== "string" || body.envelope_id.trim() === "") {
    return bad("envelope_id is required");
  }

  const contract = await getContractByEnvelopeId(body.envelope_id);
  if (!contract) {
    return NextResponse.json({ ok: true, no_match: true });
  }

  const status =
    typeof body.status === "string" &&
    (VALID_STATUSES as string[]).includes(body.status)
      ? (body.status as EsignEnvelopeStatus)
      : null;
  const role =
    body.role === "user" || body.role === "contractor" ? body.role : null;
  const signed_at =
    typeof body.signed_at === "string" ? body.signed_at : null;

  await patchContractByEnvelope({
    envelope_id: body.envelope_id,
    status,
    role,
    signed_at,
  });

  return NextResponse.json({ ok: true });
}
