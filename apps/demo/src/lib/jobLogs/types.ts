/**
 * M4.5 — Job log types.
 *
 * Mirrors columns in 20260630_m4_job_logs.sql.
 */

export type JobLogKind = "photo" | "video" | "note";
export type JobLogPhase = "arrival" | "in_progress" | "completion";

export type JobLogEntryRow = {
  id: string;
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
  ai_caption: string | null;
  context: Record<string, unknown>;
  taken_at: string;
  created_at: string;
};

/** View enriched with a short-lived signed URL for display. */
export type JobLogEntryView = JobLogEntryRow & {
  signed_url: string | null;
};
