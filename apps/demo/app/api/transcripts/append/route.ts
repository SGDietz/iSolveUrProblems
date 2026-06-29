import { NextResponse, type NextRequest } from "next/server";
import { assertAllowedOrigin } from "../../../../src/lib/apiRouteSecurity";
import { checkRateLimit } from "../../../../src/lib/rateLimit";
import { getUserId } from "../../../../src/lib/auth/getUser";
import { appendTranscript } from "../../../../src/lib/transcripts";
import {
  orchestrate,
  type SurfaceSnapshot,
} from "../../../../src/lib/intent";

export const dynamic = "force-dynamic";

/**
 * POST /api/transcripts/append (M3.0c)
 *
 * Persists one finalized utterance from a live avatar session into the
 * transcripts table. The avatar SDK emits `user.transcription` +
 * `avatar.transcription` events; the client buffers per-turn and calls
 * this route on speak-ended.
 *
 * Anonymous sessions are allowed (M3.0d test drive). user_id is captured
 * server-side from the auth cookie; the client doesn't send it.
 *
 * Body:
 *   {
 *     session_id: string,        // HeyGen session id
 *     speaker:    "user" | "avatar",
 *     text:       string,        // finalized utterance
 *     context?:   {              // optional per-turn metadata
 *       turn_index?: number,
 *       prior_avatar_text?: string,
 *       ...
 *     }
 *   }
 *
 * Returns: { id: string } on success, { error } otherwise.
 *
 * Failures here MUST never block the avatar UI — the client posts
 * fire-and-forget. We still return a structured response so dev tooling
 * can diagnose.
 */

const MAX_TEXT_CHARS = 8_000;        // ~5 minutes of speech at fast cadence
const MAX_SESSION_ID_CHARS = 256;

function bad(msg: string, status = 400) {
  return NextResponse.json({ error: msg }, { status });
}

export async function POST(request: NextRequest) {
  const originErr = assertAllowedOrigin(request);
  if (originErr) return originErr;
  const rateLimitErr = await checkRateLimit(request);
  if (rateLimitErr) return rateLimitErr;

  let body: {
    session_id?: unknown;
    speaker?: unknown;
    text?: unknown;
    context?: unknown;
    /**
     * M3.0e — optional snapshot of the assistant-surface state at the
     * moment of speech-end. Lets the orchestrator resolve "the first one"
     * / "Acme" references against what the user is actually looking at.
     */
    surface_snapshot?: unknown;
    /**
     * M3.4 — client-detected IANA timezone (browser `Intl.DateTimeFormat().resolvedOptions().timeZone`)
     * so "tomorrow at 10am" lands at 10am in the user's wall clock.
     */
    tz?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return bad("invalid JSON");
  }

  if (
    typeof body.session_id !== "string" ||
    body.session_id.length === 0 ||
    body.session_id.length > MAX_SESSION_ID_CHARS
  ) {
    return bad("session_id is required (string)");
  }
  if (body.speaker !== "user" && body.speaker !== "avatar") {
    return bad("speaker must be 'user' or 'avatar'");
  }
  if (
    typeof body.text !== "string" ||
    body.text.trim().length === 0 ||
    body.text.length > MAX_TEXT_CHARS
  ) {
    return bad("text is required (non-empty string up to 8000 chars)");
  }
  const context =
    typeof body.context === "object" && body.context !== null
      ? (body.context as Record<string, unknown>)
      : {};

  // Auth — captured server-side. Anonymous (null user_id) is allowed.
  const userId = await getUserId();

  const inserted = await appendTranscript({
    user_id: userId,
    session_id: body.session_id,
    speaker: body.speaker,
    text: body.text,
    context,
  });

  if (!inserted) {
    return NextResponse.json(
      {
        error: "Couldn't save that transcript turn. Try again.",
        debug: "appendTranscript returned null — see server logs",
      },
      { status: 500 },
    );
  }

  // M3.0e — On user transcripts only, run the intent orchestrator and
  // include its output in the response so the client can update the
  // assistant surface + send a context message to HeyGen's brain.
  // Avatar transcripts are persisted but never re-classified.
  if (body.speaker === "user") {
    const snapshot = parseSurfaceSnapshot(body.surface_snapshot);
    try {
      const tz =
        typeof body.tz === "string" && body.tz.length > 0 && body.tz.length < 64
          ? body.tz
          : null;
      const orch = await orchestrate({
        text: body.text,
        session_id: body.session_id,
        user_id: userId,
        currentSurface: snapshot,
        app_origin: new URL(request.url).origin,
        tz,
      });
      return NextResponse.json({
        id: inserted.id,
        orchestrator: orch,
      });
    } catch (e) {
      // Orchestrator failure must NOT break the transcript persist —
      // the row is already saved. Return the id with an orchestrator
      // error so DevTools can see what blew up.
      return NextResponse.json({
        id: inserted.id,
        orchestrator: {
          kind: "none",
          reason: `orchestrator threw: ${
            e instanceof Error ? e.message : "unknown"
          }`,
        },
      });
    }
  }

  return NextResponse.json({ id: inserted.id });
}

function parseSurfaceSnapshot(
  raw: unknown,
): SurfaceSnapshot | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as {
    kind?: unknown;
    contractorIds?: unknown;
    deliberation?: unknown;
  };
  const validKinds = new Set([
    "contractors",
    "summary",
    "picks",
    "pickResult",
    "compare",
    "appointment",
    "contract",
    "dispute",
    "call",
    "estimate",
    "recurring",
  ]);
  const kind =
    typeof r.kind === "string" && validKinds.has(r.kind)
      ? (r.kind as SurfaceSnapshot["kind"])
      : null;
  const contractorIds = Array.isArray(r.contractorIds)
    ? r.contractorIds.filter((x): x is string => typeof x === "string")
    : [];

  // Parse deliberation carryover (compare variant only)
  let deliberation: SurfaceSnapshot["deliberation"] | undefined;
  if (
    typeof r.deliberation === "object" &&
    r.deliberation !== null
  ) {
    const d = r.deliberation as { category?: unknown; constraints?: unknown };
    if (typeof d.category === "string" && d.category.trim() !== "") {
      const c =
        typeof d.constraints === "object" && d.constraints !== null
          ? (d.constraints as Record<string, unknown>)
          : {};
      deliberation = {
        category: d.category.trim(),
        constraints: {
          locally_owned:
            typeof c.locally_owned === "boolean"
              ? c.locally_owned
              : undefined,
          same_day:
            typeof c.same_day === "boolean" ? c.same_day : undefined,
          min_rating:
            typeof c.min_rating === "number" ? c.min_rating : undefined,
          max_price_tier:
            typeof c.max_price_tier === "number"
              ? (c.max_price_tier as 1 | 2 | 3 | 4)
              : undefined,
          max_distance_km:
            typeof c.max_distance_km === "number"
              ? c.max_distance_km
              : undefined,
          exclude_ids: Array.isArray(c.exclude_ids)
            ? c.exclude_ids.filter((x): x is string => typeof x === "string")
            : undefined,
        },
      };
    }
  }

  return { kind, contractorIds, deliberation };
}
