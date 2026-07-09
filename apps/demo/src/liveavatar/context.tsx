import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ConnectionQuality,
  LiveAvatarSession,
  SessionState,
  SessionEvent,
  VoiceChatEvent,
  VoiceChatState,
  AgentEventsEnum,
} from "@heygen/liveavatar-web-sdk";
import { LiveAvatarSessionMessage } from "./types";
import { isVideoBusy } from "./videoRecordingState";
import {
  useAssistantSurface,
  type SurfaceVariant,
} from "../lib/assistantSurface";
import {
  ADD_OFFER_RE,
  parseOfferedAddItems,
  type ListIndexEntry,
} from "../lib/lists";
import { UI_SIZE_BIGGER_RE, UI_SIZE_SMALLER_RE } from "../lib/uiSize";

type ButtonCueTarget = "camera" | "video" | "gallery";

// Returns each matched target WITH its first-match position in the text, in
// spoken order. Position matters: when a transcript chunk carries several
// button words at once ("hit Camera for a photo, Video for a clip, or
// Gallery…"), the cues must fire in the order 6 SAYS them, staggered — not
// all in the same tick (G live-ride 2026-07-07: "camera and gallery just
// shook together… when Six says the word video, the video button should
// shake").
function avatarButtonCueTargetsFromText(
  text: string,
): Array<{ target: ButtonCueTarget; index: number }> {
  const t = text.toLowerCase();
  const found: Array<{ target: ButtonCueTarget; index: number }> = [];
  // Bare words cue too — G's exact ask is "when Six says the WORD video, the
  // video button should shake" (Herm TASK_139 red-team: the old compound-only
  // phrases missed bare Camera/Video; `camera roll` stays a Gallery cue, so
  // Camera negative-lookaheads it).
  const CAMERA_RE =
    /\b(?:camera(?!\s+roll)|photo\s+button|picture\s+button|take\s+(?:a\s+)?(?:picture|photo)|snap\s+(?:a\s+)?picture)\b/;
  const VIDEO_RE =
    /\b(?:video|take\s+(?:a\s+)?video|record\s+(?:a\s+)?video|shoot\s+(?:a\s+)?video)\b/;
  const GALLERY_RE =
    /\b(?:gallery|open\s+(?:the\s+)?gallery|camera\s+roll|photo\s+library)\b/;
  const cam = CAMERA_RE.exec(t);
  if (cam) found.push({ target: "camera", index: cam.index });
  const vid = VIDEO_RE.exec(t);
  if (vid) found.push({ target: "video", index: vid.index });
  const gal = GALLERY_RE.exec(t);
  if (gal) found.push({ target: "gallery", index: gal.index });
  return found.sort((a, b) => a.index - b.index);
}

type LiveAvatarContextProps = {
  sessionRef: React.RefObject<LiveAvatarSession>;

  isMuted: boolean;
  voiceChatState: VoiceChatState;

  sessionState: SessionState;
  isStreamReady: boolean;
  connectionQuality: ConnectionQuality;

  isUserTalking: boolean;
  isAvatarTalking: boolean;

  messages: LiveAvatarSessionMessage[];
  microphoneWarning: string | null;
  /** Call when user or avatar has activity (e.g. sent message, spoke) so inactivity timeout is reset */
  reportActivity: () => void;
  /** Returns true if the last stop was due to inactivity timeout (then clears the flag). Used so UI can avoid auto-restart. */
  wasStoppedDueToInactivity: () => boolean;
};

export const LiveAvatarContext = createContext<LiveAvatarContextProps>({
  sessionRef: {
    current: null,
  } as unknown as React.RefObject<LiveAvatarSession>,
  connectionQuality: ConnectionQuality.UNKNOWN,
  isMuted: true,
  voiceChatState: VoiceChatState.INACTIVE,
  sessionState: SessionState.DISCONNECTED,
  isStreamReady: false,
  isUserTalking: false,
  isAvatarTalking: false,
  messages: [],
  microphoneWarning: null,
  reportActivity: () => {},
  wasStoppedDueToInactivity: () => false,
});

type LiveAvatarContextProviderProps = {
  children: React.ReactNode;
  sessionAccessToken: string;
};

const useSessionState = (sessionRef: React.RefObject<LiveAvatarSession>) => {
  const [sessionState, setSessionState] = useState<SessionState>(
    sessionRef.current?.state || SessionState.INACTIVE,
  );
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality>(
    sessionRef.current?.connectionQuality || ConnectionQuality.UNKNOWN,
  );
  const [isStreamReady, setIsStreamReady] = useState<boolean>(false);

  useEffect(() => {
    if (sessionRef.current) {
      sessionRef.current.on(SessionEvent.SESSION_STATE_CHANGED, (state) => {
        setSessionState(state);
        if (state === SessionState.DISCONNECTED) {
          sessionRef.current.removeAllListeners();
          sessionRef.current.voiceChat.removeAllListeners();
          setIsStreamReady(false);
        }
      });
      sessionRef.current.on(SessionEvent.SESSION_STREAM_READY, () => {
        setIsStreamReady(true);
      });
      sessionRef.current.on(
        SessionEvent.SESSION_CONNECTION_QUALITY_CHANGED,
        setConnectionQuality,
      );
    }
  }, [sessionRef]);

  return { sessionState, isStreamReady, connectionQuality };
};

const useVoiceChatState = (sessionRef: React.RefObject<LiveAvatarSession>) => {
  const [isMuted, setIsMuted] = useState(true);
  const [voiceChatState, setVoiceChatState] = useState<VoiceChatState>(
    sessionRef.current?.voiceChat.state || VoiceChatState.INACTIVE,
  );
  const [microphoneWarning, setMicrophoneWarning] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (sessionRef.current) {
      sessionRef.current.voiceChat.on(VoiceChatEvent.MUTED, () => {
        setIsMuted(true);
      });
      sessionRef.current.voiceChat.on(VoiceChatEvent.UNMUTED, () => {
        setIsMuted(false);
      });
      sessionRef.current.voiceChat.on(
        VoiceChatEvent.STATE_CHANGED,
        setVoiceChatState,
      );
      sessionRef.current.voiceChat.on(
        VoiceChatEvent.WARNING,
        (message: string) => {
          setMicrophoneWarning(message);
        },
      );
    }
  }, [sessionRef]);

  return { isMuted, voiceChatState, microphoneWarning };
};

/**
 * M3.0c + M3.0e — Buffer per-turn USER_TRANSCRIPTION + AVATAR_TRANSCRIPTION
 * events, flush each finalized turn to /api/transcripts/append on speak-ended,
 * and on user turns consume the orchestrator's response: update the
 * assistant surface drawer and queue any context message so HeyGen's brain
 * narrates the actual backend result on the next AVATAR_SPEAK_ENDED.
 *
 * The avatar SDK fires transcription events repeatedly during a turn (each
 * event carries the current cumulative text). We hold the latest text in
 * a ref and persist exactly one row per turn — keeps row count proportional
 * to utterance count, not event count, and matches what M3.0e + M3.9 want
 * to read.
 *
 * Fire-and-forget for the POST itself — never breaks the avatar UI on
 * persist failure. But the response IS consumed for orchestrator output.
 *
 * Concurrency strategy (Q3.0c default): we wait for AVATAR_SPEAK_ENDED
 * before sending the context message via session.message(). This gives
 * a natural "let me check… OK, here's what I found" rhythm. If HeyGen's
 * brain isn't currently speaking when the orchestrator returns, we send
 * immediately.
 */
const useTranscriptCapture = (
  sessionRef: React.RefObject<LiveAvatarSession>,
) => {
  const userTurnRef = useRef<string>("");
  const avatarTurnRef = useRef<string>("");
  const pendingContextMessageRef = useRef<string | null>(null);
  const isAvatarSpeakingRef = useRef<boolean>(false);
  // 6 asked "what city or ZIP?" for a find — remember the category so the
  // user's bare "21093" answer resumes THAT search (G smoke 2026-07-01: the
  // answer went nowhere and the brain invented a plumber). Echoed back to
  // the orchestrator in every snapshot while fresh; cleared when cards land
  // or after 3 minutes.
  const pendingFindRef = useRef<{ category: string; at: number } | null>(null);
  const PENDING_FIND_TTL_MS = 3 * 60_000;
  // 6 just read the user's saved list names and asked "Which one?". The
  // orchestrator can resolve the next short answer ("first one", "house") only
  // if the client echoes this index back in the surface snapshot. Keep it short
  // lived so a stale menu never hijacks normal conversation minutes later.
  const pendingListIndexRef = useRef<{
    entries: ListIndexEntry[];
    at: number;
  } | null>(null);
  const PENDING_LIST_INDEX_TTL_MS = 3 * 60_000;
  // 6 asked "what should I put on it?" (make-list with no items). The next
  // plain user answer becomes REAL items via the relaxed pending-answer
  // splitter server-side (Herm TASK_094 blocker #2; G smoke #6: "a painter,
  // a plumber, and a roofer" went nowhere while 6 claimed it was saved).
  const pendingListAddRef = useRef<{
    listName: string | null;
    at: number;
  } | null>(null);
  const PENDING_LIST_ADD_TTL_MS = 3 * 60_000;
  // 6 SPOKE an add-offer ("Want me to add milk?") — armed from his avatar
  // transcript (ADD_OFFER_RE + parseOfferedAddItems). ONE-SHOT: the next
  // user utterance either resolves it server-side (bare "yes" → real add via
  // the todo.add_offer_yes rule) or kills it. aiASAP ITEM 4, wired per Herm
  // TASK_070 blocker #2.
  const pendingAddOfferRef = useRef<{
    items: string[];
    at: number;
  } | null>(null);
  const PENDING_ADD_OFFER_TTL_MS = 2 * 60_000;
  // 6 asked "are you sure you want to delete your account?" (the
  // delete_account request turn armed this via orch.pending). While
  // fresh, the snapshot echoes it so the ctx-gated confirm rule can
  // accept a whole-utterance "yes" — and ONLY then. Short TTL: an
  // unanswered are-you-sure dies on its own and deletion never arms.
  const pendingAccountDeleteConfirmRef = useRef<{ at: number } | null>(null);
  const PENDING_ACCOUNT_DELETE_TTL_MS = 2 * 60_000;
  const avatarButtonCueSeenRef = useRef<Set<ButtonCueTarget>>(new Set());
  // Staggered cue timers — when several button words land in ONE transcript
  // chunk, later ones fire ~880ms apart in spoken order instead of together
  // (G live-ride 2026-07-07: "camera and gallery just shook together").
  const avatarButtonCueTimersRef = useRef<number[]>([]);
  const clearAvatarButtonCueTimers = useCallback(() => {
    if (typeof window === "undefined") return;
    for (const id of avatarButtonCueTimersRef.current) window.clearTimeout(id);
    avatarButtonCueTimersRef.current = [];
  }, []);
  // WORD-TIMED cues (G live-ride 19:44: "on the timing that Six SAYS it").
  // The transcript text streams ahead of the voice, so a cue fired on text
  // arrival lands early. Anchor each cue to WHERE its word sits in the
  // sentence: chars-from-start ÷ speaking pace, measured from the moment
  // this avatar turn started speaking.
  const AVATAR_SPEECH_CHARS_PER_SEC = 14;
  const avatarSpeechStartedAtRef = useRef<number>(0);
  const dispatchAvatarButtonCues = useCallback((text: string) => {
    if (typeof window === "undefined") return;
    const fresh = avatarButtonCueTargetsFromText(text).filter(
      ({ target }) => !avatarButtonCueSeenRef.current.has(target),
    );
    // Mark seen SYNCHRONOUSLY (cumulative transcript events re-run this fn
    // constantly — a pending timer must not double-queue its target).
    for (const { target } of fresh) avatarButtonCueSeenRef.current.add(target);
    // Chunk arrival IS the word's spoken moment (G 19:48: a late-sentence
    // "gallery" missed its shake — the old whole-sentence char math pushed
    // it seconds out). The transcript streams cumulatively in near-realtime,
    // so a word's FIRST appearance means 6 is saying it about now: fire
    // almost immediately, with a small beat between words that land in the
    // same chunk (in spoken order).
    let prevDelay = -400;
    const firedThisCall: string[] = [];
    fresh.forEach(({ target }) => {
      const fire = () =>
        window.dispatchEvent(
          new CustomEvent("isolve:button-cue", {
            detail: { target, source: "avatar-transcript" },
          }),
        );
      let delay = 150;
      if (delay < prevDelay + 400) delay = prevDelay + 400;
      prevDelay = delay;
      firedThisCall.push(target);
      avatarButtonCueTimersRef.current.push(window.setTimeout(fire, delay));
    });
    // "Then they ALL shake and puff up" (G 19:43/19:44): once this turn has
    // named all three, one grand all-together puff after the last word.
    if (
      avatarButtonCueSeenRef.current.size >= 3 &&
      firedThisCall.length > 0 &&
      !avatarButtonCueSeenRef.current.has("__all_fired__" as ButtonCueTarget)
    ) {
      avatarButtonCueSeenRef.current.add("__all_fired__" as ButtonCueTarget);
      const allDelay = prevDelay + 900;
      avatarButtonCueTimersRef.current.push(
        window.setTimeout(() => {
          for (const target of ["camera", "video", "gallery"] as const) {
            window.dispatchEvent(
              new CustomEvent("isolve:button-cue", {
                detail: { target, source: "avatar-transcript", grand: true },
              }),
            );
          }
        }, allDelay),
      );
    }
  }, []);
  const dispatchAvatarUiTranscript = useCallback((text: string) => {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("isolve:avatar-ui-transcript", {
        detail: { text, source: "avatar-transcript" },
      }),
    );
  }, []);
  const dispatchAvatarUtterance = useCallback((text: string) => {
    if (typeof window === "undefined") return;
    const trimmed = text.trim();
    if (trimmed.length < 8) return;
    window.dispatchEvent(
      new CustomEvent("isolve:avatar-utterance", {
        detail: { text: trimmed, source: "avatar-speak-ended" },
      }),
    );
  }, []);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;

    const applyVariant = (variant: SurfaceVariant) => {
      const store = useAssistantSurface.getState();
      switch (variant.kind) {
        case "contractors":
          store.showContractors(variant.hits, variant.total_considered);
          break;
        case "summary":
          store.showSummary(variant.payload, variant.cached);
          break;
        case "picks":
          store.showRecommendations(
            variant.picks,
            variant.preference_facts,
          );
          break;
        case "pickResult":
          store.showPickResult(variant.payload);
          break;
        case "compare":
          store.showCompare(variant.payload);
          break;
        case "appointment":
          store.showAppointment(variant.payload);
          break;
        case "contract":
          store.showContract(variant.payload);
          break;
        case "dispute":
          store.showDispute(variant.payload);
          break;
        case "call":
          store.showCall(variant.payload);
          break;
        case "estimate":
          store.showEstimate(variant.payload);
          break;
        case "recurring":
          store.showRecurring(variant.payload);
          break;
        case "todo": {
          // GUEST STAGING merge (Herm TASK_106): the server is stateless for
          // anonymous lists, so the client accumulates transient items across
          // turns — dedupe by title, renumber, never touch persisted lists.
          const current = store.variant;
          if (
            variant.payload.transient &&
            current?.kind === "todo" &&
            current.payload.transient &&
            current.payload.list_id === variant.payload.list_id
          ) {
            const seen = new Set<string>();
            const merged = [...current.payload.items, ...variant.payload.items]
              .filter((item) => {
                const key = item.title.trim().toLowerCase();
                if (!key || seen.has(key)) return false;
                seen.add(key);
                return true;
              })
              .map((item, index) => ({ ...item, position: index + 1 }));
            store.showTodo({ ...variant.payload, items: merged });
          } else {
            store.showTodo(variant.payload);
          }
          break;
        }
        case "contractorOnboarding":
          store.showContractorOnboarding(variant.payload);
          break;
      }
    };

    const buildSnapshot = (): {
      kind:
        | "contractors"
        | "summary"
        | "picks"
        | "pickResult"
        | "compare"
        | "appointment"
        | "contract"
        | "dispute"
        | "call"
        | "estimate"
        | "todo"
        | "contractorOnboarding"
        | "recurring"
        | null;
      contractorIds: string[];
      todo?: {
        list_id: string;
        list_title: string;
        items: Array<{ id: string; title: string; position: number }>;
        transient?: boolean;
      };
      deliberation?: {
        category: string;
        constraints: Record<string, unknown>;
      };
      pendingFind?: { category: string };
      pendingListIndex?: { entries: ListIndexEntry[] };
      pendingAddOffer?: { items: string[] };
      pendingListAdd?: { listName: string | null };
      pendingAccountDeleteConfirm?: boolean;
    } => {
      // Pending-find rides on EVERY snapshot while fresh — including the
      // no-variant one (nothing is on screen while 6 waits for the ZIP).
      const pf = pendingFindRef.current;
      if (pf && Date.now() - pf.at > PENDING_FIND_TTL_MS) {
        pendingFindRef.current = null;
      }
      const pendingFind = pendingFindRef.current
        ? { category: pendingFindRef.current.category }
        : undefined;
      const pli = pendingListIndexRef.current;
      if (pli && Date.now() - pli.at > PENDING_LIST_INDEX_TTL_MS) {
        pendingListIndexRef.current = null;
      }
      const pendingListIndex = pendingListIndexRef.current
        ? { entries: pendingListIndexRef.current.entries }
        : undefined;
      const pao = pendingAddOfferRef.current;
      if (pao && Date.now() - pao.at > PENDING_ADD_OFFER_TTL_MS) {
        pendingAddOfferRef.current = null;
      }
      const pendingAddOffer = pendingAddOfferRef.current
        ? { items: pendingAddOfferRef.current.items }
        : undefined;
      const pla = pendingListAddRef.current;
      if (pla && Date.now() - pla.at > PENDING_LIST_ADD_TTL_MS) {
        pendingListAddRef.current = null;
      }
      const pendingListAdd = pendingListAddRef.current
        ? { listName: pendingListAddRef.current.listName }
        : undefined;
      const pad = pendingAccountDeleteConfirmRef.current;
      if (pad && Date.now() - pad.at > PENDING_ACCOUNT_DELETE_TTL_MS) {
        pendingAccountDeleteConfirmRef.current = null;
      }
      const pendingAccountDeleteConfirm = pendingAccountDeleteConfirmRef.current
        ? true
        : undefined;
      // A dismissed sheet can keep its variant for exit animation, but it is
      // not on screen. Do not let ✕/ESC ghost-steer the next classifier turn.
      const { variant, isOpen } = useAssistantSurface.getState();
      if (!variant || !isOpen) {
        return {
          kind: null,
          contractorIds: [],
          pendingFind,
          pendingListIndex,
          pendingAddOffer,
          pendingListAdd,
          pendingAccountDeleteConfirm,
        };
      }
      const snap = ((): {
        kind:
          | "contractors"
          | "summary"
          | "picks"
          | "pickResult"
          | "compare"
          | "appointment"
          | "contract"
          | "dispute"
          | "call"
          | "estimate"
          | "todo"
          | "contractorOnboarding"
          | "recurring"
          | null;
        contractorIds: string[];
        todo?: {
          list_id: string;
          list_title: string;
          items: Array<{ id: string; title: string; position: number }>;
          transient?: boolean;
        };
        deliberation?: {
          category: string;
          constraints: Record<string, unknown>;
        };
      } => {
      switch (variant.kind) {
        case "contractors":
          return {
            kind: "contractors",
            contractorIds: variant.hits.map((h) => h.id),
          };
        case "picks":
          return {
            kind: "picks",
            contractorIds: variant.picks.map((p) => p.id),
          };
        case "summary":
          return {
            kind: "summary",
            contractorIds: [variant.payload.contractor_id],
          };
        case "pickResult":
          return {
            kind: "pickResult",
            contractorIds: variant.payload.winner
              ? [variant.payload.winner.contractor_id]
              : [],
          };
        case "compare":
          return {
            kind: "compare",
            contractorIds: variant.payload.picks.map((p) => p.id),
            deliberation: {
              category: variant.payload.state.category,
              constraints: variant.payload.state.constraints,
            },
          };
        case "appointment":
          // Pull contractor IDs from the listed appointments so a
          // follow-up "tell me more about them" can resolve.
          return {
            kind: "appointment",
            contractorIds: variant.payload.appointments
              .map((a) => a.contractor_id)
              .filter((id): id is string => !!id),
          };
        case "contract":
          // No contractor IDs leak into the snapshot from a contract panel
          // — the contract belongs to a contractor but we don't expose
          // their ID through this surface in v1.
          return { kind: "contract", contractorIds: [] };
        case "dispute":
          // Dispute panel doesn't expose contractor IDs to the snapshot;
          // follow-up actions should reference the dispute directly.
          return { kind: "dispute", contractorIds: [] };
        case "call":
          // Live call panel — only the contractor on the line is
          // surfaced as the snapshot's contractor (resolves "tell me
          // more about them" naturally).
          return { kind: "call", contractorIds: [] };
        case "estimate":
          // Estimate panel — same as call: no contractor ID surfacing.
          return { kind: "estimate", contractorIds: [] };
        case "todo":
          // List panel — no contractor IDs; the kind lets follow-up list
          // commands ("check off number two") resolve against what's shown.
          return {
            kind: "todo",
            contractorIds: [],
            todo: {
              list_id: variant.payload.list_id,
              list_title: variant.payload.list_title,
              items: variant.payload.items.map((item) => ({
                id: item.id,
                title: item.title,
                position: item.position,
              })),
              transient: variant.payload.transient === true,
            },
          };
        case "contractorOnboarding":
          // Onboarding is the trade-pro signing up — no homeowner-facing
          // contractor IDs. The kind lets "save it"/"done" resolve to save.
          return { kind: "contractorOnboarding", contractorIds: [] };
        case "recurring":
          // Recurring-job panel (M4.7) — no contractor ID surfacing; the
          // kind lets follow-ups ("pause it") resolve against the panel.
          return { kind: "recurring", contractorIds: [] };
      }
      })();
      return {
        ...snap,
        pendingFind,
        pendingListIndex,
        pendingAddOffer,
        pendingListAdd,
        pendingAccountDeleteConfirm,
      };
    };

    const sendOrQueueContextMessage = (msg: string) => {
      const s = sessionRef.current;
      if (!s) return;
      if (isAvatarSpeakingRef.current) {
        pendingContextMessageRef.current = msg;
      } else {
        try {
          s.message(msg);
        } catch (e) {
          console.warn("session.message threw:", e);
        }
      }
    };

    const flushUser = async (text: string) => {
      const sid = sessionRef.current?.sessionId;
      if (!sid) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      try {
        // Browser-detected IANA tz — server uses this for "tomorrow at 10am"
        // style parsing so the appointment lands at 10am in the user's
        // wall clock, not 10am UTC. Falls back to UTC server-side if absent.
        let tz: string | null = null;
        try {
          tz = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
        } catch {
          tz = null;
        }
        // "Never mind" kills the list intake HERE — the server rule bails
        // on cancel words, so without this the stale "what should I put on
        // it?" slot would linger until TTL (Herm TASK_095 rewrite note).
        // Cleared BEFORE the snapshot builds so the ask dies this turn.
        if (
          pendingListAddRef.current &&
          /\b(?:never\s*mind|forget\s+(?:it|that|the\s+list)|cancel(?:\s+(?:it|that|the\s+list))?|no\s+list|drop\s+it)\b/i.test(
            trimmed,
          )
        ) {
          pendingListAddRef.current = null;
        }
        // A "no" to 6's "are you sure you want to delete your account?"
        // kills the confirm window HERE, before the snapshot builds —
        // the safest possible answer dies the same turn it's spoken.
        if (
          pendingAccountDeleteConfirmRef.current &&
          /^\s*(?:no|nope|nah|never\s*mind|forget\s+it|cancel|stop|wait|don'?t|do\s+not|keep\s+(?:it|my\s+account))\b/i.test(
            trimmed,
          )
        ) {
          pendingAccountDeleteConfirmRef.current = null;
        }
        // SUP #22 (G 16:55 ride: "make the text bigger" → "I can't change
        // the text size"): a size ask while the list sheet is open resizes
        // the on-screen text INSTANTLY client-side, and the brain gets told
        // what happened instead of freelancing a refusal. Handled fully
        // here — this turn never reaches the pill brain or the orchestrator
        // (a size ask is UI meta-talk, not list content).
        {
          const wantsBigger = UI_SIZE_BIGGER_RE.test(trimmed);
          const wantsSmaller = !wantsBigger && UI_SIZE_SMALLER_RE.test(trimmed);
          if (wantsBigger || wantsSmaller) {
            // GLOBAL, not list-only (G live-ride 19:38: "make the letters
            // bigger, make everything bigger" — said at the PILLS with no
            // list open). One shared level drives pills + list text.
            const store = useAssistantSurface.getState();
            const changed = store.bumpTodoTextSizeLevel(wantsBigger ? 1 : -1);
            const line = changed
              ? `I just made the on-screen text ${wantsBigger ? "bigger" : "smaller"}.`
              : `the text is already at its ${wantsBigger ? "biggest" : "smallest"} readable size.`;
            sendOrQueueContextMessage(
              `[TEXT SIZE — not spoken by user] ${line} Confirm in one short sentence in first person as 6. Do not mention saving, accounts, or email.`,
            );
            return;
          }
        }
        // Machine-injected context lines ("[FIND — not spoken by user] …")
        // must never feed the pill brain — G's ride 2026-07-04: one became
        // latestUserText and minted pills from the machine's own prompt.
        const isInjectedContext =
          /^\s*\[[^\]]{0,120}not spoken by user\]/i.test(trimmed);
        // Pill brain (aiASAP port, G smoke #7): hand the session UI this
        // utterance so the subject pills can refresh. Fire-and-forget.
        try {
          if (typeof window !== "undefined" && !isInjectedContext) {
            window.dispatchEvent(
              new CustomEvent("isolve:user-utterance", {
                detail: { text: trimmed },
              }),
            );
          }
        } catch {
          /* never break transcript flow */
        }
        const res = await fetch("/api/transcripts/append", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sid,
            speaker: "user",
            text: trimmed,
            surface_snapshot: buildSnapshot(),
            tz,
          }),
        });
        // ONE-SHOT: the offer rode on THIS turn's snapshot. Whether the user
        // said yes (server resolved it into a real add) or anything else, the
        // slot dies now — a "yeah" minutes later must never write a list.
        pendingAddOfferRef.current = null;
        // Same one-shot rule for the delete-account are-you-sure window:
        // it rode on THIS turn's snapshot, so it dies now no matter what
        // the user said. The answer to "are you sure?" must be the very
        // next utterance — a "yes" two questions later (answering
        // something else entirely) must never start the 30-day clock.
        // (The response handler below re-arms it if THIS turn was itself
        // the delete request.)
        pendingAccountDeleteConfirmRef.current = null;
        if (!res.ok) return;
        const data = (await res.json()) as {
          id?: string;
          orchestrator?: {
            kind: "action" | "none";
            variant?: SurfaceVariant;
            dismissSurface?: boolean;
            contextMessage?: string;
            pending?:
              | { kind: "find"; category: string }
              | { kind: "list_index"; entries: ListIndexEntry[] }
              | { kind: "list_add"; listName?: string | null }
              | { kind: "account_delete_confirm" };
            reason?: string;
          };
        };
        const orch = data.orchestrator;
        if (orch?.kind === "action") {
          if (orch.dismissSurface) {
            pendingFindRef.current = null;
            pendingListIndexRef.current = null;
            pendingAddOfferRef.current = null;
            pendingListAddRef.current = null;
            pendingAccountDeleteConfirmRef.current = null;
            useAssistantSurface.getState().reset();
          } else {
            // Multi-turn continuations: remember "6 asked for city/ZIP for X"
            // so the bare location answer resumes that find; a landed
            // contractors surface means the find completed — clear it.
            // One-shot list intake: the server just asked "what should I put
            // on it?" — arm it; ANY other handled action means the answer was
            // consumed (todo variant) or the user moved on — drop it.
            if (orch.pending?.kind === "list_add") {
              pendingListAddRef.current = {
                listName: orch.pending.listName ?? null,
                at: Date.now(),
              };
            } else {
              pendingListAddRef.current = null;
            }
            // Are-you-sure window for account deletion: armed ONLY by
            // the delete_account request turn; any other handled action
            // means the user answered (confirm consumed server-side) or
            // moved on — either way the window dies so a later stray
            // "yes" can never start the 30-day clock.
            if (orch.pending?.kind === "account_delete_confirm") {
              pendingAccountDeleteConfirmRef.current = { at: Date.now() };
            } else {
              pendingAccountDeleteConfirmRef.current = null;
            }
            if (orch.pending?.kind === "find") {
              pendingFindRef.current = {
                category: orch.pending.category,
                at: Date.now(),
              };
              pendingListIndexRef.current = null;
            } else if (orch.pending?.kind === "list_index") {
              pendingListIndexRef.current = {
                entries: orch.pending.entries,
                at: Date.now(),
              };
              pendingFindRef.current = null;
            } else if (orch.variant?.kind === "contractors") {
              pendingFindRef.current = null;
              pendingListIndexRef.current = null;
            } else {
              // Any other handled action means the user moved past the menu or
              // the pending list pick was consumed server-side. Drop it so a
              // later short phrase can't reopen an old list by accident.
              pendingListIndexRef.current = null;
            }
            if (orch.variant) applyVariant(orch.variant);
          }
          if (orch.contextMessage) {
            sendOrQueueContextMessage(orch.contextMessage);
          }
        }
      } catch (e) {
        console.warn("transcripts append failed (user):", e);
      }
    };

    const flushAvatar = async (text: string) => {
      const sid = sessionRef.current?.sessionId;
      if (!sid) return;
      const trimmed = text.trim();
      if (!trimmed) return;
      // Arm the one-shot add-offer slot from 6's OWN spoken line ("Want me
      // to add milk and eggs?") — the next user "yes" resolves those exact
      // items into a real add server-side (aiASAP ITEM 4, Herm TASK_070).
      try {
        if (ADD_OFFER_RE.test(trimmed)) {
          const items = parseOfferedAddItems(trimmed);
          if (items.length > 0) {
            pendingAddOfferRef.current = { items, at: Date.now() };
          }
        }
      } catch {
        /* offer detection must never break transcript flow */
      }
      // 6 named a button — cue the UI shake immediately from avatar transcript
      // phrases (SUP 2026-07-05): camera/picture, video, and gallery each get
      // their own one-shot cue per spoken turn.
      try {
        dispatchAvatarButtonCues(trimmed);
      } catch {
        /* cue detection must never break transcript flow */
      }
      try {
        await fetch("/api/transcripts/append", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            session_id: sid,
            speaker: "avatar",
            text: trimmed,
          }),
        });
      } catch (e) {
        console.warn("transcripts append failed (avatar):", e);
      }
    };

    const onUserTranscription = (event: { text: string }) => {
      if (typeof event?.text === "string") {
        userTurnRef.current = event.text;
        // "When ANYBODY says camera/video/gallery — user or 6 — they shake,
        // just for fun" (G live-ride 19:48). User words fire on arrival;
        // the avatar-side seen-set dedups per turn either way.
        try {
          dispatchAvatarButtonCues(event.text);
        } catch {
          /* cue detection must never break transcript flow */
        }
      }
    };
    const onAvatarTranscription = (event: { text: string }) => {
      if (typeof event?.text === "string") {
        avatarTurnRef.current = event.text;
        dispatchAvatarButtonCues(event.text);
        dispatchAvatarUiTranscript(event.text);
      }
    };
    const onUserSpeakEnded = () => {
      const text = userTurnRef.current;
      userTurnRef.current = "";
      if (text) void flushUser(text);
    };
    const onAvatarSpeakStarted = () => {
      isAvatarSpeakingRef.current = true;
      avatarButtonCueSeenRef.current = new Set();
      // Anchor for word-timed cues: each button word fires at its spoken
      // moment, measured from this turn's speech start (G 19:44).
      avatarSpeechStartedAtRef.current = Date.now();
      // A queued stagger-shake from the PREVIOUS turn must not fire into
      // this new sentence.
      clearAvatarButtonCueTimers();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("isolve:avatar-speak-start"));
      }
    };
    const onAvatarSpeakEnded = () => {
      isAvatarSpeakingRef.current = false;
      const text = avatarTurnRef.current;
      avatarTurnRef.current = "";
      if (text) {
        dispatchAvatarUtterance(text);
        void flushAvatar(text);
      }
      // Any pending context message rides on the next avatar-silence.
      const pending = pendingContextMessageRef.current;
      pendingContextMessageRef.current = null;
      if (pending) {
        try {
          sessionRef.current?.message(pending);
        } catch (e) {
          console.warn("session.message (pending) threw:", e);
        }
      }
    };

    session.on(AgentEventsEnum.USER_TRANSCRIPTION, onUserTranscription);
    session.on(AgentEventsEnum.AVATAR_TRANSCRIPTION, onAvatarTranscription);
    session.on(AgentEventsEnum.USER_SPEAK_ENDED, onUserSpeakEnded);
    session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, onAvatarSpeakStarted);
    session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, onAvatarSpeakEnded);

    // SUP #5: a tapped list-item ✕ arrives as a synthetic user turn and
    // rides the exact voice path above — same snapshot, same orchestrator,
    // same guest/signed-in remove handling as the spoken command.
    const onSyntheticUserUtterance = (event: Event) => {
      const detail = (
        event as CustomEvent<{ source?: unknown; text?: unknown }>
      ).detail;
      if (detail?.source !== "todo-remove-tap") return;
      const text = typeof detail.text === "string" ? detail.text.trim() : "";
      if (!text) return;
      void flushUser(text);
    };
    if (typeof window !== "undefined") {
      window.addEventListener(
        "isolve:synthetic-user-utterance",
        onSyntheticUserUtterance,
      );
    }

    return () => {
      // A queued stagger-shake must not fire after teardown (Herm TASK_139:
      // cue timer could survive session stop for up to the stagger tail).
      clearAvatarButtonCueTimers();
      if (typeof window !== "undefined") {
        window.removeEventListener(
          "isolve:synthetic-user-utterance",
          onSyntheticUserUtterance,
        );
      }
      session.off(AgentEventsEnum.USER_TRANSCRIPTION, onUserTranscription);
      session.off(AgentEventsEnum.AVATAR_TRANSCRIPTION, onAvatarTranscription);
      session.off(AgentEventsEnum.USER_SPEAK_ENDED, onUserSpeakEnded);
      session.off(AgentEventsEnum.AVATAR_SPEAK_STARTED, onAvatarSpeakStarted);
      session.off(AgentEventsEnum.AVATAR_SPEAK_ENDED, onAvatarSpeakEnded);
    };
  }, [sessionRef, dispatchAvatarButtonCues, clearAvatarButtonCueTimers, dispatchAvatarUiTranscript, dispatchAvatarUtterance]);
};

const useTalkingState = (sessionRef: React.RefObject<LiveAvatarSession>) => {
  const [isUserTalking, setIsUserTalking] = useState(false);
  const [isAvatarTalking, setIsAvatarTalking] = useState(false);

  useEffect(() => {
    if (sessionRef.current) {
      sessionRef.current.on(AgentEventsEnum.USER_SPEAK_STARTED, () => {
        setIsUserTalking(true);
      });
      sessionRef.current.on(AgentEventsEnum.USER_SPEAK_ENDED, () => {
        setIsUserTalking(false);
      });
      sessionRef.current.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, () => {
        setIsAvatarTalking(true);
      });
      sessionRef.current.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, () => {
        setIsAvatarTalking(false);
      });
    }
  }, [sessionRef]);

  return { isUserTalking, isAvatarTalking };
};

// const useChatHistoryState = (
//   sessionRef: React.RefObject<LiveAvatarSession>
// ) => {
//   const [messages, setMessages] = useState<LiveAvatarSessionMessage[]>([]);
//   const currentSenderRef = useRef<MessageSender | null>(null);

//   // useEffect(() => {
//   //   if (sessionRef.current) {
//   //     const handleMessage = (
//   //       sender: MessageSender,
//   //       { task_id, message }: { task_id: string; message: string }
//   //     ) => {
//   //       if (currentSenderRef.current === sender) {
//   //         setMessages((prev) => [
//   //           ...prev.slice(0, -1),
//   //           {
//   //             ...prev[prev.length - 1]!,
//   //             message: [prev[prev.length - 1]!.message, message].join(""),
//   //           },
//   //         ]);
//   //       } else {
//   //         currentSenderRef.current = sender;
//   //         setMessages((prev) => [
//   //           ...prev,
//   //           {
//   //             id: task_id,
//   //             sender: sender,
//   //             message,
//   //             timestamp: Date.now(),
//   //           },
//   //         ]);
//   //       }
//   //     };

//   //     sessionRef.current.on(
//   //       AgentEventsEnum.USER_SPEAK_STARTED,
//   //       (data) => console.log("USER_SPEAK_STARTED", data)
//   //       handleMessage(MessageSender.USER, {
//   //   task_id: data.,
//   //   message: data.text || "",
//   // })
//   //     );
//   //   }
//   // }, [sessionRef]);

//   return { messages };
// };

export const LiveAvatarContextProvider = ({
  children,
  sessionAccessToken,
}: LiveAvatarContextProviderProps) => {
  // Use same-origin proxy so session start/stop/keep-alive go through our API
  // and avoid 403/CORS when calling LiveAvatar from the browser.
  const apiUrl =
    typeof window !== "undefined" ? `${window.location.origin}/api` : "";
  // voiceChat: false defers mic permission prompt until user hits Start button.
  // When user hits Start, handleVoiceStartStop calls voiceChat.start() which will
  // then prompt for mic permission — that's the user-initiated moment G wants.
  // (Changed 2026-04-24 to fix "mic permission prompt on page load" bug.)
  const config = {
    voiceChat: false,
    apiUrl,
  };
  const sessionRef = useRef<LiveAvatarSession>(
    new LiveAvatarSession(sessionAccessToken, config),
  );

  const { sessionState, isStreamReady, connectionQuality } =
    useSessionState(sessionRef);

  const { isMuted, voiceChatState, microphoneWarning } =
    useVoiceChatState(sessionRef);
  const { isUserTalking, isAvatarTalking } = useTalkingState(sessionRef);
  // M3.0c — persist every finalized USER + AVATAR utterance to Supabase.
  useTranscriptCapture(sessionRef);
  // const { messages } = useChatHistoryState(sessionRef);

  const lastActivityAtRef = useRef(0);
  const stoppedDueToInactivityRef = useRef(false);
  const reengagementTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const reengagementAttemptsRef = useRef(0);
  const hasUserSpokenSinceAvatarTurnRef = useRef(true);
  const isUserSpeakingRef = useRef(false);
  const isAvatarSpeakingRef = useRef(false);
  const reportActivity = useCallback(() => {
    lastActivityAtRef.current = Date.now();
  }, []);
  const wasStoppedDueToInactivity = useCallback(() => {
    const v = stoppedDueToInactivityRef.current;
    stoppedDueToInactivityRef.current = false;
    return v;
  }, []);

  // Update last activity on any user or avatar speech
  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    const onActivity = () => {
      lastActivityAtRef.current = Date.now();
    };
    session.on(AgentEventsEnum.USER_SPEAK_STARTED, onActivity);
    session.on(AgentEventsEnum.USER_SPEAK_ENDED, onActivity);
    session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, onActivity);
    session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, onActivity);
    return () => {
      session.off(AgentEventsEnum.USER_SPEAK_STARTED, onActivity);
      session.off(AgentEventsEnum.USER_SPEAK_ENDED, onActivity);
      session.off(AgentEventsEnum.AVATAR_SPEAK_STARTED, onActivity);
      session.off(AgentEventsEnum.AVATAR_SPEAK_ENDED, onActivity);
    };
  }, [sessionRef]);

  // Conversational silence re-engagement:
  // - after avatar turn ends, wait 10s for user reply
  // - if still silent, 15s for second attempt
  // - then stop entirely (no third attempt ever — hard cap)
  // - matches the CW's explicit 10s/15s/no-third rule
  useEffect(() => {
    const session = sessionRef.current;
    if (!session || sessionState !== SessionState.CONNECTED) {
      return;
    }

    const clearReengagementTimeout = () => {
      if (reengagementTimeoutRef.current) {
        clearTimeout(reengagementTimeoutRef.current);
        reengagementTimeoutRef.current = null;
      }
    };

    const scheduleReengagement = () => {
      clearReengagementTimeout();
      if (reengagementAttemptsRef.current >= 2) {
        return;
      }
      const delaySeconds = reengagementAttemptsRef.current === 0 ? 10 : 15;
      const delayMs = delaySeconds * 1000;

      reengagementTimeoutRef.current = setTimeout(() => {
        // If user/agent is currently speaking or user already replied, skip this attempt.
        if (
          hasUserSpokenSinceAvatarTurnRef.current ||
          isUserSpeakingRef.current ||
          isAvatarSpeakingRef.current
        ) {
          return;
        }
        if (sessionRef.current?.state !== SessionState.CONNECTED) {
          return;
        }
        // Don't inject silence signals while a video is being recorded or
        // analyzed — user is busy with the capture and 6 should stay quiet.
        if (isVideoBusy()) {
          return;
        }
        const signal = `[USER HAS BEEN SILENT FOR ${delaySeconds} SECONDS]`;
        sessionRef.current.message(signal);
        reengagementAttemptsRef.current += 1;
      }, delayMs);
    };

    const onUserSpeakStarted = () => {
      isUserSpeakingRef.current = true;
      hasUserSpokenSinceAvatarTurnRef.current = true;
      // Intentionally DO NOT reset reengagementAttemptsRef here. The CW
      // specifies max 2 silence re-engages PER CONVERSATION, not per gap.
      // Resetting on every user utterance was making the 4s/6s signal fire
      // repeatedly through the session (observed 2026-04-23).
      clearReengagementTimeout();
    };

    const onUserSpeakEnded = () => {
      isUserSpeakingRef.current = false;
    };

    const onAvatarSpeakStarted = () => {
      isAvatarSpeakingRef.current = true;
      clearReengagementTimeout();
    };

    const onAvatarSpeakEnded = () => {
      isAvatarSpeakingRef.current = false;
      hasUserSpokenSinceAvatarTurnRef.current = false;
      scheduleReengagement();
    };

    session.on(AgentEventsEnum.USER_SPEAK_STARTED, onUserSpeakStarted);
    session.on(AgentEventsEnum.USER_SPEAK_ENDED, onUserSpeakEnded);
    session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, onAvatarSpeakStarted);
    session.on(AgentEventsEnum.AVATAR_SPEAK_ENDED, onAvatarSpeakEnded);

    return () => {
      clearReengagementTimeout();
      session.off(AgentEventsEnum.USER_SPEAK_STARTED, onUserSpeakStarted);
      session.off(AgentEventsEnum.USER_SPEAK_ENDED, onUserSpeakEnded);
      session.off(AgentEventsEnum.AVATAR_SPEAK_STARTED, onAvatarSpeakStarted);
      session.off(AgentEventsEnum.AVATAR_SPEAK_ENDED, onAvatarSpeakEnded);
    };
  }, [sessionState, sessionRef]);

  // Terminate session after 3 minutes of no activity (was 1 minute — too
  // aggressive, was timing out active sessions where user paused to look at
  // something. Extended 2026-04-24 after G reported session timeouts mid-convo).
  const INACTIVITY_TIMEOUT_MS = 180 * 1000;
  const INACTIVITY_CHECK_MS = 15 * 1000;
  useEffect(() => {
    if (sessionState !== SessionState.CONNECTED) return;
    lastActivityAtRef.current = Date.now();
    const intervalId = setInterval(() => {
      if (Date.now() - lastActivityAtRef.current >= INACTIVITY_TIMEOUT_MS) {
        stoppedDueToInactivityRef.current = true;
        sessionRef.current?.stop?.();
      }
    }, INACTIVITY_CHECK_MS);
    return () => clearInterval(intervalId);
  }, [sessionState]);

  return (
    <LiveAvatarContext.Provider
      value={{
        sessionRef,
        sessionState,
        isStreamReady,
        connectionQuality,
        isMuted,
        voiceChatState,
        isUserTalking,
        isAvatarTalking,
        messages: [], // TODO - properly implement chat history
        microphoneWarning,
        reportActivity,
        wasStoppedDueToInactivity,
      }}
    >
      {children}
    </LiveAvatarContext.Provider>
  );
};

export const useLiveAvatarContext = () => {
  return useContext(LiveAvatarContext);
};
