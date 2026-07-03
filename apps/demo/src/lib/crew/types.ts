/**
 * M4.2 — Crew marketplace types.
 *
 * Mirrors columns in 20260701_m4_crew_marketplace.sql.
 */

export type CrewRequestStatus = "open" | "filled" | "expired" | "cancelled";
export type CrewResponseStatus =
  | "invited"
  | "accepted"
  | "declined"
  | "expired"
  | "no_response";

export type CrewRequestRow = {
  id: string;
  requester_contractor_id: string;
  requester_user_id: string;
  category: string;
  needed_at: string;
  radius_km: number;
  scope: string;
  appointment_id: string | null;
  status: CrewRequestStatus;
  filled_by_contractor_id: string | null;
  filled_at: string | null;
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type CrewResponseRow = {
  id: string;
  crew_request_id: string;
  invitee_contractor_id: string;
  rank_score: number;
  distance_km: number | null;
  status: CrewResponseStatus;
  notification_row_id: string | null;
  responded_at: string | null;
  context: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

/** Response row joined to invitee contractor for display. */
export type CrewResponseWithInvitee = CrewResponseRow & {
  invitee_name: string;
  invitee_city: string | null;
  invitee_state: string | null;
  invitee_phone: string | null;
  invitee_email: string | null;
};

/** Response row joined to the requester + request for the invitee's inbox. */
export type CrewInvitationView = CrewResponseRow & {
  request: CrewRequestRow;
  requester_name: string;
  requester_city: string | null;
  requester_state: string | null;
};
