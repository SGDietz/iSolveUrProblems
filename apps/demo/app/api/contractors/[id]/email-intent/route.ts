import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../../src/lib/rateLimit";
import { getUser } from "../../../../../src/lib/auth/getUser";
import { getContractorStripeRow } from "../../../../../src/lib/payments";
import { send } from "../../../../../src/lib/notifications";
import type { HomeownerContractorIntroData } from "../../../../../src/lib/notifications/templates/homeowner-contractor-intro";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_TEXT = 500;

function bad(msg: string, status = 400) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

function cleanText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, max) : null;
}

function userDisplayName(user: Awaited<ReturnType<typeof getUser>>): string {
  const raw = user?.user_metadata?.full_name;
  if (typeof raw === "string" && raw.trim()) return raw.trim().slice(0, 120);
  return user?.email?.split("@")[0] ?? "A homeowner";
}

function idempotencyKey(args: {
  userId: string;
  contractorId: string;
  message: string | null;
}) {
  // Dedupe accidental double-taps without permanently blocking a future
  // follow-up: same user + contractor + note + UTC day is one send.
  const day = new Date().toISOString().slice(0, 10);
  const digest = createHash("sha256")
    .update(`${args.userId}\n${args.contractorId}\n${day}\n${args.message ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return `contractor-email-intent:${args.userId}:${args.contractorId}:${day}:${digest}`;
}

/**
 * POST /api/contractors/[id]/email-intent
 *
 * Sends a homeowner-approved intro email from iSolve to the contractor.
 * This replaces the old client-side mailto: escape hatch: the homeowner
 * must be signed in, tap the Email CTA, then confirm the in-app consent
 * sheet before this route dispatches anything.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  const { id } = await context.params;
  if (!UUID_RE.test(id)) return bad("invalid contractor id");

  const user = await getUser();
  if (!user) return bad("sign-in required so 6 can send from iSolve", 401);
  if (!user.email || !EMAIL_RE.test(user.email)) {
    return bad("your account needs a valid email before 6 can introduce you", 400);
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // empty body OK
  }

  const contractor = await getContractorStripeRow(id).catch(() => null);
  if (!contractor) return bad("contractor not found", 404);
  if (!contractor.email || !EMAIL_RE.test(contractor.email)) {
    return bad("contractor has no verified email", 409);
  }

  const message = cleanText(body.message);
  const data: HomeownerContractorIntroData = {
    contractorName: contractor.name,
    homeownerName: userDisplayName(user),
    homeownerEmail: user.email,
    message,
    category: cleanText(body.category, 120),
    homeownerLocation: cleanText(body.homeowner_location, 160),
  };

  const result = await send({
    channel: "email",
    recipient: contractor.email,
    templateId: "homeowner.contractor_intro.v1",
    data,
    userId: user.id,
    sessionId: cleanText(body.session_id, 200),
    idempotencyKey: idempotencyKey({
      userId: user.id,
      contractorId: contractor.id,
      message,
    }),
    context: {
      source: "contractor_email_pill",
      contractor_id: contractor.id,
      contractor_name: contractor.name,
    },
  });

  return NextResponse.json({
    ...result,
    contractor_id: contractor.id,
    contractor_name: contractor.name,
  });
}
