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
  // MACHINE-INJECTED context lines ride as user-role text ("[FIND — not
  // spoken by user] …") and must NEVER be classified as the user's own
  // speech — G's ride 2026-07-04: the contractor-onboarding intake captured
  // "first person as" (a fragment of an injected [FIND] prompt) as a
  // service area. Persist them, never orchestrate them.
  const isInjectedContext = /^\s*\[[^\]]{0,120}not spoken by user\]/i.test(
    body.text,
  );
  if (body.speaker === "user" && !isInjectedContext) {
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
    pendingFind?: unknown;
    pendingListIndex?: unknown;
    pendingAddOffer?: unknown;
    pendingListAdd?: unknown;
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
    "todo",
    "contractorOnboarding",
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

  // Parse the pending-find carryover (6 asked for city/ZIP; the client echoes
  // the remembered category so a bare "21093" answer resumes the find).
  let pendingFind: SurfaceSnapshot["pendingFind"] | undefined;
  if (typeof r.pendingFind === "object" && r.pendingFind !== null) {
    const p = r.pendingFind as { category?: unknown };
    if (typeof p.category === "string" && p.category.trim() !== "") {
      pendingFind = { category: p.category.trim().slice(0, 40) };
    }
  }

  // Parse the pending list-index carryover (6 read the user's list names and
  // asked "Which one?"). Without this, the client can remember the menu but the
  // server never sees it, so "first one" falls through to no-op/brain.
  let pendingListIndex: SurfaceSnapshot["pendingListIndex"] | undefined;
  if (
    typeof r.pendingListIndex === "object" &&
    r.pendingListIndex !== null
  ) {
    const p = r.pendingListIndex as { entries?: unknown };
    const entries = Array.isArray(p.entries)
      ? p.entries
          .map((entry) => {
            if (typeof entry !== "object" || entry === null) return null;
            const e = entry as { id?: unknown; title?: unknown };
            if (typeof e.id !== "string" || typeof e.title !== "string") {
              return null;
            }
            const id = e.id.trim().slice(0, 128);
            const title = e.title.trim().slice(0, 120);
            return id && title ? { id, title } : null;
          })
          .filter((entry): entry is { id: string; title: string } => Boolean(entry))
          .slice(0, 20)
      : [];
    if (entries.length > 0) pendingListIndex = { entries };
  }

  // Parse the one-shot add-offer carryover (6 spoke "want me to add X?";
  // the client echoes the offered items so a bare "yes" resolves them into
  // a real, deterministic add — aiASAP ITEM 4, Herm TASK_070 blocker #2).
  let pendingAddOffer: SurfaceSnapshot["pendingAddOffer"] | undefined;
  if (typeof r.pendingAddOffer === "object" && r.pendingAddOffer !== null) {
    const p = r.pendingAddOffer as { items?: unknown };
    if (Array.isArray(p.items)) {
      const items = p.items
        .filter((x): x is string => typeof x === "string")
        .map((s) => s.trim())
        .filter((s) => s.length >= 2 && s.length <= 80)
        .slice(0, 5);
      if (items.length > 0) pendingAddOffer = { items };
    }
  }

  // Parse the one-shot list-intake carryover (6 asked "what should I put on
  // it?"; the next plain answer becomes real items — Herm TASK_094).
  let pendingListAdd: SurfaceSnapshot["pendingListAdd"] | undefined;
  if (typeof r.pendingListAdd === "object" && r.pendingListAdd !== null) {
    const p = r.pendingListAdd as { listName?: unknown };
    pendingListAdd = {
      listName:
        typeof p.listName === "string" && p.listName.trim() !== ""
          ? p.listName.trim().slice(0, 60)
          : null,
    };
  }

  return {
    kind,
    contractorIds,
    deliberation,
    pendingFind,
    pendingListIndex,
    pendingAddOffer,
    pendingListAdd,
  };
}
