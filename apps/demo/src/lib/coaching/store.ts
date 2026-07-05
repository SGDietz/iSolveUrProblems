import { getSupabaseAdminConfig } from "../supabaseAdmin";
import type { CoachingEventKey, CoachingNudgeRow } from "./types";

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

export type RecordNudgeInput = {
  contractor_id: string;
  event_key: CoachingEventKey;
  payload_signature: string;
  subject: string;
  body_text: string;
  body_html: string | null;
  channel: "email" | "sms" | "whatsapp";
  notification_row_id: string | null;
  context?: Record<string, unknown>;
};

/**
 * Insert a coaching_nudges_sent row. Returns the row, or null if the
 * unique constraint tripped (which means we've already sent this
 * exact nudge — the cron should treat that as a no-op, not an error).
 */
export async function recordNudgeSent(
  input: RecordNudgeInput,
): Promise<CoachingNudgeRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const row = {
    contractor_id: input.contractor_id,
    event_key: input.event_key,
    payload_signature: input.payload_signature,
    subject: input.subject,
    body_text: input.body_text,
    body_html: input.body_html,
    channel: input.channel,
    notification_row_id: input.notification_row_id,
    context: input.context ?? {},
  };
  const res = await fetch(`${url}/rest/v1/coaching_nudges_sent`, {
    method: "POST",
    headers: {
      ...adminHeaders(serviceRoleKey),
      Prefer: "return=representation",
    },
    body: JSON.stringify([row]),
  });
  if (!res.ok) {
    // Conflict from the unique constraint = already-sent — treat as null.
    if (res.status === 409) return null;
    console.error(
      "[coaching/store] recordNudgeSent failed:",
      res.status,
      await res.text().catch(() => ""),
    );
    return null;
  }
  const rows = (await res.json()) as CoachingNudgeRow[];
  return rows[0] ?? null;
}

export async function alreadySent(args: {
  contractor_id: string;
  event_key: CoachingEventKey;
  payload_signature: string;
}): Promise<boolean> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const qs = new URLSearchParams();
  qs.set("contractor_id", `eq.${args.contractor_id}`);
  qs.set("event_key", `eq.${args.event_key}`);
  qs.set("payload_signature", `eq.${args.payload_signature}`);
  qs.set("select", "id");
  qs.set("limit", "1");
  const res = await fetch(
    `${url}/rest/v1/coaching_nudges_sent?${qs.toString()}`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return false;
  const rows = (await res.json()) as Array<{ id: string }>;
  return rows.length === 1;
}

export async function getMostRecentNudgeForContractor(
  contractor_id: string,
): Promise<CoachingNudgeRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const qs = new URLSearchParams();
  qs.set("contractor_id", `eq.${contractor_id}`);
  qs.set("order", "sent_at.desc");
  qs.set("limit", "1");
  qs.set("select", "*");
  const res = await fetch(
    `${url}/rest/v1/coaching_nudges_sent?${qs.toString()}`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as CoachingNudgeRow[];
  return rows[0] ?? null;
}
