import { getSupabaseAdminConfig } from "../supabaseAdmin";
import type {
  JobLogEntryRow,
  JobLogEntryView,
  JobLogKind,
  JobLogPhase,
} from "./types";

export const JOB_LOGS_BUCKET = "job-logs";
export const MAX_JOB_LOG_BYTES = 50 * 1024 * 1024; // 50 MB
const SIGNED_URL_TTL_SECONDS = 60 * 60; // 1h

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

export function buildJobLogStoragePath(args: {
  appointment_id: string;
  kind: JobLogKind;
  ext: string;
}): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const iso = now.toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 10);
  return `${args.appointment_id}/${yyyy}-${mm}/${args.kind}-${iso}-${rand}.${args.ext}`;
}

export function extForMime(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("quicktime")) return "mov";
  if (mime.includes("png")) return "png";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("heic")) return "heic";
  return "jpg";
}

/**
 * Upload bytes to the job-logs bucket. Returns the storage path on
 * success, or null on failure (caller logs the upstream error).
 */
export async function uploadJobLogObject(args: {
  storage_path: string;
  mime: string;
  bytes: Uint8Array;
}): Promise<boolean> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/storage/v1/object/${JOB_LOGS_BUCKET}/${encodeURI(args.storage_path)}`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": args.mime,
        "x-upsert": "false",
      },
      body: args.bytes,
    },
  );
  if (!res.ok) {
    console.error(
      "[jobLogs/store] upload failed:",
      res.status,
      await res.text().catch(() => ""),
    );
    return false;
  }
  return true;
}

export type InsertJobLogInput = {
  appointment_id: string;
  contractor_id: string;
  user_id: string;
  kind: JobLogKind;
  phase: JobLogPhase | null;
  storage_path: string | null;
  mime_type: string | null;
  size_bytes: number | null;
  gps_lat: number | null;
  gps_lng: number | null;
  gps_accuracy_m: number | null;
  caption: string | null;
  context?: Record<string, unknown>;
};

export async function insertJobLog(
  input: InsertJobLogInput,
): Promise<JobLogEntryRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const row = {
    appointment_id: input.appointment_id,
    contractor_id: input.contractor_id,
    user_id: input.user_id,
    kind: input.kind,
    phase: input.phase,
    storage_path: input.storage_path,
    mime_type: input.mime_type,
    size_bytes: input.size_bytes,
    gps_lat: input.gps_lat,
    gps_lng: input.gps_lng,
    gps_accuracy_m: input.gps_accuracy_m,
    caption: input.caption,
    context: input.context ?? {},
  };
  const res = await fetch(`${url}/rest/v1/job_log_entries`, {
    method: "POST",
    headers: {
      ...adminHeaders(serviceRoleKey),
      Prefer: "return=representation",
    },
    body: JSON.stringify([row]),
  });
  if (!res.ok) {
    console.error(
      "[jobLogs/store] insert failed:",
      res.status,
      await res.text().catch(() => ""),
    );
    return null;
  }
  const rows = (await res.json()) as JobLogEntryRow[];
  return rows[0] ?? null;
}

export async function getJobLogEntryById(
  id: string,
): Promise<JobLogEntryRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/job_log_entries?id=eq.${encodeURIComponent(
      id,
    )}&select=*&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as JobLogEntryRow[];
  return rows[0] ?? null;
}

export async function listJobLogsForAppointment(args: {
  appointment_id: string;
}): Promise<JobLogEntryRow[]> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const qs = new URLSearchParams();
  qs.set("appointment_id", `eq.${args.appointment_id}`);
  qs.set("order", "taken_at.asc");
  qs.set("select", "*");
  qs.set("limit", "200");
  const res = await fetch(
    `${url}/rest/v1/job_log_entries?${qs.toString()}`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return [];
  return (await res.json()) as JobLogEntryRow[];
}

/**
 * Create a single short-lived signed URL for a storage path. Returns
 * null when the path is missing or signing fails.
 */
export async function signJobLogUrl(
  storage_path: string | null,
): Promise<string | null> {
  if (!storage_path) return null;
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/storage/v1/object/sign/${JOB_LOGS_BUCKET}/${encodeURI(storage_path)}`,
    {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expiresIn: SIGNED_URL_TTL_SECONDS }),
    },
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { signedURL?: string; signedUrl?: string };
  const path = data.signedURL ?? data.signedUrl;
  return path ? `${url}/storage/v1${path}` : null;
}

/**
 * Convenience: fetch + sign in one pass. Order preserved.
 */
export async function listJobLogsWithUrls(args: {
  appointment_id: string;
}): Promise<JobLogEntryView[]> {
  const rows = await listJobLogsForAppointment(args);
  return Promise.all(
    rows.map(async (r) => ({
      ...r,
      signed_url: await signJobLogUrl(r.storage_path),
    })),
  );
}
