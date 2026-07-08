import { getSupabaseAdminConfig } from "../supabaseAdmin";
import type { NotificationRow, NotificationStatus } from "./types";

const TABLE = "notifications_sent";

function headers(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

export type InsertNotificationResult =
  | { status: "inserted"; rowId: string | null }
  | { status: "duplicate"; rowId: string | null };

function notificationInsertBody(row: NotificationRow, includeIdempotencyKey: boolean) {
  return [
    {
      user_id: row.user_id ?? null,
      session_id: row.session_id ?? null,
      channel: row.channel,
      recipient: row.recipient,
      template_id: row.template_id,
      locale: row.locale ?? null,
      provider_id: row.provider_id ?? null,
      idempotency_key: includeIdempotencyKey ? row.idempotency_key ?? null : undefined,
      status: row.status,
      error: row.error ?? null,
      is_fallback: row.is_fallback ?? false,
      context: row.context ?? {},
    },
  ];
}

async function insertNotificationAttempt(args: {
  url: string;
  serviceRoleKey: string;
  row: NotificationRow;
  includeIdempotencyKey: boolean;
}): Promise<Response> {
  const qs = args.includeIdempotencyKey && args.row.idempotency_key
    ? "?on_conflict=idempotency_key"
    : "";
  const prefer = args.includeIdempotencyKey && args.row.idempotency_key
    ? "return=representation,resolution=ignore-duplicates"
    : "return=representation";
  return fetch(`${args.url}/rest/v1/${TABLE}${qs}`, {
    method: "POST",
    headers: { ...headers(args.serviceRoleKey), Prefer: prefer },
    body: JSON.stringify(notificationInsertBody(args.row, args.includeIdempotencyKey)),
  });
}

/**
 * Insert a new notification row in 'queued' state. If an idempotency key already
 * exists, reports duplicate so the caller can skip provider dispatch.
 */
export async function insertNotification(
  row: NotificationRow,
): Promise<InsertNotificationResult> {
  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return { status: "inserted", rowId: null };
  }

  try {
    let res = await insertNotificationAttempt({
      url,
      serviceRoleKey,
      row,
      includeIdempotencyKey: Boolean(row.idempotency_key),
    });
    if (!res.ok && row.idempotency_key) {
      const text = await res.text().catch(() => "");
      if (/idempotency_key|schema cache|column/i.test(text)) {
        res = await insertNotificationAttempt({
          url,
          serviceRoleKey,
          row,
          includeIdempotencyKey: false,
        });
      } else {
        console.error("notifications.insert: failed", res.status, text);
        return { status: "inserted", rowId: null };
      }
    }
    if (!res.ok) {
      console.error(
        "notifications.insert: failed",
        res.status,
        await res.text().catch(() => ""),
      );
      return { status: "inserted", rowId: null };
    }
    const rows = (await res.json()) as Array<{ id: string }>;
    if (row.idempotency_key && rows.length === 0) {
      return { status: "duplicate", rowId: null };
    }
    return { status: "inserted", rowId: rows[0]?.id ?? null };
  } catch (e) {
    console.error("notifications.insert: throw", e);
    return { status: "inserted", rowId: null };
  }
}

/**
 * Patch a notification row by id with provider id + new status.
 * Tolerates a null rowId (insert step may have failed; nothing to update).
 */
export async function updateNotificationById(
  rowId: string | null,
  patch: {
    status: NotificationStatus;
    provider_id?: string | null;
    error?: string | null;
  },
): Promise<boolean> {
  if (!rowId) return false;
  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return false;
  }
  try {
    const res = await fetch(
      `${url}/rest/v1/${TABLE}?id=eq.${encodeURIComponent(rowId)}`,
      {
        method: "PATCH",
        headers: { ...headers(serviceRoleKey), Prefer: "return=minimal" },
        body: JSON.stringify({
          status: patch.status,
          provider_id: patch.provider_id ?? undefined,
          error: patch.error ?? null,
          ...(patch.status === "failed" ? { idempotency_key: null } : {}),
        }),
      },
    );
    return res.ok;
  } catch (e) {
    console.error("notifications.update: throw", e);
    return false;
  }
}

/**
 * Webhook helper — patch by provider_id. Used by /api/webhooks/* when
 * we get a 'delivered' / 'bounced' / 'opened' event.
 */
export async function updateNotificationByProviderId(
  providerId: string,
  patch: { status: NotificationStatus; error?: string | null },
): Promise<boolean> {
  if (!providerId) return false;
  let url: string;
  let serviceRoleKey: string;
  try {
    ({ url, serviceRoleKey } = getSupabaseAdminConfig());
  } catch {
    return false;
  }
  try {
    const res = await fetch(
      `${url}/rest/v1/${TABLE}?provider_id=eq.${encodeURIComponent(providerId)}`,
      {
        method: "PATCH",
        headers: { ...headers(serviceRoleKey), Prefer: "return=minimal" },
        body: JSON.stringify({
          status: patch.status,
          error: patch.error ?? null,
          ...(patch.status === "failed" ? { idempotency_key: null } : {}),
        }),
      },
    );
    return res.ok;
  } catch (e) {
    console.error("notifications.updateByProvider: throw", e);
    return false;
  }
}
