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
  sanitizePills,
} from "../../../src/lib/promptBrain";
import { GEMINI_API_KEY, OPENAI_API_KEY } from "../secrets";

export const dynamic = "force-dynamic";
export const maxDuration = 15;

/**
 * POST /api/prompt-brain — iSolve port of aiASAP's pill brain (G smoke #7
 * 2026-07-03: "the pillboxes don't change anything… it's been saying stuck
 * window the entire time… Everything is in aiASAP"). Takes what the user
 * just said and returns THREE short pill labels matched to the CURRENT
 * subject. Fail-soft by contract: provider/parse trouble falls back to a
 * deterministic local subject pill set when possible, else { prompts: null }
 * and the client keeps the pills it has (aiASAP's "old goes out, new comes
 * in" — never a flash, never an error surface).
 *
 * Provider: OpenAI (gpt-4o-mini, house model) when the key exists, else
 * Gemini flash (the key present in every Vercel env). 6s abort either way.
 */

const SYSTEM_PROMPT = [
  "You suggest tap-pill labels for a home-repair voice assistant called 6.",
  "Return STRICT JSON: {\"prompts\":[\"...\",\"...\",\"...\"]} — exactly 3 labels.",
  "Each label: 1-3 plain everyday words, max 18 characters, Title Case, no punctuation, no emojis.",
  "The labels must match what the user is talking about RIGHT NOW — the current subject/problem, trade, or next helpful step (e.g. 'Fix The Drip', 'Find A Painter', 'Show Me How').",
  "Never invent names, contacts, reminders, or app features. Never mention email or sign-in.",
].join(" ");

type PromptBrainLog = {
  status:
    | "provider_ok"
    | "fallback_ok"
    | "short_input"
    | "no_provider"
    | "provider_empty"
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
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
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
}

async function askGemini(user: string, signal: AbortSignal): Promise<string | null> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: "POST",
      signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: {
          responseMimeType: "application/json",
          maxOutputTokens: 60,
          temperature: 0.4,
        },
      }),
    },
  );
  if (!res.ok) {
    // G ride 2026-07-04: EVERY pill row was fallback_ok with providerTried
    // ['gemini'] — the LLM path never once succeeded on preview. Log the
    // actual status/body so the NEXT ride reveals WHY (403 model access,
    // 429 quota, 400 bad request). analyze-image already logs this; the
    // pill brain silently swallowed it.
    console.error(
      "[prompt-brain] gemini non-ok:",
      res.status,
      (await res.clone().text().catch(() => "")).slice(0, 200),
    );
    return null;
  }
  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
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
  const timer = setTimeout(() => controller.abort(), 6000);
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

    let parsed: { prompts?: unknown };
    try {
      parsed = JSON.parse(rawText) as { prompts?: unknown };
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
