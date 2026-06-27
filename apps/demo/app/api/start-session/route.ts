import {
  API_KEY,
  API_URL,
  AVATAR_ID,
  VOICE_ID,
  CONTEXT_ID,
  LANGUAGE,
} from "../secrets";
import { assertCanMintSessionToken } from "../../../src/lib/liveavatarCredits";
import { getUserId } from "../../../src/lib/auth/getUser";
import { getSupabaseServer } from "../../../src/lib/auth/supabaseServer";
import { resolveLocaleForRequest } from "../../../src/lib/i18n/resolveLocale";
import { mapLocaleToAvatarLanguage } from "../../../src/lib/i18n/avatarLanguage";

const ISOLVE_SUPABASE_REF = "dphxcqjkzhvsdejtxdcj";
const AIASAP_SUPABASE_REF = "wqszxsqzkaatghyrqviv";

/** Resume memory saved at signup (account_email_links.captured_lists). Best-effort:
 *  never throws into session start. Reads the latest row for this email and builds
 *  a short "you've talked before" summary so 6 picks up where the user left off. */
async function loadResumeMemoryFromLinks(
  email: string,
): Promise<{ name: string; summary: string }> {
  const empty = { name: "", summary: "" };
  if (!email) return empty;
  const supaUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !serviceRoleKey) return empty;
  // Wrong-DB guard: only iSolve's project.
  if (!supaUrl.includes(ISOLVE_SUPABASE_REF) || supaUrl.includes(AIASAP_SUPABASE_REF)) return empty;
  try {
    const res = await fetch(
      `${supaUrl}/rest/v1/account_email_links?email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1&select=captured_lists`,
      { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } },
    );
    if (!res.ok) return empty;
    const rows = (await res.json()) as Array<{
      captured_lists?: { fullName?: unknown; resumeState?: { recentConversation?: unknown } } | null;
    }>;
    const cap = rows?.[0]?.captured_lists;
    if (!cap) return empty;
    const name = typeof cap.fullName === "string" ? cap.fullName.trim() : "";
    const convo = cap.resumeState?.recentConversation;
    const lines: string[] = [];
    if (Array.isArray(convo)) {
      let prev = "";
      for (const turn of convo) {
        const t = turn as { role?: unknown; text?: unknown };
        const text = typeof t.text === "string" ? t.text.trim() : "";
        if (!text) continue;
        const who = t.role === "assistant" ? "6" : "User";
        const line = `${who}: ${text}`;
        if (line === prev) continue; // drop STT double-fires
        prev = line;
        lines.push(line);
      }
    }
    if (!name && lines.length === 0) return empty;
    const parts: string[] = [
      "You've talked with this user before — use what you know naturally, don't recite it or announce that you remember.",
    ];
    if (name) parts.push(`Their name is ${name}.`);
    if (lines.length > 0) {
      const tail = lines.slice(-20);
      parts.push(`Recent conversation before they left (oldest first, newest last):\n${tail.join("\n")}`);
    }
    return { name, summary: parts.join("\n") };
  } catch {
    return empty;
  }
}

/** Per-session dynamic_variables for iSolve-6's context (459ae665). Signed-in →
 *  greet by name + recent memory; anonymous → blank + first-meet marker. */
async function buildDynamicVariables(): Promise<Record<string, string>> {
  const vars: Record<string, string> = {
    user_signed_in: "false",
    user_name: "",
    user_memory_summary: "",
  };
  try {
    const supabase = await getSupabaseServer();
    const { data, error } = await supabase.auth.getUser();
    const user = data?.user;
    if (error || !user?.email) return vars;
    vars.user_signed_in = "true";
    const resume = await loadResumeMemoryFromLinks(user.email);
    const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
    const name =
      typeof meta.full_name === "string" && meta.full_name.trim()
        ? meta.full_name.trim()
        : typeof meta.fullName === "string" && meta.fullName.trim()
          ? (meta.fullName as string).trim()
          : resume.name
            ? resume.name
            : user.email.split("@")[0];
    if (name) vars.user_name = name.slice(0, 64);
    if (resume.summary) vars.user_memory_summary = resume.summary.slice(0, 950); // LiveAvatar var cap
  } catch (e) {
    console.error("buildDynamicVariables failed:", e);
  }
  return vars;
}

export async function POST(request: Request) {
  const gate = await assertCanMintSessionToken();
  if (!gate.ok) {
    return new Response(JSON.stringify({ error: gate.message }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
  }

  // M1.6b — vision ¶26: avatar speaks in the user's language.
  // Falls back to LIVEAVATAR_LANGUAGE env for anonymous callers whose
  // Accept-Language doesn't match a supported locale.
  const userId = await getUserId();
  const locale = await resolveLocaleForRequest({
    userId,
    acceptLanguage: request.headers.get("accept-language"),
  });
  const avatarLanguage = mapLocaleToAvatarLanguage(locale, LANGUAGE);

  let session_token = "";
  let session_id = "";
  try {
    // Account memory → 6 greets returners by name with their context (fail-soft).
    const dynamicVariables = await buildDynamicVariables();

    const res = await fetch(`${API_URL}/v1/sessions/token`, {
      method: "POST",
      headers: {
        "X-API-KEY": API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        mode: "FULL",
        avatar_id: AVATAR_ID,
        max_session_duration: 20 * 60, // 20 minutes (LiveAvatar API: seconds)
        avatar_persona: {
          voice_id: VOICE_ID,
          context_id: CONTEXT_ID,
          language: avatarLanguage,
        },
        // Patient turn-taking — fewer barge-ins / 6 talking over the user.
        turn_eagerness: "patient",
        // Per-session cw values: ${user_name}, ${user_memory_summary},
        // ${user_signed_in} render at session start for THIS user.
        dynamic_variables: dynamicVariables,
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
  } catch (error) {
    console.error("Error retrieving session token:", error);
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
        headers: { "Content-Type": "application/json" },
      },
    );
  }
  return new Response(
    JSON.stringify({ session_token, session_id, locale, language: avatarLanguage }),
    {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    },
  );
}
