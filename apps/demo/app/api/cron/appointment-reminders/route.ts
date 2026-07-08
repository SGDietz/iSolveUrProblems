import { NextResponse, type NextRequest } from "next/server";
import { CRON_SECRET } from "../../secrets";
import { verifyAdminBearer } from "../../../../src/lib/apiRouteSecurity";
import {
  findAppointmentsDueForReminder,
  findAppointmentsDueForChecklist,
  markReminderSent,
  generateChecklist,
  markChecklistNotified,
  type AppointmentRow,
} from "../../../../src/lib/appointments";
import { send, type DeliveryResult } from "../../../../src/lib/notifications";
import { getSupabaseAdminConfig } from "../../../../src/lib/supabaseAdmin";
import { APP_PUBLIC_BASE_URL } from "../../secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * GET /api/cron/appointment-reminders (M3.4)
 *
 * Vision ¶14: "before meetings or when work is to occur, 6 will message
 * both parties to make sure they'll be on time and ready."
 *
 * Cadence (recommended): every 15 minutes. Each pass:
 *   1. Find appointments whose 24h reminder window is open and not yet sent
 *   2. For each, send a reminder to the homeowner AND the contractor
 *   3. Mark reminder_24h_sent_at
 *   4. Same for the 2h window
 *
 * Idempotency: the reminder_*_sent_at column is the gate. Once written
 * we never re-fire. Reminder rows in notifications_sent provide audit.
 *
 * Auth: Authorization: Bearer ${CRON_SECRET}. Without that header (or
 * with a wrong one) returns 401.
 */

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

async function fetchUserChannelTarget(
  userId: string,
): Promise<{ email: string | null; phone: string | null; name: string | null }> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const res = await fetch(
      `${url}/rest/v1/users?id=eq.${encodeURIComponent(
        userId,
      )}&select=email,phone,full_name&limit=1`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        cache: "no-store",
      },
    );
    if (!res.ok) return { email: null, phone: null, name: null };
    const rows = (await res.json()) as Array<{
      email: string | null;
      phone: string | null;
      full_name: string | null;
    }>;
    const row = rows[0];
    return {
      email: row?.email ?? null,
      phone: row?.phone ?? null,
      name: row?.full_name ?? null,
    };
  } catch {
    return { email: null, phone: null, name: null };
  }
}

async function fetchContractorTarget(
  contractorId: string,
): Promise<{
  email: string | null;
  phone: string | null;
  name: string;
  category: string | null;
}> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const res = await fetch(
      `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(
        contractorId,
      )}&select=email,phone,name,categories&limit=1`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        cache: "no-store",
      },
    );
    if (!res.ok)
      return { email: null, phone: null, name: "contractor", category: null };
    const rows = (await res.json()) as Array<{
      email: string | null;
      phone: string | null;
      name: string;
      categories: string[] | null;
    }>;
    const row = rows[0];
    return {
      email: row?.email ?? null,
      phone: row?.phone ?? null,
      name: row?.name ?? "contractor",
      category: row?.categories?.[0] ?? null,
    };
  } catch {
    return { email: null, phone: null, name: "contractor", category: null };
  }
}

async function fetchContractScope(
  contractId: string | null,
): Promise<string | null> {
  if (!contractId) return null;
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const res = await fetch(
      `${url}/rest/v1/contracts?id=eq.${encodeURIComponent(
        contractId,
      )}&select=scope&limit=1`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
        cache: "no-store",
      },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ scope: string | null }>;
    return rows[0]?.scope ?? null;
  } catch {
    return null;
  }
}

function humanTime(when: string, offsetHours: 24 | 2): string {
  const d = new Date(when);
  const opts: Intl.DateTimeFormatOptions = {
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  const formatted = new Intl.DateTimeFormat("en-US", opts).format(d);
  return offsetHours === 24 ? `tomorrow, ${formatted}` : `at ${formatted}`;
}

type CronRole = "homeowner" | "contractor";
type CronKind = "24h" | "2h" | "checklist_2h";
type CronSendContext = {
  appointment_id: string;
  role: CronRole;
  cron_kind: CronKind;
};

const DELIVERED_NOTIFICATION_STATUSES = "sent,delivered,opened,clicked";

function cronNotificationIdempotencyKey(args: {
  recipient: string;
  channel: "email" | "sms";
  templateId: string;
  context: CronSendContext;
}): string {
  const { context } = args;
  return [
    "cron",
    context.appointment_id,
    context.cron_kind,
    context.role,
    args.channel,
    args.recipient,
    args.templateId,
  ].join(":");
}

async function cronNotificationAlreadySent(args: {
  recipient: string;
  channel: "email" | "sms";
  templateId: string;
  context: CronSendContext;
}): Promise<boolean> {
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const qs = new URLSearchParams();
    qs.set("recipient", `eq.${args.recipient}`);
    qs.set("channel", `eq.${args.channel}`);
    qs.set("template_id", `eq.${args.templateId}`);
    qs.set("status", `in.(${DELIVERED_NOTIFICATION_STATUSES})`);
    qs.set("context->>appointment_id", `eq.${args.context.appointment_id}`);
    qs.set("context->>role", `eq.${args.context.role}`);
    qs.set("context->>cron_kind", `eq.${args.context.cron_kind}`);
    qs.set("select", "id");
    qs.set("limit", "1");

    const res = await fetch(`${url}/rest/v1/notifications_sent?${qs.toString()}`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("cron notification dedupe check failed:", res.status, await res.text());
      return false;
    }
    const rows = (await res.json().catch(() => [])) as Array<{ id: string }>;
    return rows.length > 0;
  } catch (error) {
    console.error("cron notification dedupe check threw:", error);
    return false;
  }
}

async function sendOne(args: {
  to: string;
  channel: "email" | "sms";
  templateId: string;
  data: Record<string, unknown>;
  context: CronSendContext;
}): Promise<DeliveryResult | null> {
  if (!args.to) return null;
  if (
    await cronNotificationAlreadySent({
      recipient: args.to,
      channel: args.channel,
      templateId: args.templateId,
      context: args.context,
    })
  ) {
    return {
      ok: true,
      channel: args.channel,
      provider_id: "already-sent",
      row_id: "already-sent",
    };
  }
  return send({
    channel: args.channel,
    recipient: args.to,
    templateId: args.templateId,
    data: args.data,
    idempotencyKey: cronNotificationIdempotencyKey({
      recipient: args.to,
      channel: args.channel,
      templateId: args.templateId,
      context: args.context,
    }),
    context: args.context,
  });
}

async function dispatchAppointmentReminder(
  appointment: AppointmentRow,
  kind: "24h" | "2h",
): Promise<{
  appointment_id: string;
  user_sent: boolean;
  contractor_sent: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  const templateId = `appointment.reminder.${kind}.v1`;
  const whenText = humanTime(appointment.scheduled_at, kind === "24h" ? 24 : 2);

  // ── Homeowner ────────────────────────────────────────────────────
  const userTarget = await fetchUserChannelTarget(appointment.user_id);
  let userSent = false;
  const userTo = userTarget.email ?? userTarget.phone;
  const userChannel: "email" | "sms" = userTarget.email ? "email" : "sms";
  if (userTo) {
    const result = await sendOne({
      to: userTo,
      channel: userChannel,
      templateId,
      data: {
        recipientName: userTarget.name,
        otherPartyName: appointment.contractor_id
          ? (await fetchContractorTarget(appointment.contractor_id)).name
          : null,
        whenText,
        agenda: appointment.agenda,
      },
      context: {
        appointment_id: appointment.id,
        role: "homeowner",
        cron_kind: kind,
      },
    });
    if (result) {
      if (result.ok) userSent = true;
      else errors.push(`user: ${"error" in result ? result.error : "send failed"}`);
    }
  } else {
    errors.push("user has no email or phone on file");
  }

  // ── Contractor ───────────────────────────────────────────────────
  let contractorSent = false;
  if (appointment.contractor_id) {
    const ct = await fetchContractorTarget(appointment.contractor_id);
    const to = ct.email ?? ct.phone;
    const channel: "email" | "sms" = ct.email ? "email" : "sms";
    if (to) {
      const result = await sendOne({
        to,
        channel,
        templateId,
        data: {
          recipientName: ct.name,
          otherPartyName: userTarget.name,
          whenText,
          agenda: appointment.agenda,
        },
        context: {
          appointment_id: appointment.id,
          role: "contractor",
          cron_kind: kind,
        },
      });
      if (result?.ok) contractorSent = true;
      else if (result) {
        errors.push(`contractor: ${"error" in result ? result.error : "send failed"}`);
      }
    } else {
      errors.push("contractor has no email or phone");
    }
  }

  const requiredDelivered = userSent && (!appointment.contractor_id || contractorSent);
  if (!requiredDelivered) {
    errors.push("not marking reminder sent; delivery incomplete and should retry");
    return {
      appointment_id: appointment.id,
      user_sent: userSent,
      contractor_sent: contractorSent,
      errors,
    };
  }

  const markerWritten = await markReminderSent({ appointment_id: appointment.id, kind });
  if (!markerWritten) {
    errors.push("markReminderSent failed; cron dedupe prevents duplicate delivered notices on retry");
  }

  return {
    appointment_id: appointment.id,
    user_sent: userSent,
    contractor_sent: contractorSent,
    errors,
  };
}

/**
 * M4.3 — Dispatch the pre-departure checklist alongside the 2h reminder.
 * Idempotent via appointments.checklist_notified_at. Tier-gated to
 * bronze+ inside generateChecklist; gated calls return cleanly so the
 * cron just skips them.
 */
async function dispatchChecklistIfDue(
  appointment: AppointmentRow,
): Promise<{
  appointment_id: string;
  generated: boolean;
  notified: boolean;
  skipped: string | null;
}> {
  if (appointment.checklist_notified_at) {
    return {
      appointment_id: appointment.id,
      generated: false,
      notified: false,
      skipped: "already_notified",
    };
  }
  if (!appointment.contractor_id) {
    return {
      appointment_id: appointment.id,
      generated: false,
      notified: false,
      skipped: "no_contractor",
    };
  }

  const contractor = await fetchContractorTarget(appointment.contractor_id);
  const scope = await fetchContractScope(appointment.contract_id);

  const result = await generateChecklist({
    appointment_id: appointment.id,
    contractor_id: appointment.contractor_id,
    agenda: appointment.agenda,
    scope,
    category: contractor.category,
    reason: "cron_2h",
  });
  if (!result.ok) {
    // tier_gate / openai_not_configured / llm_* — all silent skips,
    // intentionally not marked as notified so a later upgrade triggers.
    return {
      appointment_id: appointment.id,
      generated: false,
      notified: false,
      skipped: result.reason,
    };
  }
  if (result.row.items.length === 0) {
    return {
      appointment_id: appointment.id,
      generated: result.generated,
      notified: false,
      skipped: "empty_items",
    };
  }

  const to = contractor.email ?? contractor.phone;
  if (!to) {
    return {
      appointment_id: appointment.id,
      generated: result.generated,
      notified: false,
      skipped: "no_contact",
    };
  }
  const channel: "email" | "sms" = contractor.email ? "email" : "sms";
  const dashboardUrl = APP_PUBLIC_BASE_URL
    ? `${APP_PUBLIC_BASE_URL}/en/contractor/dashboard`
    : "/en/contractor/dashboard";

  const delivery = await sendOne({
    to,
    channel,
    templateId: "appointment.checklist.v1",
    data: {
      recipientName: contractor.name,
      whenText: humanTime(appointment.scheduled_at, 2),
      agenda: appointment.agenda,
      items: result.row.items.map((i) => ({ kind: i.kind, text: i.text })),
      dashboardUrl,
    },
    context: {
      appointment_id: appointment.id,
      role: "contractor",
      cron_kind: "checklist_2h",
    },
  });
  if (!delivery?.ok) {
    const deliveryError = delivery && "error" in delivery ? delivery.error : "send failed";
    return {
      appointment_id: appointment.id,
      generated: result.generated,
      notified: false,
      skipped: `send_failed:${deliveryError}`,
    };
  }

  const markerWritten = await markChecklistNotified({ appointment_id: appointment.id });
  if (!markerWritten) {
    return {
      appointment_id: appointment.id,
      generated: result.generated,
      notified: false,
      skipped: "marker_failed",
    };
  }

  return {
    appointment_id: appointment.id,
    generated: result.generated,
    notified: true,
    skipped: null,
  };
}

export async function GET(request: NextRequest) {
  if (!CRON_SECRET) return bad("CRON_SECRET not configured", 503);
  if (!verifyAdminBearer(request.headers.get("authorization"), CRON_SECRET).ok) {
    return bad("unauthorized", 401);
  }

  // 24h window
  const due24h = await findAppointmentsDueForReminder({ kind: "24h" });
  const results24h = await Promise.all(
    due24h.map((a: AppointmentRow) =>
      dispatchAppointmentReminder(a, "24h"),
    ),
  );

  // 2h window — reminder dispatch. The pre-departure checklist has its own
  // due-query below so a reminder success cannot starve checklist retries.
  const due2h = await findAppointmentsDueForReminder({ kind: "2h" });
  const results2h = await Promise.all(
    due2h.map((a: AppointmentRow) =>
      dispatchAppointmentReminder(a, "2h"),
    ),
  );
  const dueChecklist = await findAppointmentsDueForChecklist({});
  const checklistResults = await Promise.all(
    dueChecklist.map((a: AppointmentRow) => dispatchChecklistIfDue(a)),
  );

  return NextResponse.json({
    ran_at: new Date().toISOString(),
    "24h": {
      found: due24h.length,
      results: results24h,
    },
    "2h": {
      found: due2h.length,
      results: results2h,
    },
    checklist: {
      considered: dueChecklist.length,
      results: checklistResults,
    },
  });
}
