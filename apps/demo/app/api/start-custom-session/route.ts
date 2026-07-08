import { API_KEY, API_URL, AVATAR_ID } from "../secrets";
import { assertCanMintSessionToken } from "../../../src/lib/liveavatarCredits";
import { getUserId } from "../../../src/lib/auth/getUser";
import { resolveLocaleForRequest } from "../../../src/lib/i18n/resolveLocale";
import { assertAllowedOrigin } from "../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../src/lib/rateLimit";

export async function POST(request: Request) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  const gate = await assertCanMintSessionToken();
  if (!gate.ok) {
    return new Response(JSON.stringify({ error: gate.message }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

  let session_token = "";
  let session_id = "";
  try {
    const res = await fetch(`${API_URL}/v1/sessions/token`, {
      method: "POST",
      headers: {
        "X-API-KEY": API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: "CUSTOM",
        avatar_id: AVATAR_ID,
        max_session_duration: 20 * 60, // 20 minutes (LiveAvatar API: seconds)
      }),
    });
    if (!res.ok) {
      const resp = await res.json();
      let errorMessage = "Failed to retrieve session token";

      // Handle different error response formats
      if (resp?.data && Array.isArray(resp.data) && resp.data.length > 0) {
        errorMessage = resp.data[0].message || errorMessage;
      } else if (resp?.data?.message) {
        errorMessage = resp.data.message;
      } else if (resp?.message) {
        errorMessage = resp.message;
      } else if (resp?.error) {
        errorMessage = resp.error;
      }

      return new Response(JSON.stringify({ error: errorMessage }), {
        status: res.status,
      });
    }
    const data = await res.json();

    session_token = data.data.session_token;
    session_id = data.data.session_id;
  } catch (error: unknown) {
    console.error("start-custom-session:", error);
    return new Response(
      JSON.stringify({ error: "Failed to retrieve session token" }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  if (!session_token) {
    return new Response(
      JSON.stringify({ error: "Failed to retrieve session token" }),
      {
        status: 500,
      },
    );
  }

  // M1.6b — return resolved locale so the client knows which language
  // to use for downstream ElevenLabs TTS / chat calls. CUSTOM mode
  // doesn't pass `language` to HeyGen (TTS happens client-side via
  // ElevenLabs), so the locale flows through the response instead.
  const userId = await getUserId();
  const locale = await resolveLocaleForRequest({
    userId,
    acceptLanguage: request.headers.get("accept-language"),
  });

  return new Response(JSON.stringify({ session_token, session_id, locale }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
}
