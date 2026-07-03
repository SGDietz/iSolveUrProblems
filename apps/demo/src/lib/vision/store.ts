import { getSupabaseAdminConfig } from "../supabaseAdmin";
import type { CvConfidence } from "./classify";

/**
 * M4.6 — cv_labels persistence.
 *
 * Two operations:
 *   1. Insert a fresh prediction (server after calling classifyJobLogPhoto).
 *   2. Patch a prediction with the worker's confirmation/correction
 *      (worker taps yes/no in the dashboard).
 *
 * The confirmed-label subset is the training-data anchor for a future
 * v2 fine-tune. Nothing else consumes cv_labels in v1.
 */

export type CvLabelRow = {
  id: string;
  job_log_entry_id: string;
  model: string;
  predicted_label: string;
  predicted_confidence: CvConfidence;
  alternatives: string[];
  confirmed_label: string | null;
  confirmed_correct: boolean | null;
  confirmed_by_user_id: string | null;
  confirmed_at: string | null;
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

export async function insertCvLabel(args: {
  job_log_entry_id: string;
  model: string;
  predicted_label: string;
  predicted_confidence: CvConfidence;
  alternatives: string[];
  context?: Record<string, unknown>;
}): Promise<CvLabelRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(`${url}/rest/v1/cv_labels`, {
    method: "POST",
    headers: {
      ...adminHeaders(serviceRoleKey),
      Prefer: "return=representation",
    },
    body: JSON.stringify([
      {
        job_log_entry_id: args.job_log_entry_id,
        model: args.model,
        predicted_label: args.predicted_label,
        predicted_confidence: args.predicted_confidence,
        alternatives: args.alternatives,
        context: args.context ?? {},
      },
    ]),
  });
  if (!res.ok) {
    console.error(
      "[vision/store] insertCvLabel failed:",
      res.status,
      await res.text(),
    );
    return null;
  }
  const rows = (await res.json()) as CvLabelRow[];
  return rows[0] ?? null;
}

/**
 * Worker confirmation. `correct=true` copies predicted_label into
 * confirmed_label as-is; `correct=false` requires the worker to
 * supply the actual label so the anchor set stays clean.
 */
export async function confirmCvLabel(args: {
  id: string;
  user_id: string;
  correct: boolean;
  corrected_label?: string | null;
  /** The predicted_label the caller expects — used for correct=true. */
  predicted_label: string;
}): Promise<CvLabelRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const confirmed_label = args.correct
    ? args.predicted_label
    : (args.corrected_label?.trim() ?? "");
  if (!confirmed_label) return null;
  const res = await fetch(
    `${url}/rest/v1/cv_labels?id=eq.${encodeURIComponent(args.id)}`,
    {
      method: "PATCH",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        confirmed_label: confirmed_label.slice(0, 60),
        confirmed_correct: args.correct,
        confirmed_by_user_id: args.user_id,
        confirmed_at: new Date().toISOString(),
      }),
    },
  );
  if (!res.ok) {
    console.error(
      "[vision/store] confirmCvLabel failed:",
      res.status,
      await res.text(),
    );
    return null;
  }
  const rows = (await res.json()) as CvLabelRow[];
  return rows[0] ?? null;
}

export async function getCvLabelById(
  id: string,
): Promise<CvLabelRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/cv_labels?id=eq.${encodeURIComponent(id)}&select=*&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as CvLabelRow[];
  return rows[0] ?? null;
}

/**
 * The primary lookup — most recent prediction for a given job-log
 * entry. Used by the "confirm/correct" UI to render the sticky chip
 * over the photo.
 */
export async function getLatestCvLabelForEntry(
  job_log_entry_id: string,
): Promise<CvLabelRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const qs = new URLSearchParams();
  qs.set(
    "job_log_entry_id",
    `eq.${job_log_entry_id}`,
  );
  qs.set("order", "created_at.desc");
  qs.set("limit", "1");
  qs.set("select", "*");
  const res = await fetch(`${url}/rest/v1/cv_labels?${qs.toString()}`, {
    headers: adminHeaders(serviceRoleKey),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as CvLabelRow[];
  return rows[0] ?? null;
}
