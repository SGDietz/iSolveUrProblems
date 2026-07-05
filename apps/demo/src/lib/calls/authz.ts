import { getSupabaseAdminConfig } from "../supabaseAdmin";

/**
 * Nuisance-call defense (M3.1 + M4.9).
 *
 * Only allow starting an outbound Twilio call — remote 3-way (M3.1) or
 * in-person go-between (M4.9) — when the homeowner has a legit prior
 * connection to the target contractor. Without this, any signed-in
 * user could cause Twilio to dial any contractor whose row exists,
 * costing money and creating a harassment vector.
 *
 * Signals accepted (any one is sufficient):
 *   - contracts row with (user_id, contractor_id)
 *   - appointments row with (user_id, contractor_id)
 *   - calls row with (user_id, contractor_id)
 *
 * Runs three PostgREST HEAD-shaped SELECTs in parallel and short-
 * circuits on the first hit. Uses the service role, so RLS on the
 * underlying tables does not gate this — the (user_id, contractor_id)
 * filter is the primary authorization.
 */
export async function userKnowsContractor(args: {
  user_id: string;
  contractor_id: string;
}): Promise<boolean> {
  const { url, serviceRoleKey } = getSupabaseAdminConfig();
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
  const uid = encodeURIComponent(args.user_id);
  const cid = encodeURIComponent(args.contractor_id);
  const paths = [
    `contracts?user_id=eq.${uid}&contractor_id=eq.${cid}&select=id&limit=1`,
    `appointments?user_id=eq.${uid}&contractor_id=eq.${cid}&select=id&limit=1`,
    `calls?user_id=eq.${uid}&contractor_id=eq.${cid}&select=id&limit=1`,
  ];
  const results = await Promise.all(
    paths.map((p) =>
      fetch(`${url}/rest/v1/${p}`, { headers, cache: "no-store" })
        .then(async (r) =>
          r.ok ? ((await r.json()) as unknown[]).length > 0 : false,
        )
        .catch(() => false),
    ),
  );
  return results.some(Boolean);
}
