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
        | "recurring"
        | null;
      contractorIds: string[];
      deliberation?: {
        category: string;
        constraints: Record<string, unknown>;
      };
    } => {
      const variant = useAssistantSurface.getState().variant;
      if (!variant) return { kind: null, contractorIds: [] };
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
        case "recurring":
          // Recurring job panel — no contractor ID surfacing in v1
          // (the user already selected the contractor before the
          // recurring intent fired).
          return { kind: "recurring", contractorIds: [] };
      }
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
        if (!res.ok) return;
        const data = (await res.json()) as {
          id?: string;
          orchestrator?: {
            kind: "action" | "none";
            variant?: SurfaceVariant;
            contextMessage?: string;
            reason?: string;
          };
        };
        const orch = data.orchestrator;
        if (orch?.kind === "action") {
          if (orch.variant) applyVariant(orch.variant);
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
      }
    };
    const onAvatarTranscription = (event: { text: string }) => {
      if (typeof event?.text === "string") {
        avatarTurnRef.current = event.text;
      }
    };
    const onUserSpeakEnded = () => {
      const text = userTurnRef.current;
      userTurnRef.current = "";
      if (text) void flushUser(text);
    };
    const onAvatarSpeakStarted = () => {
      isAvatarSpeakingRef.current = true;
    };
    const onAvatarSpeakEnded = () => {
      isAvatarSpeakingRef.current = false;
      const text = avatarTurnRef.current;
      avatarTurnRef.current = "";
      if (text) void flushAvatar(text);
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

    return () => {
      session.off(AgentEventsEnum.USER_TRANSCRIPTION, onUserTranscription);
      session.off(AgentEventsEnum.AVATAR_TRANSCRIPTION, onAvatarTranscription);
      session.off(AgentEventsEnum.USER_SPEAK_ENDED, onUserSpeakEnded);
      session.off(AgentEventsEnum.AVATAR_SPEAK_STARTED, onAvatarSpeakStarted);
      session.off(AgentEventsEnum.AVATAR_SPEAK_ENDED, onAvatarSpeakEnded);
    };
  }, [sessionRef]);
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
