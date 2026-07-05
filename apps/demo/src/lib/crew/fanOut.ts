import { searchContractors } from "../contractors/search";
import { getSupabaseAdminConfig } from "../supabaseAdmin";
import { send } from "../notifications";
import type { ContractorRow } from "../contractors/types";
import type { CrewRequestRow } from "./types";
import { insertCrewResponses } from "./store";
import { APP_PUBLIC_BASE_URL } from "../../../app/api/secrets";

/**
 * M4.2 — Crew invitation fan-out.
 *
 * Given a freshly-inserted crew_requests row, find same-day-capable
 * helper contractors in the requester's area and invite the top N.
 *
 * Same M2.1 recommender, invoked in `same_day=true` mode. Excludes the
 * requester from its own request.
 *
 * Invitations only fire to contractors with a `claimed_by_user_id`
 * (they'd have no dashboard inbox to respond in otherwise) AND an
 * email on file.
 */

const DEFAULT_FANOUT_N = 6;

function adminHeaders(serviceRoleKey: string) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

async function fetchRequesterCoords(
  contractor_id: string,
): Promise<{ lat: number; lng: number; name: string } | null> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const res = await fetch(
    `${url}/rest/v1/contractors?id=eq.${encodeURIComponent(
      contractor_id,
    )}&select=lat,lng,name&limit=1`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{
    lat: number | null;
    lng: number | null;
    name: string;
  }>;
  const row = rows[0];
  if (!row || row.lat == null || row.lng == null) return null;
  return { lat: row.lat, lng: row.lng, name: row.name };
}

async function filterInvitableContractors(
  candidateIds: string[],
): Promise<ContractorRow[]> {
  if (candidateIds.length === 0) return [];
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const inList = candidateIds.map((id) => `"${id}"`).join(",");
  const res = await fetch(
    `${url}/rest/v1/contractors?id=in.(${inList})&claimed_by_user_id=not.is.null&email=not.is.null&select=*`,
    { headers: adminHeaders(serviceRoleKey), cache: "no-store" },
  );
  if (!res.ok) return [];
  return (await res.json()) as ContractorRow[];
}

export type CrewFanOutOutput = {
  request_id: string;
  invited: Array<{
    contractor_id: string;
    name: string;
    email: string | null;
    delivered: boolean;
    rank_score: number;
    distance_km: number | null;
    error?: string;
  }>;
  total_considered: number;
  skipped_reason?: string;
};

export async function runCrewFanOut(
  request: CrewRequestRow,
  opts?: { max_fanout?: number },
): Promise<CrewFanOutOutput> {
  const max = Math.min(Math.max(opts?.max_fanout ?? DEFAULT_FANOUT_N, 1), 20);
  const requester = await fetchRequesterCoords(request.requester_contractor_id);
  if (!requester) {
    return {
      request_id: request.id,
      invited: [],
      total_considered: 0,
      skipped_reason: "requester_missing_coords",
    };
  }

  const search = await searchContractors({
    category: request.category,
    near: { lat: requester.lat, lng: requester.lng },
    radius_km: request.radius_km,
    same_day: true,
    limit: max * 3, // over-fetch, then filter to invitables
  });

  const eligibleIds = search.hits
    .map((h) => h.id)
    .filter((id) => id !== request.requester_contractor_id);
  const invitables = await filterInvitableContractors(eligibleIds);
  const invitableById = new Map(invitables.map((c) => [c.id, c] as const));

  // Preserve M2.2 rank order but drop non-invitables.
  const finalHits = search.hits
    .filter((h) => invitableById.has(h.id))
    .filter((h) => h.id !== request.requester_contractor_id)
    .slice(0, max);

  const invited: CrewFanOutOutput["invited"] = [];
  const responsesToInsert: Parameters<typeof insertCrewResponses>[0] = [];

  const dashboardUrl = APP_PUBLIC_BASE_URL
    ? `${APP_PUBLIC_BASE_URL}/en/contractor/dashboard`
    : "/en/contractor/dashboard";

  for (const hit of finalHits) {
    const helper = invitableById.get(hit.id)!;
    let delivered = false;
    let error: string | undefined;
    let notification_row_id: string | null = null;
    if (helper.email) {
      const result = await send({
        channel: "email",
        recipient: helper.email,
        templateId: "crew.invitation.v1",
        data: {
          recipientName: helper.name,
          requesterName: requester.name,
          category: request.category,
          neededAtText: new Date(request.needed_at).toLocaleString(),
          scope: request.scope,
          distanceKm: Math.round(hit.distance_km),
          dashboardUrl,
        },
        context: {
          crew_request_id: request.id,
          invitee_contractor_id: helper.id,
        },
      });
      delivered = result.ok;
      if (!result.ok) error = result.error;
      notification_row_id = result.row_id ?? null;
    } else {
      error = "no_email";
    }
    invited.push({
      contractor_id: helper.id,
      name: helper.name,
      email: helper.email,
      delivered,
      rank_score: hit.score,
      distance_km: hit.distance_km,
      ...(error ? { error } : {}),
    });
    responsesToInsert.push({
      crew_request_id: request.id,
      invitee_contractor_id: helper.id,
      rank_score: hit.score,
      distance_km: hit.distance_km,
      notification_row_id,
    });
  }

  await insertCrewResponses(responsesToInsert);

  return {
    request_id: request.id,
    invited,
    total_considered: search.total_considered,
  };
}
