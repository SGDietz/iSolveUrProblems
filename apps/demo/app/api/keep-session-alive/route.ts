import {
  assertAllowedOrigin,
  authorizationBearerHeader,
  parseSafeBearerToken,
} from "../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../src/lib/rateLimit";
import { API_URL } from "../secrets";

export async function POST(request: Request) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;
  try {
    const body = await request.json();
    const token = parseSafeBearerToken(body?.session_token);

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

    const res = await fetch(`${API_URL}/v1/sessions/keep-alive`, {
      method: "POST",
      headers: {
        Authorization: authorizationBearerHeader(token),
        "Content-Type": "application/json",
      },
    });

    if (!res.ok) {
      const errorData = await res.json();
      console.error("Error keeping session alive:", errorData);
      return new Response(
        JSON.stringify({
          error: errorData.data?.message || "Failed to keep session alive",
        }),
        {
          status: res.status,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "Session kept alive successfully",
      }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  } catch (error) {
    console.error("Error keeping session alive:", error);
    return new Response(
      JSON.stringify({ error: "Failed to keep session alive" }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }
}
