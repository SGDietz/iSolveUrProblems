import { OPENAI_API_KEY } from "../../../app/api/secrets";
import { getActiveTierForContractor } from "../billing/store";
import { tierUnlocks } from "../billing/tiers";

/**
 * M4.6 — Worker-in-the-loop CV classifier.
 *
 * Vision ¶27: "6 identifies which plants are weeds and which are
 * flowers ... over time, the Ai will learn and improve its accuracy."
 *
 * v1 architecture (Q4.6a option (a)):
 *   - Model: OpenAI `gpt-4o` with an image input from a signed
 *     Supabase Storage URL. No custom training pipeline in v1.
 *   - Response shape: { label, confidence, alternatives } — bucketed
 *     confidence keeps the schema simple and forces the model to
 *     commit rather than emit noisy floats.
 *   - Worker confirms/corrects downstream (persisted in cv_labels).
 *
 * v1 is data-collection-only. A future v2 will:
 *   - Fine-tune on the confirmed-label anchor set
 *   - Compute a visual diff between visits (¶27 second clause)
 *   - Migrate to Roboflow/HuggingFace hosting once accuracy warrants
 *
 * Tier gate: gold-only (billing/tiers.ts `cv_labeling`). Below gold,
 * classify() returns { ok: false, reason: 'tier_gate' } silently; the
 * "identify" UI should not render at all for those contractors.
 */

const VISION_MODEL = process.env.VISION_MODEL || "gpt-4o";

/**
 * Q4.6b — Quality gate. Ship criterion is 70% test-set accuracy on
 * weed-vs-flower. Per-item confidence buckets are a separate,
 * worker-facing signal — the model may say `high` even on a photo
 * that's ambiguous, and the worker's confirmation corrects it.
 */
export type CvConfidence = "low" | "medium" | "high";

export type CvPrediction = {
  label: string;
  confidence: CvConfidence;
  alternatives: string[];
  model: string;
};

export type ClassifyInput = {
  /** Contractor whose subscription tier decides whether this even runs. */
  contractor_id: string;
  /** Publicly-reachable HTTPS URL to the photo (Supabase signed URL is fine). */
  image_url: string;
  /**
   * Optional worker-supplied hint ("focus on the plant on the left",
   * "is this poison oak?"). Threaded into the user message so the
   * model biases toward the right subject.
   */
  prompt_hint?: string | null;
};

export type ClassifyResult =
  | { ok: true; prediction: CvPrediction }
  | {
      ok: false;
      reason:
        | "tier_gate"
        | "openai_not_configured"
        | "llm_http_error"
        | "llm_parse_failed"
        | "llm_fetch_threw"
        | "llm_refused";
      debug?: string;
    };

const SYSTEM_PROMPT = [
  `You are 6, an AI assistant helping a working landscaper / gardener document a job. Look at the photo and identify what's in it.`,
  ``,
  `Output STRICT JSON ONLY in the shape:`,
  `{`,
  `  "label": "<short noun phrase — e.g. 'weed', 'flower', 'dandelion', 'crabgrass', 'unknown'>",`,
  `  "confidence": "low" | "medium" | "high",`,
  `  "alternatives": ["<other plausible label>", "..."]`,
  `}`,
  ``,
  `Rules:`,
  ` - Focus on gardening / landscaping context — plant vs. weed, healthy vs. dying, before vs. after.`,
  ` - Prefer specific species names when confident ("dandelion", "clover", "rose"). Fall back to "weed" / "flower" when the species isn't clear.`,
  ` - "confidence" is your own honest read: high = certain, medium = probable, low = guessing.`,
  ` - Return at most 3 alternatives; empty array is fine.`,
  ` - If the photo isn't a plant or is unusable (blurry, occluded, wrong subject), return label="unknown" and confidence="low".`,
].join("\n");

function isConfidence(v: unknown): v is CvConfidence {
  return v === "low" || v === "medium" || v === "high";
}

function normalizeAlternatives(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw === "string") {
      const cleaned = raw.trim();
      if (cleaned.length > 0 && cleaned.length <= 60) {
        out.push(cleaned);
        if (out.length >= 3) break;
      }
    }
  }
  return out;
}

export async function classifyJobLogPhoto(
  args: ClassifyInput,
): Promise<ClassifyResult> {
  if (!OPENAI_API_KEY) {
    return { ok: false, reason: "openai_not_configured" };
  }

  const tier = await getActiveTierForContractor(args.contractor_id);
  if (!tierUnlocks(tier, "cv_labeling")) {
    return { ok: false, reason: "tier_gate" };
  }

  const userText = args.prompt_hint?.trim()
    ? `Worker hint: ${args.prompt_hint.trim()}\n\nReturn the JSON.`
    : `Return the JSON.`;

  let raw: string;
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: VISION_MODEL,
        response_format: { type: "json_object" },
        temperature: 0.1,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              { type: "text", text: userText },
              { type: "image_url", image_url: { url: args.image_url } },
            ],
          },
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
    // gpt-4o may return a structured refusal or a finish_reason of
    // 'content_filter' when the safety layer intervenes. Surface that
    // as its own reason so the caller can distinguish "the model
    // failed" from "the model refused" (e.g. don't retry refusals).
    const choice = data?.choices?.[0];
    const refusal = choice?.message?.refusal;
    const finishReason = choice?.finish_reason;
    if (typeof refusal === "string" && refusal.trim().length > 0) {
      return {
        ok: false,
        reason: "llm_refused",
        debug: refusal.slice(0, 300),
      };
    }
    if (finishReason === "content_filter") {
      return {
        ok: false,
        reason: "llm_refused",
        debug: `finish_reason=content_filter`,
      };
    }
    raw = choice?.message?.content ?? "";
  } catch (e) {
    return {
      ok: false,
      reason: "llm_fetch_threw",
      debug: e instanceof Error ? e.message : "unknown",
    };
  }

  let parsed: { label?: unknown; confidence?: unknown; alternatives?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      reason: "llm_parse_failed",
      debug: `couldn't JSON.parse: ${raw.slice(0, 200)}`,
    };
  }

  const label =
    typeof parsed.label === "string" ? parsed.label.trim().slice(0, 60) : "";
  if (!label) {
    return {
      ok: false,
      reason: "llm_parse_failed",
      debug: `missing label in response: ${raw.slice(0, 200)}`,
    };
  }
  const confidence: CvConfidence = isConfidence(parsed.confidence)
    ? parsed.confidence
    : "low";

  return {
    ok: true,
    prediction: {
      label,
      confidence,
      alternatives: normalizeAlternatives(parsed.alternatives),
      model: VISION_MODEL,
    },
  };
}
