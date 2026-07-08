import { NextResponse, type NextRequest } from "next/server";
import { GEMINI_API_KEY, OPENAI_API_KEY } from "../../secrets";
import { assertAllowedOrigin } from "../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../src/lib/rateLimit";

/**
 * /api/analyze/go-live — Real-time frame analysis for Go Live mode.
 *
 * Per Q1.3a: Gemini 2.5 Flash Lite by default; client can request escalation
 * to GPT-4o by passing { model: "gpt4o" } (e.g. user says "take a
 * closer look, 6").
 *
 * Input (JSON):
 *   {
 *     frame_base64: string,        // raw base64 (no data: prefix)
 *     mime_type?: string,          // default "image/jpeg"
 *     session_id?: string,
 *     scene_change?: "same"|"small"|"large",   // client's perceptual-hash decision
 *     last_caption?: string,       // for stability — don't re-say the same thing
 *     model?: "flash"|"gpt4o",     // default "flash"
 *   }
 *
 * Output:
 *   {
 *     caption: string,             // short description of the frame
 *     should_narrate: boolean,     // server's recommendation to speak it
 *     narrate_reason?: string,
 *     model_used: "flash"|"gpt4o",
 *   }
 *
 * Server-side narration gate (multiple signals combined):
 *   - Scene change must be "large" or this is the first frame.
 *   - Caption must differ meaningfully from last_caption.
 *   - Caller (client hook) layers additional gates: avatar not speaking,
 *     user not speaking, debounce since last narration.
 */

// Bound the function + both upstream caption calls (same hygiene as
// analyze-video/analyze-image, Herm TASK_067): Go Live fires per-frame, so a
// hung vision fetch would otherwise pile functions up to the platform ceiling.
export const maxDuration = 15;
const CAPTION_TIMEOUT_MS = 10_000;

const FLASH_MODEL = "gemini-2.5-flash-lite";

const CAPTION_PROMPT = `You are 6, an ai handyman analyzing what the user's camera is currently pointed at.

Reply with ONE short sentence (10–20 words) describing what's in view from a problem-solving angle. Be specific — name objects, materials, conditions, defects. Don't repeat yourself if the previous caption already covered it.

If nothing interesting changed, reply with the single word: NOTHING.

Do NOT greet the user, ask questions, or use filler phrases like "I see" — just the observation.`;

function jsonError(status: number, error: string): NextResponse {
  return NextResponse.json({ error }, { status });
}

async function callGeminiFlash(args: {
  frameB64: string;
  mime: string;
  lastCaption?: string;
}): Promise<{ caption: string } | { error: string }> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${FLASH_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          { text: CAPTION_PROMPT },
          ...(args.lastCaption
            ? [{ text: `Previous caption: "${args.lastCaption}"` }]
            : []),
          {
            inline_data: {
              mime_type: args.mime,
              data: args.frameB64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 80,
    },
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTION_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      return { error: `gemini ${res.status}` };
    }
    const data = (await res.json()) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
      }>;
    };
    const text =
      data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    return { caption: text };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "gemini threw" };
  } finally {
    clearTimeout(timer);
  }
}

async function callGpt4o(args: {
  frameB64: string;
  mime: string;
  lastCaption?: string;
}): Promise<{ caption: string } | { error: string }> {
  if (!OPENAI_API_KEY) return { error: "OPENAI_API_KEY not configured" };
  const body = {
    model: "gpt-4o",
    temperature: 0.2,
    max_tokens: 80,
    messages: [
      { role: "system", content: CAPTION_PROMPT },
      ...(args.lastCaption
        ? [{ role: "system", content: `Previous caption: "${args.lastCaption}"` }]
        : []),
      {
        role: "user",
        content: [
          { type: "text", text: "Describe this frame." },
          {
            type: "image_url",
            image_url: {
              url: `data:${args.mime};base64,${args.frameB64}`,
            },
          },
        ],
      },
    ],
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CAPTION_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return { error: `openai ${res.status}` };
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    return { caption: text };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "openai threw" };
  } finally {
    clearTimeout(timer);
  }
}

function looksLikeNothing(caption: string): boolean {
  const c = caption.trim().toUpperCase();
  return c === "" || c === "NOTHING" || c === "NOTHING.";
}

function captionsDifferEnough(a: string, b: string): boolean {
  const norm = (s: string) =>
    s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ");
  return norm(a) !== norm(b);
}

export async function POST(request: NextRequest) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateErr = await checkRateLimit(request);
  if (rateErr) return rateErr;

  let body: {
    frame_base64?: unknown;
    mime_type?: unknown;
    session_id?: unknown;
    scene_change?: unknown;
    last_caption?: unknown;
    model?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonError(400, "invalid json");
  }

  if (typeof body.frame_base64 !== "string" || !body.frame_base64) {
    return jsonError(400, "frame_base64 required");
  }
  const mime =
    typeof body.mime_type === "string" && body.mime_type
      ? body.mime_type
      : "image/jpeg";
  const lastCaption =
    typeof body.last_caption === "string" ? body.last_caption : undefined;
  const sceneChange =
    body.scene_change === "same" ||
    body.scene_change === "small" ||
    body.scene_change === "large"
      ? body.scene_change
      : "large";
  const wantsGpt4o = body.model === "gpt4o";

  // Server-side dedup: if the client says "same" scene, return a no-op
  // without burning a vision call.
  if (sceneChange === "same") {
    return NextResponse.json({
      caption: lastCaption ?? "",
      should_narrate: false,
      narrate_reason: "scene unchanged (client hash)",
      model_used: wantsGpt4o ? "gpt4o" : "flash",
    });
  }

  if (!wantsGpt4o && !GEMINI_API_KEY) {
    return jsonError(500, "GEMINI_API_KEY not configured");
  }

  const result = wantsGpt4o
    ? await callGpt4o({ frameB64: body.frame_base64, mime, lastCaption })
    : await callGeminiFlash({
        frameB64: body.frame_base64,
        mime,
        lastCaption,
      });

  if ("error" in result) {
    return NextResponse.json(
      {
        caption: "",
        should_narrate: false,
        narrate_reason: result.error,
        model_used: wantsGpt4o ? "gpt4o" : "flash",
      },
      { status: 502 },
    );
  }

  const caption = result.caption;

  // Narrate gate:
  //   - Skip if model said "NOTHING"
  //   - Skip if scene change was only "small" (let it accumulate)
  //   - Skip if caption is effectively identical to last_caption
  if (looksLikeNothing(caption)) {
    return NextResponse.json({
      caption: "",
      should_narrate: false,
      narrate_reason: "model said NOTHING",
      model_used: wantsGpt4o ? "gpt4o" : "flash",
    });
  }
  if (sceneChange === "small") {
    return NextResponse.json({
      caption,
      should_narrate: false,
      narrate_reason: "small scene change",
      model_used: wantsGpt4o ? "gpt4o" : "flash",
    });
  }
  if (lastCaption && !captionsDifferEnough(caption, lastCaption)) {
    return NextResponse.json({
      caption,
      should_narrate: false,
      narrate_reason: "caption duplicates last_caption",
      model_used: wantsGpt4o ? "gpt4o" : "flash",
    });
  }

  return NextResponse.json({
    caption,
    should_narrate: true,
    model_used: wantsGpt4o ? "gpt4o" : "flash",
  });
}
