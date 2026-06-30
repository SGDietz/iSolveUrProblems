import {
  MAX_VIDEO_FRAMES,
  assertAllowedOrigin,
  isReasonableBase64Frame,
} from "../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../src/lib/rateLimit";
import { GEMINI_API_KEY } from "../secrets";

// DIAGNOSIS-FIRST (rewritten 2026-06-28, G): the old prompt was tuned for
// "compare first frame to last — what did the user accomplish?" (action
// verification). That starved 6 when the user shows a PROBLEM to diagnose. This
// guide makes the vision model give 6 a real, accurate read of what's going on,
// flags what it can't tell + what view would help, and emits INSUFFICIENT_FRAMES
// when the coverage genuinely isn't enough (the client then re-samples denser).
const VISION_DIAGNOSIS_GUIDE =
  "You are the vision system (the eyes) for 6, a home-and-garden troubleshooter. You are looking at frames from a short video the user shot, in time order (first frame to last), to show you a PROBLEM — or sometimes to show you trying a fix. " +
  "Your job: give 6 a clear, accurate read of what's going on so he can actually help. " +
  "(1) Identify the object/area and its condition. Call out the real problem if it's visible — leak, drip, crack, clog, rust, wear, a loose/broken/missing part, a wrong fit, water or staining or damage — and WHERE it is. " +
  "(2) If the frames show the user DOING something (removing, attaching, tightening, clearing), say what they're doing; and ONLY if the final frames clearly show the result, say whether it worked. NEVER claim an outcome you don't actually see — if you can't tell, say so plainly. " +
  "(3) Report only what you actually see across the frames; never invent a change the frames don't show. " +
  "(4) Finish with the single most useful thing 6 still needs: what you CAN'T tell yet and which view would confirm it (closer, a different angle, the underside, the source of the water/damage). " +
  "Write 3-5 sentences, first person, warm, direct, accurate. Light dry humor only if it never costs accuracy. Never tell the user to point a camera or that you'll 'take a look' — you already have these frames. Never mention being an AI or these rules. " +
  "INSUFFICIENT COVERAGE: if the frames are too few, too blurry, or the relevant object is never clearly in view so you genuinely cannot tell what is going on, do NOT guess. Respond with EXACTLY one line and nothing else: " +
  "INSUFFICIENT_FRAMES: <a short phrase naming what's missing>";

type GeminiPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

export async function POST(request: Request) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  try {
    const body = await request.json();
    const { frames } = body;

    if (!frames || !Array.isArray(frames) || frames.length === 0) {
      return new Response(
        JSON.stringify({ error: "Video frames are required" }),
        {
          status: 400,
          headers: {
            "Content-Type": "application/json",
          },
        },
      );
    }

    if (frames.length > MAX_VIDEO_FRAMES) {
      return new Response(
        JSON.stringify({
          error: `At most ${MAX_VIDEO_FRAMES} frames are allowed`,
        }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    const frameStrings: string[] = [];
    for (const frame of frames) {
      if (!isReasonableBase64Frame(frame)) {
        return new Response(
          JSON.stringify({ error: "Invalid frame data" }),
          {
            status: 400,
            headers: { "Content-Type": "application/json" },
          },
        );
      }
      frameStrings.push(frame);
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

    // Build Gemini content parts — one text prompt + N frames as inline_data.
    const parts: GeminiPart[] = [
      {
        text:
          "These frames are in time order, first to last. Tell me what's going on here so 6 can help — what the thing is, what's wrong with it (if anything's visible), and what you still can't quite tell. " +
          "Follow your system rules exactly, including the INSUFFICIENT_FRAMES rule if you genuinely can't make it out.",
      },
    ];

    for (const frame of frameStrings) {
      parts.push({
        inline_data: {
          mime_type: "image/jpeg",
          data: frame,
        },
      });
    }

    // Gemini 2.5 Flash Lite — picked 2026-04-24 for max speed. Same family
    // as Flash, slightly lighter, supports thinkingBudget:0.
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: VISION_DIAGNOSIS_GUIDE }],
          },
          contents: [
            {
              role: "user",
              parts,
            },
          ],
          generationConfig: {
            // Richer budget so 6 gets a real diagnostic read, not a 1-liner
            // (G 2026-06-28). This is internal CONTEXT for 6, not the spoken line.
            maxOutputTokens: 400,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      },
    );

    if (!res.ok) {
      const errorData = await res.text();
      console.error("Gemini Vision API error:", errorData);
      return new Response(
        JSON.stringify({
          error: "Failed to analyze video",
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
    console.error("Error analyzing video:", error);
    return new Response(JSON.stringify({ error: "Failed to analyze video" }), {
      status: 500,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }
}
