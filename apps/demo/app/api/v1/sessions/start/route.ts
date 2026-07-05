import { API_URL } from "../../../secrets";
import {
  authorizationBearerHeader,
  sessionTokenFromRequestAuthHeader,
} from "../../../../../src/lib/apiRouteSecurity";
import {
  isLiveAvatarSuccessPayload,
  recordSessionStreamStarted,
} from "../../../../../src/lib/liveavatarCredits";
import { assertAllowedOrigin } from "../../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../../src/lib/rateLimit";

export async function POST(request: Request) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  const token = sessionTokenFromRequestAuthHeader(
    request.headers.get("Authorization"),
  );
  if (!token) {
    return new Response(
      JSON.stringify({
        code: 403,
        data: { message: "Authorization required" },
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
  }
  if (!API_URL) {
    return new Response(
      JSON.stringify({
        code: 500,
        data: { message: "LIVEAVATAR_API_URL is not configured" },
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
  try {
    const res = await fetch(`${API_URL}/v1/sessions/start`, {
      method: "POST",
      headers: {
        Authorization: authorizationBearerHeader(token),
        "Content-Type": "application/json",
      },
    });
    const data = await res.json();
    if (res.ok && isLiveAvatarSuccessPayload(data)) {
      await recordSessionStreamStarted(token);
    }
    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Session start proxy error:", err);
    return new Response(
      JSON.stringify({
        code: 500,
        data: { message: "Session start failed" },
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
