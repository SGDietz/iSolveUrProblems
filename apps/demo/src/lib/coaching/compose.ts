import { OPENAI_API_KEY } from "../../../app/api/secrets";
import type { CoachingEvent } from "./catalog";
import type { CoachingEvaluation } from "./types";

/**
 * M4.8 — LLM tone-controlled nudge composer.
 *
 * Vision ¶28: "6 will always be positive and encouraging, helping people
 * be better business owners and employees."
 *
 * Hard constraints baked into the system prompt:
 *  - never canned. Always reference the SPECIFIC trigger fact.
 *  - never patronizing. Praise like a peer who happens to be running
 *    the platform.
 *  - 1 paragraph body, ≤ 90 words. Subject line ≤ 70 chars.
 *
 * Output format: strict JSON `{ "subject": string, "body": string }`.
 */

const COMPOSER_MODEL = process.env.COACHING_COMPOSER_MODEL || "gpt-4o-mini";

export type ComposeResult =
  | { ok: true; subject: string; body: string }
  | {
      ok: false;
      reason:
        | "openai_not_configured"
        | "llm_http_error"
        | "llm_parse_failed"
        | "llm_fetch_threw"
        | "empty_output";
      debug?: string;
    };

const SYSTEM_PROMPT = [
  `You are 6, the AI co-pilot for a contractor's small business. Today you are writing a SHORT, GENUINE coaching email to a contractor.`,
  ``,
  `Tone discipline:`,
  ` - Peer to peer. Never gushing. Never corporate.`,
  ` - Reference the SPECIFIC fact below. Generic praise is forbidden.`,
  ` - One short paragraph. No bullet points. No emoji. No sign-off.`,
  ` - Body length: 50–90 words. Subject ≤ 70 characters.`,
  ` - Don't promise platform features. Don't pitch anything.`,
  ``,
  `Output STRICT JSON only:`,
  `{ "subject": "<string>", "body": "<string>" }`,
].join("\n");

function buildUserPrompt(args: {
  contractorName: string;
  event: CoachingEvent;
  evaluation: CoachingEvaluation;
}): string {
  return [
    `Contractor name: ${args.contractorName}`,
    `Trigger event: ${args.event.key}`,
    `Tone hint: ${args.event.toneHint}`,
    `Topic shorthand: ${args.evaluation.topic}`,
    `Trigger facts (JSON):`,
    JSON.stringify(args.evaluation.facts, null, 2),
    ``,
    `Write the email body addressed to "${args.contractorName.split(/\s+/)[0] || "there"}".`,
  ].join("\n");
}

export async function composeCoachingNudge(args: {
  contractorName: string;
  event: CoachingEvent;
  evaluation: CoachingEvaluation;
}): Promise<ComposeResult> {
  if (!OPENAI_API_KEY) return { ok: false, reason: "openai_not_configured" };

  let raw: string;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: COMPOSER_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.6,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: buildUserPrompt(args) },
        ],
      }),
    });
    if (!res.ok) {
      return {
        ok: false,
        reason: "llm_http_error",
        debug: `openai ${res.status}: ${(await res.text()).slice(0, 300)}`,
      };
    }
    const data = await res.json();
    raw = data?.choices?.[0]?.message?.content ?? "";
  } catch (e) {
    return {
      ok: false,
      reason: "llm_fetch_threw",
      debug: e instanceof Error ? e.message : "unknown",
    };
  }

  let parsed: { subject?: unknown; body?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: "llm_parse_failed",
      debug: `couldn't JSON.parse: ${raw.slice(0, 200)}`,
    };
  }
  const subject =
    typeof parsed.subject === "string" ? parsed.subject.trim().slice(0, 200) : "";
  const body =
    typeof parsed.body === "string" ? parsed.body.trim().slice(0, 1200) : "";
  if (subject === "" || body === "") {
    return { ok: false, reason: "empty_output" };
  }
  return { ok: true, subject, body };
}
