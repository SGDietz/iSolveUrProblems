import { API_URL } from "../../../secrets";
import {
  authorizationBearerHeader,
  sessionTokenFromRequestAuthHeader,
} from "../../../../../src/lib/apiRouteSecurity";
import {
  isLiveAvatarSuccessPayload,
  recordSessionStreamStopped,
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
    const res = await fetch(`${API_URL}/v1/sessions/stop`, {
      method: "POST",
      headers: {
        Authorization: authorizationBearerHeader(token),
        "Content-Type": "application/json",
      },
    });
    const data = await res.json();
    // The local stream-duration guard is idempotent (Herm TASK_098 D). A
    // valid local stop request closes the local usage key even when the
    // upstream stop confirmation is noisy — otherwise a LiveAvatar 500
    // leaves usage uncounted until TTL (money-cap undercount).
    await recordSessionStreamStopped(token);
    if (res.ok && !isLiveAvatarSuccessPayload(data)) {
      console.warn(
        "Session stop returned ok but unexpected LiveAvatar payload",
        data,
      );
    }
    return new Response(JSON.stringify(data), {
      status: res.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("Session stop proxy error:", err);
    await recordSessionStreamStopped(token).catch(() => {});
    return new Response(
      JSON.stringify({
        code: 500,
        data: { message: "Session stop failed" },
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
