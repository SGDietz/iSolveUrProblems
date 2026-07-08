import { NextResponse, type NextRequest } from "next/server";
import { checkRateLimit } from "../../../src/lib/rateLimit";
import {
  assertAllowedOrigin,
  isSafeTranscriptionSessionId,
} from "../../../src/lib/apiRouteSecurity";
import { getSupabaseAdminConfig } from "../../../src/lib/supabaseAdmin";
import {
  buildPromptBrainFallback,
  buildPromptBrainUserMessage,
  cleanPromptBrainText,
  derivePromptBrainSubject,
  isPromptBrainContextOnlyText,
  sanitizePills,
} from "../../../src/lib/promptBrain";
import {
  getListContextPrompts,
  normalizeListContext,
} from "../../../src/lib/promptBrain/listContextPrompts";
import { GEMINI_API_KEY, OPENAI_API_KEY } from "../secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * POST /api/prompt-brain — iSolve port of aiASAP's pill brain (G smoke #7
 * 2026-07-03: "the pillboxes don't change anything… it's been saying stuck
 * window the entire time… Everything is in aiASAP"). Takes what the user
 * just said and returns THREE short pill labels matched to the CURRENT
 * subject or a curated forward-action fallback. Fail-soft by contract:
 * provider/parse trouble falls back to a deterministic local set; only
 * deliberately too-short input returns { prompts: null }. aiASAP's "old goes
 * out, new comes in" remains on the client, but the route itself avoids the
 * frozen-pill null path.
 *
 * Provider: OpenAI (gpt-4o-mini, house model) when the key exists, else
 * Gemini flash (the key present in every Vercel env). 6s abort either way.
 */

const SYSTEM_PROMPT = [
  "You suggest tap-pill labels for a home-repair voice assistant called 6.",
  "Return STRICT JSON: {\"prompts\":[\"...\",\"...\",\"...\"]} — exactly 3 labels.",
  "Each label: 1-3 plain everyday words, max 18 characters, Title Case, no punctuation, no emojis.",
  "The labels are buttons that pull the user forward into the NEXT useful thing to say or do. They must help a stuck user keep talking.",
  "Every label should feel like a good next sentence the user can tap or say to 6, not a label about what already happened.",
  "Use action words when natural: Find, Get, Fix, Show, Book, Compare, Tell.",
  "Bias toward diagnosis, photo/video, cost, finding pros, comparing pros, and the next concrete home/garden step.",
  "Do not summarize what just happened. Do not echo the subject name by itself. Suggest the next move.",
  "Device/app context like 'my computer', 'my phone', 'no internet', or 'on the tablet' is NOT a repair subject unless the user names a broken home/garden object. Never turn those words into pills.",
  "Never invent names, contacts, reminders, or app features. Never mention email, sign-in, login, zip code, contact, reminders, or generic 'Get Help'.",
].join(" ");

type PromptBrainLog = {
  status:
    | "provider_ok"
    | "fallback_ok"
    | "short_input"
    | "context_only"
    | "no_provider"
    | "provider_empty"
    | "list_context_ok"
    | "json_parse_fail"
    | "pill_sanitize_fail"
    | "exception";
  latestUserText: string;
  currentSubject: string;
  derivedSubject: string;
  currentPrompts?: string[];
  prompts?: string[] | null;
  providerTried?: string[];
  rawTextSample?: string | null;
  error?: string;
};

async function askOpenAi(user: string, signal: AbortSignal): Promise<string | null> {
  // Fail FAST: without a per-call cap a stalled OpenAI call ate the whole
  // outer budget before Gemini/fallback got a turn (Herm TASK_144 Patch C —
  // G 13:11: "pillboxes need to be faster on point").
  const perCall = new AbortController();
  const onOuterAbort = () => perCall.abort();
  if (signal.aborted) perCall.abort();
  else signal.addEventListener("abort", onOuterAbort, { once: true });
  const perCallTimer = setTimeout(() => perCall.abort(), 1800);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: perCall.signal,
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        response_format: { type: "json_object" },
        max_tokens: 60,
        temperature: 0.4,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(perCallTimer);
    signal.removeEventListener("abort", onOuterAbort);
  }
}

const PROMPT_BRAIN_GEMINI_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash"] as const;

async function askGemini(user: string, signal: AbortSignal): Promise<string | null> {
  for (const model of PROMPT_BRAIN_GEMINI_MODELS) {
    // Per-model timeout: an overloaded Google model (flash-lite 503-storms and
    // sometimes HANGS) must not eat the whole 6s budget and starve the working
    // fallback model. Cap each attempt so the next model still gets a turn.
    // (G live-ride 2026-07-06: flash-lite hung the full 6s -> flash never tried
    // -> pills fell to static fallback despite flash answering in <1s.)
    const perModel = new AbortController();
    const onOuterAbort = () => perModel.abort();
    if (signal.aborted) perModel.abort();
    else signal.addEventListener("abort", onOuterAbort, { once: true });
    const perModelTimer = setTimeout(() => perModel.abort(), 1800);
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          signal: perModel.signal,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [{ role: "user", parts: [{ text: user }] }],
            generationConfig: {
              responseMimeType: "application/json",
              // gemini-2.5-flash spends its output budget on hidden "thinking"
              // (thoughtsTokenCount ~54 of 60) -> finishReason MAX_TOKENS -> the
              // JSON truncates to prose like "Here is" -> parse fail -> static
              // fallback pills ("Get Estimate/Compare Pros") that don't track the
              // conversation (G live-ride 2026-07-06). Disable thinking so the
              // fallback model emits clean pill JSON; flash-lite never thought,
              // so this is a no-op for the primary. Budget raised for headroom.
              maxOutputTokens: 120,
              temperature: 0.4,
              thinkingConfig: { thinkingBudget: 0 },
            },
          }),
        },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
      }

      const text = await res.clone().text().catch(() => "");
      console.error(
        "[prompt-brain] gemini non-ok:",
        model,
        res.status,
        text.slice(0, 200),
      );
      const retryable =
        res.status === 404 ||
        res.status === 429 ||
        res.status >= 500 ||
        /UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand|no longer available/i.test(text);
      if (!retryable) return null;
    } catch (err) {
      // Per-model timeout / abort / network error: try the next model, unless
      // the OUTER 6s budget is spent (then there's no time for another attempt).
      console.error(
        "[prompt-brain] gemini attempt failed:",
        model,
        err instanceof Error ? err.message : err,
      );
      if (signal.aborted) return null;
    } finally {
      clearTimeout(perModelTimer);
      signal.removeEventListener("abort", onOuterAbort);
    }
  }
  return null;
}

function extractPromptBrainJson(raw: string): string | null {
  const trimmed = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return trimmed.slice(start, end + 1);
}

async function logPromptBrainAttempt(sessionId: string | null, entry: PromptBrainLog): Promise<void> {
  // Telemetry (aiASAP port, G Droid/iPad ride 2026-07-03 "not changing to what
  // I'm talking about" was unprovable — Supabase had no pill rows): log EVERY
  // attempt, not just successful provider outputs. role must be user/assistant
  // (table CHECK); source keeps brain rows out of real voice-turn queries.
  // Await it with a tiny timeout: serverless fire-and-forget can be dropped
  // before the POST leaves the process, which is exactly how fudged proof gaps
  // happen. Logging failure still never blocks the pill response.
  if (!sessionId) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const { url, serviceRoleKey } = getSupabaseAdminConfig();
    const res = await fetch(`${url}/rest/v1/conversation_messages`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify([
        {
          session_id: sessionId,
          role: "assistant",
          message: JSON.stringify(entry),
          source: "prompt_brain_v1",
          la_absolute_timestamp: Math.floor(Date.now() / 1000),
        },
      ]),
    });
    if (!res.ok) {
      console.error("[prompt-brain] supabase log failed:", res.status, await res.text());
    }
  } catch (err) {
    // Missing Supabase env / network timeout must never break the pill response.
    console.error(
      "[prompt-brain] supabase log threw:",
      err instanceof Error ? err.message : err,
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: NextRequest) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const limitErr = await checkRateLimit(request);
  if (limitErr) return limitErr;

  let body: {
    latestUserText?: unknown;
    recentUserTexts?: unknown;
    currentPrompts?: unknown;
    currentSubject?: unknown;
    listContext?: unknown;
    sessionId?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ prompts: null });
  }

  const sessionId =
    typeof body.sessionId === "string" &&
    isSafeTranscriptionSessionId(body.sessionId)
      ? body.sessionId
      : null;
  const latest = cleanPromptBrainText(body.latestUserText);
  const currentSubject = cleanPromptBrainText(body.currentSubject ?? "", 120);
  const listContext = normalizeListContext(body.listContext);
  if (listContext) {
    const prompts = sanitizePills(getListContextPrompts(listContext));
    await logPromptBrainAttempt(sessionId, {
      status: prompts ? "list_context_ok" : "pill_sanitize_fail",
      latestUserText: latest,
      currentSubject,
      derivedSubject: listContext.title,
      prompts,
    });
    return NextResponse.json({ prompts });
  }
  if (latest.length < 3) {
    await logPromptBrainAttempt(sessionId, {
      status: "short_input",
      latestUserText: latest,
      currentSubject,
      derivedSubject: "",
      prompts: null,
    });
    return NextResponse.json({ prompts: null });
  }

  // DEVICE/CONNECTION chatter ("now I'm on my computer", "no internet") is
  // context, not a repair subject — keep the pills we have instead of asking
  // any provider to invent "Fix Computer" (G 13:11 ride; Herm TASK_144 C).
  if (isPromptBrainContextOnlyText(latest)) {
    const current = Array.isArray(body.currentPrompts)
      ? body.currentPrompts
          .map((t) => cleanPromptBrainText(t, 18))
          .filter(Boolean)
          .slice(0, 4)
      : [];
    const prompts = sanitizePills(current);
    await logPromptBrainAttempt(sessionId, {
      status: "context_only",
      latestUserText: latest,
      currentSubject,
      derivedSubject: "",
      currentPrompts: current,
      prompts,
    });
    return NextResponse.json({ prompts });
  }

  const recent = Array.isArray(body.recentUserTexts)
    ? body.recentUserTexts.map((t) => cleanPromptBrainText(t)).filter(Boolean).slice(-6)
    : [];
  const current = Array.isArray(body.currentPrompts)
    ? body.currentPrompts
        .map((t) => cleanPromptBrainText(t, 18))
        .filter(Boolean)
        .slice(0, 4)
    : [];
  const promptInput = {
    latestUserText: latest,
    recentUserTexts: recent,
    currentPrompts: current,
    currentSubject,
  };
  const derivedSubject = derivePromptBrainSubject(promptInput);
  const fallbackPrompts = buildPromptBrainFallback(promptInput);
  const userMsg = buildPromptBrainUserMessage(promptInput);
  const providerTried: string[] = [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  try {
    let rawText: string | null = null;
    if (OPENAI_API_KEY) {
      providerTried.push("openai");
      rawText = await askOpenAi(userMsg, controller.signal);
    }
    if (!rawText && GEMINI_API_KEY) {
      providerTried.push("gemini");
      rawText = await askGemini(userMsg, controller.signal);
    }

    if (!rawText) {
      const status = providerTried.length ? "provider_empty" : "no_provider";
      await logPromptBrainAttempt(sessionId, {
        status: fallbackPrompts ? "fallback_ok" : status,
        latestUserText: latest,
        currentSubject,
        derivedSubject,
        currentPrompts: current,
        prompts: fallbackPrompts,
        providerTried,
        rawTextSample: null,
      });
      return NextResponse.json({ prompts: fallbackPrompts });
    }

    const jsonText = extractPromptBrainJson(rawText);
    if (!jsonText) {
      await logPromptBrainAttempt(sessionId, {
        status: fallbackPrompts ? "fallback_ok" : "json_parse_fail",
        latestUserText: latest,
        currentSubject,
        derivedSubject,
        currentPrompts: current,
        prompts: fallbackPrompts,
        providerTried,
        rawTextSample: rawText.slice(0, 180),
      });
      return NextResponse.json({ prompts: fallbackPrompts });
    }

    let parsed: { prompts?: unknown };
    try {
      parsed = JSON.parse(jsonText) as { prompts?: unknown };
    } catch {
      await logPromptBrainAttempt(sessionId, {
        status: fallbackPrompts ? "fallback_ok" : "json_parse_fail",
        latestUserText: latest,
        currentSubject,
        derivedSubject,
        currentPrompts: current,
        prompts: fallbackPrompts,
        providerTried,
        rawTextSample: rawText.slice(0, 180),
      });
      return NextResponse.json({ prompts: fallbackPrompts });
    }

    const prompts = sanitizePills(parsed.prompts);
    if (!prompts) {
      await logPromptBrainAttempt(sessionId, {
        status: fallbackPrompts ? "fallback_ok" : "pill_sanitize_fail",
        latestUserText: latest,
        currentSubject,
        derivedSubject,
        currentPrompts: current,
        prompts: fallbackPrompts,
        providerTried,
        rawTextSample: rawText.slice(0, 180),
      });
      return NextResponse.json({ prompts: fallbackPrompts });
    }

    await logPromptBrainAttempt(sessionId, {
      status: "provider_ok",
      latestUserText: latest,
      currentSubject,
      derivedSubject,
      currentPrompts: current,
      prompts,
      providerTried,
      rawTextSample: rawText.slice(0, 180),
    });
    return NextResponse.json({ prompts });
  } catch (err) {
    await logPromptBrainAttempt(sessionId, {
      status: fallbackPrompts ? "fallback_ok" : "exception",
      latestUserText: latest,
      currentSubject,
      derivedSubject,
      currentPrompts: current,
      prompts: fallbackPrompts,
      providerTried,
      error: err instanceof Error ? err.message.slice(0, 180) : String(err).slice(0, 180),
    });
    return NextResponse.json({ prompts: fallbackPrompts });
  } finally {
    clearTimeout(timer);
  }
}
