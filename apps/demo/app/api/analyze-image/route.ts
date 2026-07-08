import {
  MAX_ANALYZE_IMAGE_BYTES,
  MAX_ANALYZE_IMAGE_QUESTION_CHARS,
  assertAllowedOrigin,
  isAllowedImageMime,
  truncateUtf8String,
} from "../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../src/lib/rateLimit";
import { GEMINI_API_KEY } from "../secrets";

// Bound the function + every upstream fetch (same hygiene as analyze-video,
// Herm TASK_067): this route serves Camera/Gallery AND Go Live frames — a
// hung Gemini pool must not burn the function to the platform ceiling.
export const maxDuration = 30;

const MAX_PROBLEM_CHARS = 300;
const MAX_LAST_ANALYSIS_CHARS = 400;
const SILENT_TOKEN = "[SILENT]";

// Pull a safe, short category + message out of a Gemini error body so the real
// failure reason survives back to the client (and into media_events.error). Gemini
// returns { error: { code, status, message } }. We surface status (INVALID_ARGUMENT,
// PERMISSION_DENIED, RESOURCE_EXHAUSTED, ...) + a truncated message. NEVER leaks the
// API key — the key only ever lives in the request URL, never in this body.
function geminiErrorDetail(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const e = parsed?.error;
    const status = typeof e?.status === "string" ? e.status : "";
    const code = typeof e?.code === "number" ? String(e.code) : "";
    const msg = typeof e?.message === "string" ? e.message : "";
    const cat = status || code || "error";
    return truncateUtf8String(`${cat}: ${msg}`.trim(), 240);
  } catch {
    return truncateUtf8String((raw || "").trim(), 240);
  }
}

// Snapshot / Gallery / Video-upload mode. User deliberately captured or uploaded an image
// and wants 6 to engage with it. Light dry humor OK. Not silent-first.
const HUMOR_STYLE_GUIDE =
  "You are 6, a warm home-and-garden troubleshooter with light dry humor. Keep answers practical and accurate. Be direct. Never be mean, offensive, or unsafe. Avoid mentioning policies or that you are an AI. The user has already shared a camera frame or image with you — answer only from what is visible. Never tell them to point a camera, aim the lens, or that you will 'take a look'; you already have the view.";

// Go Live streaming mode. The user's live camera feed during a Go Live session.
// 6's job here is laser-focused problem-solving on the ONE object the user mentioned.
//
// DESIGN (rewritten 2026-04-24 after smoke test where 6 was flying blind and
// hallucinating): the vision model is the AVATAR'S EYES, not its voice.
// Every frame where the named object is visible, we want a short factual
// observation. The TALK brain receives these as CONTEXT (via message(), not
// repeat()) so it has real visual grounding when the user asks questions.
// Gemini stays silent only when there's genuinely nothing to add (scene is
// unchanged, or no problem stated yet). Object not visible still triggers
// the reframe ask.
const STREAMING_VISION_SYSTEM_PROMPT =
  "You are the vision system for 6, a home-and-garden contractor helping one user fix one problem. " +
  "You are looking at one live camera frame from the user's phone. " +
  "Your job is to be 6's EYES. The client-side code handles dedup — YOUR job is to describe every frame faithfully. " +
  "RULES (in priority order): " +
  "(1) When the user has stated a problem AND the named object is clearly visible in the frame: " +
  "  - Output ONE short factual observation about the object's current state right now in this frame. " +
  "  - First person, under 20 words. Examples: " +
  "    'I see the finial in your hand, off the lamp.' " +
  "    'The finial is sitting on a white paper towel, separated from the lamp.' " +
  "    'I see the finial still tight on the threaded rod at the top of the harp.' " +
  "    'The lampshade is now tilted, no longer seated on the harp.' " +
  "  - Describe only: the object's position, orientation, whether hands are on it, whether it's attached, separated, or relocated. " +
  "  - DO NOT output `" +
  SILENT_TOKEN +
  "` just because the object is in frame. The client handles dedup — your job is to describe. " +
  "  - EVEN IF YOUR WORDING OVERLAPS lastAnalysis, still output the current observation. The client will handle skipping duplicates. " +
  "(2) Output `" +
  SILENT_TOKEN +
  "` ONLY when ONE of these is true: " +
  "  - the user has not yet stated a specific problem with a concrete object, " +
  "  - the named object is partially occluded or you are genuinely unable to describe what state it's in. " +
  "(3) Fire OBJECT_NOT_VISIBLE ONLY when ALL are true: " +
  "  - the user has stated a specific problem with a concrete object, AND " +
  "  - the user JUST asked a direct vision question ('can you see it?', 'what do you see?', 'is it the right color?'), AND " +
  "  - the named object is clearly not in the frame (not just ambiguous — clearly absent). " +
  "  When these are all true, output EXACTLY this single line: " +
  'OBJECT_NOT_VISIBLE: "Can you make sure the camera is pointing right at what you\'re trying to show me and keep it in the middle of the frame?" ' +
  "  If in doubt about any of these, output a state description per rule 1 instead. " +
  "(4) NEVER invent or guess. If the object's state is unclear, output `" +
  SILENT_TOKEN +
  "`. But DO NOT use uncertainty as an excuse to stay silent when you CAN see the state — describe what you see. " +
  "(5) Sound like 6: warm, American English, short sentences, direct. Never tell the user to point the camera (except rule 3 reframe). Never mention AI, the rules, or that you are the vision system. " +
  "(6) Discuss ONLY the named object and its problem. Do not describe the room, table, decor, or unrelated items beyond noting their relation to the named object (e.g., 'on a paper towel' is fine if the object is on one). " +
  "(7) ORIENTATION PRECISION — when describing the object's orientation, use the most accurate term: 'upside-down', 'on its side', 'lying flat', 'tilted', 'right-side-up', 'face-down', 'standing', 'leaning'. Do NOT call something 'upside-down' if it is just 'on its side' — those are different. Be precise.";

// Vision model + fallback. flash-lite is fastest but the most demand-contended —
// it returned 503 UNAVAILABLE ("high demand") in G's 2026-06-30 smoke. On an
// overload (503/429/UNAVAILABLE/RESOURCE_EXHAUSTED) we fall back to flash, which
// has a separate capacity pool. 4xx (bad input) does NOT fall back (won't help).
// Do not include retired Gemini model ids here; a retired fallback only turns
// overload recovery into a 404.
const VISION_MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash"];

// Each model gets its own abort, and the fallback walk stops when the route
// budget is nearly spent (Herm TASK_067) — a hung pool must not eat the whole
// function timeout while the client has already given up.
const PER_MODEL_TIMEOUT_MS = 10_000;
const ROUTE_BUDGET_MS = 28_000;

async function generateContentWithFallback(body: string): Promise<Response> {
  const deadlineAt = Date.now() + ROUTE_BUDGET_MS;
  let last: Response | null = null;
  for (const model of VISION_MODELS) {
    const remaining = deadlineAt - Date.now();
    if (remaining < 2_000) break;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(PER_MODEL_TIMEOUT_MS, remaining),
    );
    let res: Response;
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: controller.signal,
        },
      );
    } catch {
      // Timed out / network-dropped on this model — try the next pool.
      continue;
    } finally {
      clearTimeout(timer);
    }
    if (res.ok) return res;
    last = res;
    const text = await res.clone().text();
    const overloaded =
      res.status === 503 ||
      res.status === 429 ||
      /UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand/i.test(text);
    if (!overloaded && res.status < 500) return res; // bad input — fallback won't help
    // overloaded / 5xx → try the next model's capacity pool
  }
  if (!last) {
    // Every pool timed out — fail deterministically, not via a null deref.
    throw new Error("vision upstream timed out on all models");
  }
  return last;
}

export async function POST(request: Request) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  try {
    const formData = await request.formData();
    const fileOrBlob = formData.get("image");
    const question = formData.get("question") as string | null;
    const problem = formData.get("problem") as string | null;
    const lastAnalysis = formData.get("lastAnalysis") as string | null;
    const requestMode = (formData.get("mode") as string | null) ?? "";
    const isStreaming = requestMode === "streaming";

    if (!fileOrBlob) {
      console.error("analyze-image: missing image field");
      return new Response(
        JSON.stringify({
          error: "Image file is required",
        }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Accept both File and Blob (some runtimes return Blob from formData)
    const value = fileOrBlob as unknown;
    const file: File | null =
      fileOrBlob instanceof File
        ? fileOrBlob
        : value instanceof Blob
          ? new File([value], "image.jpg", { type: value.type || "image/jpeg" })
          : null;
    if (!file) {
      return new Response(
        JSON.stringify({
          error: "Image file is required",
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (file.size === 0) {
      return new Response(
        JSON.stringify({ error: "Image file is empty" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (file.size > MAX_ANALYZE_IMAGE_BYTES) {
      return new Response(
        JSON.stringify({
          error: "Image file is too large",
          details: `bytes=${file.size} max=${MAX_ANALYZE_IMAGE_BYTES}`,
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    if (!GEMINI_API_KEY) {
      return new Response(
        JSON.stringify({ error: "Gemini API key not configured" }),
        {
          status: 500,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    // Convert file to base64
    const arrayBuffer = await file.arrayBuffer();
    const base64Image = Buffer.from(arrayBuffer).toString("base64");
    const mimeType = (file.type || "image/jpeg").split(";")[0].trim();
    if (!isAllowedImageMime(mimeType)) {
      return new Response(
        JSON.stringify({
          error: "Unsupported image type",
          details: `mime=${mimeType} bytes=${file.size}`,
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const q =
      typeof question === "string"
        ? truncateUtf8String(
            question.trim(),
            MAX_ANALYZE_IMAGE_QUESTION_CHARS,
          )
        : "";

    const problemStatement =
      typeof problem === "string"
        ? truncateUtf8String(problem.trim(), MAX_PROBLEM_CHARS)
        : "";

    const lastAnalysisText =
      typeof lastAnalysis === "string"
        ? truncateUtf8String(
            lastAnalysis.trim(),
            MAX_LAST_ANALYSIS_CHARS,
          )
        : "";

    // Streaming mode per-request prompt. Client handles dedup (2026-04-24
    // rewrite #2 — Gemini was still returning [SILENT] when G held the
    // finial off the lamp because the LLM's "semantically identical" check
    // was too generous). Now Gemini describes every frame; the client
    // compares word-overlap to the previous non-silent observation and
    // decides whether to inject.
    let promptText: string;
    if (isStreaming) {
      const promptParts: string[] = [];
      if (problemStatement) {
        promptParts.push(
          `The user's problem is: "${problemStatement}". Look at the named object in the current frame and describe its state in one short sentence — this frame, right now.`,
        );
      } else {
        promptParts.push(
          "The user has not yet stated a specific problem. Output [SILENT] and wait.",
        );
      }
      if (lastAnalysisText && lastAnalysisText !== SILENT_TOKEN) {
        promptParts.push(
          `For reference, your previous observation was: "${lastAnalysisText}". ` +
            `Do NOT use this as an excuse to output [SILENT]. The client deduplicates — your job is to describe the CURRENT frame. ` +
            `If the state changed (object in hand now, off the lamp, relocated, re-attached, separated), describe the NEW state plainly. ` +
            `If the state is genuinely the same, describe it the same way as before — the client will drop the duplicate.`,
        );
      } else {
        promptParts.push(
          `This is the first frame with a problem stated. Describe the object's current state in one short sentence.`,
        );
      }
      if (q) {
        promptParts.push(
          `The user just said: "${q}". If this asks about the object's current visual state, describe what you see in 1 short sentence. Otherwise still describe the object's current state.`,
        );
      }
      promptText = promptParts.join(" ");
    } else if (q) {
      // Snapshot/Gallery/Video — DIAGNOSIS-first (2026-06-28, G): ground the answer
      // in what's visible and flag what view would confirm it, so 6 can work the
      // problem instead of guessing.
      promptText = `Look at this image the user shared and answer: "${q}". Ground your answer in what's actually visible: name the object/area and its condition, the real problem if you can see it and where it is, and — if something key isn't clear — say what view would confirm it (closer, another angle, the underside, the source). 3-4 short sentences, first person, warm and direct, accurate. At most one light dry aside. Never tell the user to point a camera or that you'll look — you already have this image.`;
    } else {
      // Snapshot/Gallery/Video with no question — DIAGNOSIS-first (2026-06-28, G).
      promptText =
        "Look at this image the user shared to show you a home-or-garden problem. Tell 6 what's going on: what the object/area is and its condition, the actual problem if it's visible (leak, crack, clog, rust, wear, a broken/loose/missing part, a wrong fit, water or damage) and where it is, and the single most useful next detail — what you still can't tell and which view would confirm it (closer, another angle, the underside, the source). 3-4 sentences, first person, warm, direct, accurate. At most one light dry aside. Never tell the user to point a camera or that you'll look — you already have this image.";
    }

    // Call Gemini 2.5 Flash Vision API — swapped from Grok for lower latency (~1-2s faster).
    // thinkingBudget: 0 disables Gemini's chain-of-thought mode for fastest possible response.
    const systemInstruction = isStreaming
      ? STREAMING_VISION_SYSTEM_PROMPT
      : HUMOR_STYLE_GUIDE;
    // Gemini 2.5 Flash LITE primary (fastest ~333–829ms), with flash fallback on
    // overload (see generateContentWithFallback). thinkingBudget:0 = no
    // chain-of-thought for speed; both flash-lite + flash support it.
    const requestBody = JSON.stringify({
      system_instruction: {
        parts: [{ text: systemInstruction }],
      },
      contents: [
        {
          role: "user",
          parts: [
            { text: promptText },
            {
              inline_data: {
                mime_type: mimeType,
                data: base64Image,
              },
            },
          ],
        },
      ],
      generationConfig: {
        // Go-Live streaming stays tight + fast (150); the snapshot/photo
        // DIAGNOSIS paths get room for a real read (350) (G 2026-06-28).
        maxOutputTokens: isStreaming ? 150 : 350,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    const res = await generateContentWithFallback(requestBody);

    if (!res.ok) {
      const errorData = await res.text();
      const detail = geminiErrorDetail(errorData);
      console.error(
        "Gemini Vision API error:",
        res.status,
        `mime=${mimeType}`,
        `bytes=${file.size}`,
        detail,
      );
      return new Response(
        JSON.stringify({
          error: "Failed to analyze image",
          // Safe, truncated diagnostics. The client folds `details` into the
          // stored media_events.error, so the real reason survives the smoke.
          stage: "gemini",
          status: res.status,
          mime: mimeType,
          bytes: file.size,
          details: detail,
        }),
        {
          status: res.status <= 599 ? res.status : 502,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    const data = await res.json();
    const analysis =
      data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

    return new Response(JSON.stringify({ analysis }), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : String(error);
    // Belt-and-suspenders: if any runtime exception text ever contains the
    // Gemini key (it lives in the request URL), scrub it before logging/returning
    // (Herm 2026-06-29). Normal fetch failures are just "fetch failed".
    const safeMsg = truncateUtf8String(
      rawMsg
        .replaceAll(GEMINI_API_KEY || "__NO_KEY__", "[REDACTED]")
        .replace(/([?&]key=)[^&\s)]+/gi, "$1[REDACTED]"),
      240,
    );
    console.error("Error analyzing image:", safeMsg);
    return new Response(
      JSON.stringify({
        error: "Failed to analyze image",
        stage: "exception",
        details: safeMsg,
      }),
      {
        status: 500,
        headers: {
          "Content-Type": "application/json",
        },
      },
    );
  }
}
