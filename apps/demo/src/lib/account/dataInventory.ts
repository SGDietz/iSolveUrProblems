/**
 * The single source of truth for WHERE a user's personal data lives.
 * Both the data export (gather) and the account purge (delete) consume
 * these lists, so a download is always a complete copy of exactly what
 * deletion erases — the aiASAP "one table list, two consumers" doctrine,
 * except here the list really is one module (aiASAP duplicated it in two
 * files; the release test asserts ours stay equal).
 *
 * Two mechanical classes, driven by the actual FK actions in
 * supabase/migrations/:
 *
 * - CASCADE tables vanish on their own when the auth user is deleted
 *   (user_id ... ON DELETE CASCADE, or PK = auth.users.id). The purge
 *   never has to touch them — but the export still reads them.
 * - EXPLICIT tables survive an auth-user delete (ON DELETE SET NULL, or
 *   no FK at all — the legacy aiASAP-era session tables). Left alone
 *   they'd keep orphaned PII rows (emails, phones, names, transcripts),
 *   so the purge deletes them by hand BEFORE the auth delete.
 */

/** Deleted automatically by the auth-user CASCADE. Export reads these. */
export const CASCADE_TABLES = [
  "users",
  "transcripts",
  "user_memory_facts",
  "reports",
  "contracts",
  "appointments",
  "calls",
  "estimates",
  "disputes", // dispute_messages cascade from disputes
  "lists", // list_items carry their own user_id CASCADE too
  "list_items",
  "recurring_jobs",
  "job_log_entries",
  "crew_requests",
  "contractor_claim_attempts",
] as const;

/** Survive the CASCADE (SET NULL / no FK) — purge deletes these by hand. */
export const EXPLICIT_PURGE_TABLES = [
  "conversation_messages",
  "transcript_events",
  "lead_sessions",
  "contact_entities",
  "media_events",
  "media_assets",
  "notifications_sent",
  "error_logs",
  "app_events",
  "feature_requests",
] as const;

/**
 * Keyed by EMAIL, not user_id — the voice magic-link table. Swept by
 * email during purge; also swept: notifications_sent rows whose
 * recipient is the account email but whose user_id was never linked.
 */
export const EMAIL_KEYED_TABLES = ["account_email_links"] as const;

/**
 * Storage buckets holding user OBJECTS (not just rows) + the table/column
 * that records each object's path. Purge deletes the objects first, then
 * the rows.
 */
export const STORAGE_SOURCES = [
  { bucket: "reports", table: "reports", pathColumns: ["html_path", "pdf_path"] },
  { bucket: "call-recordings", table: "calls", pathColumns: ["storage_recording_path"] },
  { bucket: "session-media", table: "media_assets", pathColumns: ["storage_path"] },
  { bucket: "isolve-media", table: "media_events", pathColumns: ["storage_path"] },
  { bucket: "job-logs", table: "job_log_entries", pathColumns: ["storage_path"] },
] as const;

/**
 * Everything the export gathers, per user_id. CASCADE + EXPLICIT — the
 * complete per-user footprint. (account_email_links is gathered by email
 * separately; its token_hash column is never exported.)
 */
export const EXPORT_TABLES = [
  ...CASCADE_TABLES,
  ...EXPLICIT_PURGE_TABLES,
] as const;

export type ExportTable = (typeof EXPORT_TABLES)[number];
