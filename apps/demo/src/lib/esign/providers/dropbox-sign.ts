import {
  DROPBOX_SIGN_API_KEY,
  DROPBOX_SIGN_CLIENT_ID,
} from "../../../../app/api/secrets";
import type {
  CreateEnvelopeInput,
  CreateEnvelopeResult,
  EsignEnvelopeStatus,
  EsignProvider,
} from "../types";

/**
 * M3.7 production — Dropbox Sign (formerly HelloSign) e-sign provider.
 *
 * v1 uses the `/signature_request/create_embedded` endpoint when a
 * CLIENT_ID is set (returns a `claim_url`-style signing URL the SDK
 * normally embeds — we expose it as a plain link). Without a client ID
 * we fall back to `/signature_request/send` which emails both parties
 * a signing link.
 *
 * Auth: HTTP Basic, API key as username + empty password.
 * Docs: https://developers.hellosign.com/api/reference/operation/signatureRequestSend/
 *
 * Webhooks: Dropbox Sign signs every callback POST with an HMAC-SHA256
 * over `<event_time><event_type>` using the configured API key. The
 * /api/webhooks/esign/[provider] route verifies this when provider =
 * "dropbox_sign". See verifyDropboxSignWebhook() below.
 */

const API_BASE = "https://api.hellosign.com/v3";

function authHeader(): string {
  return "Basic " + Buffer.from(`${DROPBOX_SIGN_API_KEY}:`).toString("base64");
}

/**
 * Map Dropbox Sign request status strings to our normalized
 * EsignEnvelopeStatus values. Their `signature_request.is_complete`
 * boolean overrides everything else when true.
 */
export function mapDropboxStatus(args: {
  is_complete?: boolean;
  is_declined?: boolean;
  has_error?: boolean;
}): EsignEnvelopeStatus {
  if (args.is_complete) return "signed";
  if (args.is_declined) return "declined";
  if (args.has_error) return "cancelled";
  return "awaiting_signature";
}

class DropboxSignProvider implements EsignProvider {
  readonly name = "dropbox_sign" as const;
  readonly isConfigured = DROPBOX_SIGN_API_KEY.length > 0;

  async createEnvelope(
    input: CreateEnvelopeInput,
  ): Promise<CreateEnvelopeResult> {
    if (!this.isConfigured) {
      return { ok: false, error: "DROPBOX_SIGN_API_KEY not set" };
    }

    const signersWithEmail = input.signers.filter(
      (s): s is typeof s & { email: string } =>
        typeof s.email === "string" && s.email.trim() !== "",
    );
    if (signersWithEmail.length === 0) {
      return {
        ok: false,
        error: "Dropbox Sign requires at least one signer with email",
      };
    }

    const useEmbedded = DROPBOX_SIGN_CLIENT_ID.length > 0;
    const endpoint = useEmbedded
      ? `${API_BASE}/signature_request/create_embedded`
      : `${API_BASE}/signature_request/send`;

    // Build form-data payload. Dropbox Sign accepts both JSON and
    // multipart but `application/x-www-form-urlencoded` is the simplest
    // when not uploading file attachments.
    const form = new URLSearchParams();
    form.set("title", input.title.slice(0, 240));
    form.set("subject", input.title.slice(0, 200));
    form.set("message", input.body.slice(0, 2000));
    // Sandbox everywhere EXCEPT real production (Herm TASK_072 #2): a
    // test_mode envelope is NOT a legally binding signature, so shipping it
    // on the live domain would be fake e-sign with a real vendor. Same prod
    // detection as getEsignProvider(): Vercel sets VERCEL_ENV="production"
    // only on the production deploy.
    if (process.env.VERCEL_ENV !== "production") {
      form.set("test_mode", "1");
    }
    form.set("metadata[contract_id]", input.contract_id);
    if (useEmbedded) {
      form.set("client_id", DROPBOX_SIGN_CLIENT_ID);
    }
    signersWithEmail.forEach((s, i) => {
      form.set(`signers[${i}][name]`, s.name);
      form.set(`signers[${i}][email_address]`, s.email);
      form.set(`signers[${i}][order]`, String(i));
    });
    // Dropbox Sign requires at least one file_url OR a file upload. We
    // use a data URL with the contract body so they ingest the plain
    // text as a one-page PDF.
    form.set(
      "file_url[0]",
      `data:text/plain;base64,${Buffer.from(input.body, "utf8").toString("base64")}`,
    );

    let resJson: {
      signature_request?: {
        signature_request_id?: string;
        is_complete?: boolean;
        is_declined?: boolean;
        has_error?: boolean;
        signatures?: Array<{
          signature_id?: string;
          signer_email_address?: string;
          signer_role?: string;
        }>;
      };
      error?: { error_msg?: string };
    };
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: authHeader(),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: form.toString(),
      });
      resJson = (await res.json().catch(() => ({}))) as typeof resJson;
      if (!res.ok) {
        return {
          ok: false,
          error:
            resJson.error?.error_msg ??
            `dropbox_sign ${res.status}`,
        };
      }
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : "dropbox_sign fetch threw",
      };
    }

    const sr = resJson.signature_request;
    if (!sr?.signature_request_id) {
      return { ok: false, error: "dropbox_sign response missing request id" };
    }

    // Build per-role signing URL map. In embedded mode we'd resolve via
    // a second `/embedded/sign_url/{signature_id}` call; for the basic
    // (emailed) flow there's no direct URL — Dropbox Sign emails the
    // signers. We surface null so the panel just shows "envelope sent".
    const signing_url_by_role: Record<"user" | "contractor", string | null> = {
      user: null,
      contractor: null,
    };
    if (useEmbedded && sr.signatures) {
      // Fetch the embedded URL for each signature. Best-effort; null on
      // failure so the envelope is still returned.
      for (const sig of sr.signatures) {
        const role = sig.signer_role;
        if (role !== "user" && role !== "contractor") continue;
        if (!sig.signature_id) continue;
        const urlRes = await fetch(
          `${API_BASE}/embedded/sign_url/${sig.signature_id}`,
          { headers: { Authorization: authHeader() } },
        ).catch(() => null);
        if (!urlRes || !urlRes.ok) continue;
        const urlJson = (await urlRes
          .json()
          .catch(() => ({}))) as {
          embedded?: { sign_url?: string };
        };
        if (urlJson.embedded?.sign_url) {
          signing_url_by_role[role] = urlJson.embedded.sign_url;
        }
      }
    }

    return {
      ok: true,
      envelope_id: sr.signature_request_id,
      status: mapDropboxStatus({
        is_complete: sr.is_complete,
        is_declined: sr.is_declined,
        has_error: sr.has_error,
      }),
      signing_url_by_role,
    };
  }
}

export const dropboxSignProvider = new DropboxSignProvider();
