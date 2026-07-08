import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../src/lib/rateLimit";
import { getUserId } from "../../../../src/lib/auth/getUser";
import { PLATFORM_CURRENCY, PLATFORM_FEE_PERCENT } from "../../../api/secrets";
import {
  insertContract,
  setContractEsign,
  computePlatformFeeCents,
  getContractorStripeRow,
} from "../../../../src/lib/payments";
import {
  getEsignProvider,
  getProviderNameFromEnv,
} from "../../../../src/lib/esign";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/contracts/draft (M3.7)
 *
 * Vision ¶17 — "write up contracts... deliver the contract in writing in
 * their email box."
 *
 * Body:
 *   {
 *     contractor_id: uuid,            // required
 *     scope: string,                  // required — what the contract covers
 *     amount_cents: number,           // required ($1..$50k)
 *     candidate_ids?: uuid[],         // optional carryover for M2.6 fan-out
 *   }
 *
 * Returns:
 *   {
 *     contract_id: uuid,
 *     envelope: {
 *       provider: 'mock' | 'dropbox_sign',
 *       envelope_id: string,
 *       status: EsignEnvelopeStatus,
 *       signing_url_by_role: { user, contractor }
 *     }
 *   }
 *
 * v1 mock provider signs immediately. Real providers will route through
 * the webhook to update status after the user clicks the signing link.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_AMOUNT_CENTS = 100;
const MAX_AMOUNT_CENTS = 5_000_000;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(request: NextRequest) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  const userId = await getUserId();
  if (!userId) return bad("sign-in required", 401);

  let body: {
    contractor_id?: unknown;
    scope?: unknown;
    amount_cents?: unknown;
    candidate_ids?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return bad("invalid JSON");
  }

  if (
    typeof body.contractor_id !== "string" ||
    !UUID_RE.test(body.contractor_id)
  ) {
    return bad("contractor_id is required (uuid)");
  }
  if (typeof body.scope !== "string" || body.scope.trim() === "") {
    return bad("scope is required (non-empty string)");
  }
  if (
    typeof body.amount_cents !== "number" ||
    !Number.isInteger(body.amount_cents) ||
    body.amount_cents < MIN_AMOUNT_CENTS ||
    body.amount_cents > MAX_AMOUNT_CENTS
  ) {
    return bad(
      `amount_cents must be an integer between ${MIN_AMOUNT_CENTS} and ${MAX_AMOUNT_CENTS}`,
    );
  }
  const amountCents = body.amount_cents;
  const candidateIds = Array.isArray(body.candidate_ids)
    ? body.candidate_ids.filter(
        (x): x is string => typeof x === "string" && UUID_RE.test(x),
      )
    : [];

  // Resolve the e-sign provider BEFORE any DB write: in production with no
  // real provider configured, getEsignProvider() THROWS (fail-closed). It
  // used to be called after the contract insert, so every prod draft attempt
  // left an orphan 'pending' contract row (Herm ship-blocker 2026-07-02).
  let provider;
  try {
    provider = getEsignProvider();
  } catch (e) {
    return bad(
      e instanceof Error ? e.message : "e-sign is not configured",
      503,
    );
  }

  // Look up the contractor so we have their name + email for the envelope.
  const contractor = await getContractorStripeRow(body.contractor_id);
  if (!contractor) return bad("contractor not found", 404);

  // Look up the homeowner's name/email — best-effort.
  const homeowner = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/users?id=eq.${encodeURIComponent(
      userId,
    )}&select=email,full_name&limit=1`,
    {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      cache: "no-store",
    },
  )
    .then((r) =>
      r.ok ? r.json() : Promise.resolve([]),
    )
    .catch(() => []) as Promise<
    Array<{ email: string | null; full_name: string | null }>
  >;
  const userRow = (await homeowner)[0];
  const userEmail = userRow?.email ?? null;
  const userName = userRow?.full_name ?? "Homeowner";

  // 1. Insert a contract row with status='pending' and the e-sign scope.
  const platformFeeCents = computePlatformFeeCents(
    amountCents,
    PLATFORM_FEE_PERCENT,
  );
  let contract;
  try {
    contract = await insertContract({
      user_id: userId,
      contractor_id: body.contractor_id,
      category: contractor.stripe_connect_account_id ? "general" : "general",
      amount_cents: amountCents,
      platform_fee_cents: platformFeeCents,
      currency: PLATFORM_CURRENCY,
      candidate_ids: candidateIds,
      context: {
        source: "m3.7_draft_contract",
        scope: body.scope.trim(),
      },
    });
  } catch (e) {
    return bad(
      e instanceof Error ? e.message : "contract insert failed",
      500,
    );
  }

  // 2. Build the contract body text — the e-sign provider will render it
  //    as a document. Keep it generic per Q3.7b (single template for v1).
  const docBody = buildContractBody({
    homeownerName: userName,
    contractorName: contractor.name,
    scope: body.scope.trim(),
    amountCents,
    currency: PLATFORM_CURRENCY,
    platformFeeCents,
  });

  // 3. Hand to the e-sign provider (resolved above, before the insert).
  const env = await provider.createEnvelope({
    contract_id: contract.id,
    title: `Work agreement — ${contractor.name}`,
    body: docBody,
    signers: [
      { role: "user", name: userName, email: userEmail },
      {
        role: "contractor",
        name: contractor.name,
        email: contractor.email,
      },
    ],
    return_url: new URL(`/checkout/${contract.id}?ok=1`, request.url).toString(),
  });

  if (!env.ok) {
    return bad(`esign provider failed: ${env.error}`, 502);
  }

  // 4. Persist envelope details.
  try {
    await setContractEsign({
      contract_id: contract.id,
      user_id: userId,
      esign_provider: getProviderNameFromEnv(),
      esign_envelope_id: env.envelope_id,
      esign_envelope_status: env.status,
      esign_signing_url_user: env.signing_url_by_role.user,
      esign_signing_url_contractor: env.signing_url_by_role.contractor,
      scope: body.scope.trim(),
      stamp_signed_now: env.status === "signed",
    });
  } catch (e) {
    return bad(
      e instanceof Error ? e.message : "contract esign patch failed",
      500,
    );
  }

  return NextResponse.json({
    contract_id: contract.id,
    contractor_name: contractor.name,
    scope: body.scope.trim(),
    amount_cents: amountCents,
    platform_fee_cents: platformFeeCents,
    currency: PLATFORM_CURRENCY,
    envelope: {
      provider: getProviderNameFromEnv(),
      envelope_id: env.envelope_id,
      status: env.status,
      signing_url_by_role: env.signing_url_by_role,
    },
  });
}

/**
 * Q3.7b — single generic contract template. The body is a plain-text
 * scope-of-work agreement that both parties sign. Real providers render
 * this through their own document templating; the mock provider stores
 * it as-is for inspection.
 */
function buildContractBody(args: {
  homeownerName: string;
  contractorName: string;
  scope: string;
  amountCents: number;
  currency: string;
  platformFeeCents: number;
}): string {
  const dollars = (args.amountCents / 100).toFixed(2);
  const feeDollars = (args.platformFeeCents / 100).toFixed(2);
  const c = args.currency.toUpperCase();
  return [
    `WORK AGREEMENT`,
    ``,
    `Between: ${args.homeownerName} ("Homeowner")`,
    `And:     ${args.contractorName} ("Contractor")`,
    ``,
    `Scope of Work:`,
    args.scope,
    ``,
    `Total Compensation: ${dollars} ${c}`,
    `Platform Fee (deducted): ${feeDollars} ${c} (iSolveUrProblems)`,
    ``,
    `Both parties agree that:`,
    `  - Work will be performed in a workmanlike manner.`,
    `  - Payment will be released through the iSolveUrProblems platform.`,
    `  - Disputes will be handled per the iSolveUrProblems Terms of Service.`,
    `  - This agreement is enforceable as a written contract upon both signatures.`,
    ``,
    `By signing below, both parties acknowledge and agree to these terms.`,
  ].join("\n");
}
