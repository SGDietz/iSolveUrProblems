import { getSupabaseAdminConfig } from "../supabaseAdmin";
import type {
  CrewInvitationView,
  CrewRequestRow,
  CrewResponseRow,
  CrewResponseStatus,
  CrewResponseWithInvitee,
} from "./types";

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

export type CreateCrewRequestInput = {
  requester_contractor_id: string;
  requester_user_id: string;
  category: string;
  needed_at: string; // ISO
  radius_km: number;
  scope: string;
  appointment_id: string | null;
  context?: Record<string, unknown>;
};

export async function insertCrewRequest(
  input: CreateCrewRequestInput,
): Promise<CrewRequestRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const row = {
    requester_contractor_id: input.requester_contractor_id,
    requester_user_id: input.requester_user_id,
    category: input.category,
    needed_at: input.needed_at,
    radius_km: input.radius_km,
    scope: input.scope,
    appointment_id: input.appointment_id,
    context: input.context ?? {},
  };
  const res = await fetch(`${url}/rest/v1/crew_requests`, {
    method: "POST",
    headers: {
      ...adminHeaders(serviceRoleKey),
      Prefer: "return=representation",
    },
    body: JSON.stringify([row]),
  });
  if (!res.ok) {
    console.error(
      "[crew/store] insertCrewRequest failed:",
      res.status,
      await res.text().catch(() => ""),
    );
    return null;
  }
  const rows = (await res.json()) as CrewRequestRow[];
  return rows[0] ?? null;
}

export type InsertCrewResponseInput = {
  crew_request_id: string;
  invitee_contractor_id: string;
  rank_score: number;
  distance_km: number | null;
  notification_row_id: string | null;
};

/**
 * Insert one response row per invited contractor. Idempotent on the
 * unique (request_id, invitee_id) constraint — a duplicate is silently
 * skipped and the caller gets null for that row.
 */
export async function insertCrewResponses(
  inputs: InsertCrewResponseInput[],
): Promise<CrewResponseRow[]> {
  if (inputs.length === 0) return [];
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const rows = inputs.map((i) => ({
    crew_request_id: i.crew_request_id,
    invitee_contractor_id: i.invitee_contractor_id,
    rank_score: i.rank_score,
    distance_km: i.distance_km,
    notification_row_id: i.notification_row_id,
  }));
  const res = await fetch(
    `${url}/rest/v1/crew_request_responses?on_conflict=crew_request_id,invitee_contractor_id`,
    {
      method: "POST",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=representation,resolution=ignore-duplicates",
      },
      body: JSON.stringify(rows),
    },
  );
  if (!res.ok) {
    console.error(
      "[crew/store] insertCrewResponses failed:",
      res.status,
      await res.text().catch(() => ""),
    );
    return [];
  }
  return (await res.json()) as CrewResponseRow[];
}

export async function getCrewRequestById(
  id: string,
): Promise<CrewRequestRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/crew_requests?id=eq.${encodeURIComponent(
      id,
    )}&select=*&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as CrewRequestRow[];
  return rows[0] ?? null;
}

export async function listOpenRequestsForContractor(
  requester_contractor_id: string,
): Promise<CrewRequestRow[]> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const qs = new URLSearchParams();
  qs.set("requester_contractor_id", `eq.${requester_contractor_id}`);
  qs.set("order", "created_at.desc");
  qs.set("limit", "20");
  qs.set("select", "*");
  const res = await fetch(
    `${url}/rest/v1/crew_requests?${qs.toString()}`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return [];
  return (await res.json()) as CrewRequestRow[];
}

/**
 * List responses on a specific request enriched with the invitee's
 * public-ish contractor fields, ordered by rank_score desc.
 */
export async function listResponsesForRequest(
  crew_request_id: string,
): Promise<CrewResponseWithInvitee[]> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const qs = new URLSearchParams();
  qs.set("crew_request_id", `eq.${crew_request_id}`);
  qs.set("order", "rank_score.desc");
  qs.set("limit", "50");
  qs.set(
    "select",
    "*,invitee:contractors!invitee_contractor_id(name,city,state,phone,email)",
  );
  const res = await fetch(
    `${url}/rest/v1/crew_request_responses?${qs.toString()}`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<
    CrewResponseRow & {
      invitee: {
        name: string;
        city: string | null;
        state: string | null;
        phone: string | null;
        email: string | null;
      } | null;
    }
  >;
  return rows.map((r) => ({
    ...r,
    invitee_name: r.invitee?.name ?? "unknown",
    invitee_city: r.invitee?.city ?? null,
    invitee_state: r.invitee?.state ?? null,
    invitee_phone: r.invitee?.phone ?? null,
    invitee_email: r.invitee?.email ?? null,
  }));
}

/**
 * List invitations addressed to a given helper contractor (their
 * inbox). Joined to the request + requester name for one-shot display.
 */
export async function listInvitationsForInvitee(
  invitee_contractor_id: string,
): Promise<CrewInvitationView[]> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const qs = new URLSearchParams();
  qs.set("invitee_contractor_id", `eq.${invitee_contractor_id}`);
  qs.set("status", "in.(invited,accepted,declined)");
  qs.set("order", "created_at.desc");
  qs.set("limit", "20");
  qs.set(
    "select",
    "*,request:crew_requests!crew_request_id(*,requester:contractors!requester_contractor_id(name,city,state))",
  );
  const res = await fetch(
    `${url}/rest/v1/crew_request_responses?${qs.toString()}`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return [];
  const rows = (await res.json()) as Array<
    CrewResponseRow & {
      request: (CrewRequestRow & {
        requester: {
          name: string;
          city: string | null;
          state: string | null;
        } | null;
      }) | null;
    }
  >;
  const out: CrewInvitationView[] = [];
  for (const r of rows) {
    if (!r.request) continue;
    out.push({
      ...r,
      request: r.request,
      requester_name: r.request.requester?.name ?? "unknown",
      requester_city: r.request.requester?.city ?? null,
      requester_state: r.request.requester?.state ?? null,
    });
  }
  return out;
}

export async function setResponseStatus(args: {
  response_id: string;
  invitee_contractor_id: string;
  new_status: CrewResponseStatus;
}): Promise<CrewResponseRow | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const patch: Record<string, unknown> = {
    status: args.new_status,
    responded_at:
      args.new_status === "accepted" || args.new_status === "declined"
        ? new Date().toISOString()
        : null,
  };
  const res = await fetch(
    `${url}/rest/v1/crew_request_responses?id=eq.${encodeURIComponent(
      args.response_id,
    )}&invitee_contractor_id=eq.${encodeURIComponent(
      args.invitee_contractor_id,
    )}`,
    {
      method: "PATCH",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as CrewResponseRow[];
  return rows[0] ?? null;
}

/**
 * First-accept wins: patch the crew_requests row to status='filled'
 * only if it's still open. Returns true when THIS accept was the one
 * that flipped the state (so the caller can trigger the "you won"
 * side effects). Postgrest's `status=eq.open` guard makes this a
 * compare-and-swap.
 */
export async function markRequestFilledIfOpen(args: {
  crew_request_id: string;
  filled_by_contractor_id: string;
}): Promise<boolean> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/crew_requests?id=eq.${encodeURIComponent(
      args.crew_request_id,
    )}&status=eq.open`,
    {
      method: "PATCH",
      headers: {
        ...adminHeaders(serviceRoleKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        status: "filled",
        filled_by_contractor_id: args.filled_by_contractor_id,
        filled_at: new Date().toISOString(),
      }),
    },
  );
  if (!res.ok) return false;
  const rows = (await res.json()) as CrewRequestRow[];
  return rows.length === 1;
}

export async function cancelRequest(args: {
  crew_request_id: string;
  requester_user_id: string;
}): Promise<boolean> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/crew_requests?id=eq.${encodeURIComponent(
      args.crew_request_id,
    )}&requester_user_id=eq.${encodeURIComponent(
      args.requester_user_id,
    )}&status=eq.open`,
    {
      method: "PATCH",
      headers: { ...adminHeaders(serviceRoleKey), Prefer: "return=minimal" },
      body: JSON.stringify({ status: "cancelled" }),
    },
  );
  return res.ok;
}
