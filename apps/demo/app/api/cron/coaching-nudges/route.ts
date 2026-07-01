import { NextResponse, type NextRequest } from "next/server";
import { CRON_SECRET } from "../../secrets";
import { verifyAdminBearer } from "../../../../src/lib/apiRouteSecurity";
import { getSupabaseAdminConfig } from "../../../../src/lib/supabaseAdmin";
import {
  COACHING_CATALOG,
  composeCoachingNudge,
  recordNudgeSent,
  alreadySent,
  type CoachingEvent,
} from "../../../../src/lib/coaching";
import { send } from "../../../../src/lib/notifications";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron/coaching-nudges (M4.8)
 *
 * Vision ¶28: "6 will always be positive and encouraging, helping people
 * be better business owners and employees."
 *
 * Cadence: daily (see vercel.json). Each pass:
 *   1. Find every contractor on an active GOLD subscription
 *   2. Resolve their email + display name
 *   3. For each catalog event, evaluate the trigger
 *   4. Dedup against coaching_nudges_sent (event_key + payload_signature)
 *   5. Compose the email via the LLM
 *   6. Send via notifications.send + record into coaching_nudges_sent
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}.
 *
 * Tier gate: gold (coaching_nudges) — enforced in the SQL that picks
 * eligible contractors.
 */

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

type EligibleContractor = {
  id: string;
  name: string;
  email: string | null;
  claimed_by_user_id: string | null;
};

async function fetchGoldContractors(): Promise<EligibleContractor[]> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  // Pull active/trialing/past_due gold subs, then join to contractors.
  // PostgREST handles the join in one round trip.
  const qs = new URLSearchParams();
  qs.set("status", "in.(trialing,active,past_due)");
  qs.set("tier", "eq.gold");
  qs.set(
    "select",
    "contractor_id,contractor:contractors!inner(id,name,email,claimed_by_user_id)",
  );
  qs.set("limit", "500");
  const res = await fetch(
    `${url}/rest/v1/contractor_billing_subscriptions?${qs.toString()}`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    },
  );
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<{
    contractor_id: string;
    contractor: {
      id: string;
      name: string;
      email: string | null;
      claimed_by_user_id: string | null;
    } | null;
  }>;
  const out: EligibleContractor[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (!r.contractor) continue;
    if (seen.has(r.contractor.id)) continue;
    seen.add(r.contractor.id);
    out.push(r.contractor);
  }
  return out;
}

type EventResult = {
  contractor_id: string;
  event_key: string;
  outcome: "sent" | "skipped" | "no_trigger" | "no_email" | "compose_failed";
  detail?: string;
};

async function processEvent(args: {
  contractor: EligibleContractor;
  event: CoachingEvent;
}): Promise<EventResult> {
  const { contractor, event } = args;
  const evaluation = await event.evaluate(contractor.id);
  if (!evaluation) {
    return {
      contractor_id: contractor.id,
      event_key: event.key,
      outcome: "no_trigger",
    };
  }
  const dup = await alreadySent({
    contractor_id: contractor.id,
    event_key: event.key,
    payload_signature: evaluation.signature,
  });
  if (dup) {
    return {
      contractor_id: contractor.id,
      event_key: event.key,
      outcome: "skipped",
      detail: "already_sent",
    };
  }
  if (!contractor.email) {
    return {
      contractor_id: contractor.id,
      event_key: event.key,
      outcome: "no_email",
    };
  }

  const composed = await composeCoachingNudge({
    contractorName: contractor.name,
    event,
    evaluation,
  });
  if (!composed.ok) {
    return {
      contractor_id: contractor.id,
      event_key: event.key,
      outcome: "compose_failed",
      detail: composed.reason,
    };
  }

  const delivery = await send({
    channel: "email",
    recipient: contractor.email,
    templateId: "coaching.nudge.v1",
    data: {
      recipientName: contractor.name,
      subject: composed.subject,
      body: composed.body,
    },
    userId: contractor.claimed_by_user_id ?? null,
    context: {
      event_key: event.key,
      signature: evaluation.signature,
    },
  });

  await recordNudgeSent({
    contractor_id: contractor.id,
    event_key: event.key,
    payload_signature: evaluation.signature,
    subject: composed.subject,
    body_text: composed.body,
    body_html: null,
    channel: "email",
    notification_row_id: delivery.row_id ?? null,
    context: {
      facts: evaluation.facts,
      topic: evaluation.topic,
      delivery_ok: delivery.ok,
      delivery_error: delivery.ok ? null : delivery.error,
    },
  });

  return {
    contractor_id: contractor.id,
    event_key: event.key,
    outcome: delivery.ok ? "sent" : "compose_failed",
    detail: delivery.ok ? undefined : delivery.error,
  };
}

async function handle(request: NextRequest) {
  if (!CRON_SECRET) return bad("CRON_SECRET not configured", 503);
  if (!verifyAdminBearer(request.headers.get("authorization"), CRON_SECRET).ok) {
    return bad("unauthorized", 401);
  }

  const contractors = await fetchGoldContractors();
  // For each contractor, run the catalog. Within a contractor we run
  // events SEQUENTIALLY to keep the LLM call rate manageable; across
  // contractors we parallelize lightly.
  const results: EventResult[] = [];
  for (const contractor of contractors) {
    for (const event of COACHING_CATALOG) {
      results.push(await processEvent({ contractor, event }));
    }
  }

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    eligible_contractors: contractors.length,
    events: COACHING_CATALOG.length,
    results,
  });
}

export const GET = handle;
export const POST = handle;
