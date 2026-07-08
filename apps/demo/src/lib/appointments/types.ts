/**
 * M3.4 + M3.5 — Appointment types.
 *
 * Mirrors the columns in 20260610_appointments.sql.
 */

export type AppointmentStatus =
  | "scheduled"
  | "rescheduled"
  | "cancelled"
  | "completed"
  | "no_show";

export type AppointmentRow = {
  id: string;
  user_id: string;
  contractor_id: string | null;
  contract_id: string | null;
  scheduled_at: string;
  duration_minutes: number;
  agenda: string;
  status: AppointmentStatus;
  reminder_24h_sent_at: string | null;
  reminder_2h_sent_at: string | null;
  /** M4.3 — set once the pre-departure checklist notification fires. */
  checklist_notified_at: string | null;
  /**
   * M4.4 — set when the contractor confirms arrival (explicit tap in the
   * dashboard, or implicitly by uploading a job-log photo). Absence past
   * scheduled_at + grace window triggers the no-show detector.
   */
  contractor_confirmed_at: string | null;
  /** M4.4 — set the moment the appointment is flipped to no_show. Idempotency gate. */
  no_show_detected_at: string | null;
  /** M4.4 — points at the substitute appointment once dispatch succeeds. */
  replaced_by_appointment_id: string | null;
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type CreateAppointmentInput = {
  user_id: string;
  contractor_id?: string | null;
  contract_id?: string | null;
  scheduled_at: string;        // ISO UTC
  duration_minutes?: number;   // default 60
  agenda?: string;
  context?: Record<string, unknown>;
};

export type RescheduleAppointmentInput = {
  appointment_id: string;
  user_id: string;
  new_scheduled_at: string;    // ISO UTC
  reason?: string;
};
