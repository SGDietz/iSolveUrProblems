import {
  authorizationBearerHeader,
  parseSafeBearerToken,
} from "../../../src/lib/apiRouteSecurity";
import { API_URL } from "../secrets";
import { recordSessionStreamStopped } from "../../../src/lib/liveavatarCredits";
import { assertAllowedOrigin } from "../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../src/lib/rateLimit";

export async function POST(request: Request) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  // NOTE: no in-app caller as of 2026-07-03 (the live path is
  // /api/v1/sessions/stop) — patched for symmetry anyway so ANY valid stop
  // request closes the local usage key (Herm TASK_098 D).
  let token: string | null = null;
  try {
    const body = await request.json();
    token = parseSafeBearerToken(body?.session_token);

    if (!token) {
      return new Response(
        JSON.stringify({ error: "session_token is required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    const res = await fetch(`${API_URL}/v1/sessions`, {
      method: "DELETE",
      headers: {
        Authorization: authorizationBearerHeader(token),
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const errorData = await res.json();
      console.error("Error stopping session:", errorData);
      // Idempotent local accounting even on noisy upstream (Herm TASK_098 D).
      await recordSessionStreamStopped(token).catch(() => {});
      return new Response(
        JSON.stringify({
          error: errorData.data?.message || "Failed to stop session",
        }),
        {
          status: res.status,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    await recordSessionStreamStopped(token);

    return new Response(
      JSON.stringify({
        success: true,
        message: "Session stopped successfully",
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error stopping session:", error);
    if (token) await recordSessionStreamStopped(token).catch(() => {});
    return new Response(JSON.stringify({ error: "Failed to stop session" }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
}
