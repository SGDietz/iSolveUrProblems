"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import {
  LiveAvatarContextProvider,
  useSession,
  useTextChat,
  useVoiceChat,
  useLiveAvatarContext,
} from "../liveavatar";
import Link from "next/link";
import { SessionState, AgentEventsEnum } from "@heygen/liveavatar-web-sdk";
import { useAvatarActions } from "../liveavatar/useAvatarActions";
import { setVideoBusy, isVideoBusy } from "../liveavatar/videoRecordingState";
import { captureMedia } from "../lib/captureMedia";
import { Radio, Camera, Images, Video, Play, Square, MicOff } from "lucide-react";

export type SessionStoppedReason = { reason?: "inactivity" };

const VOICE_START_GREETING =
  "Hi, I'm 6, your ai buddy. You know why they call me 6? 'Cuz I got your back. So, what problems can I help you solve today?";

const LiveAvatarSessionComponent: React.FC<{
  mode: "FULL" | "CUSTOM";
  onSessionStopped: (opts?: SessionStoppedReason) => void;
  onExit?: (completeExit?: boolean) => void;
}> = ({ mode, onSessionStopped, onExit }) => {
  const [message, setMessage] = useState("");
  const {
    sessionState,
    isStreamReady,
    startSession,
    stopSession,
    connectionQuality,
    keepAlive,
    attachElement,
  } = useSession();
  const { microphoneWarning, wasStoppedDueToInactivity } =
    useLiveAvatarContext();
  const {
    isAvatarTalking,
    isUserTalking,
    isMuted,
    isActive,
    isLoading,
    start,
    stop,
    mute,
    unmute,
  } = useVoiceChat();

  const { interrupt, repeat, startListening, stopListening } =
    useAvatarActions(mode);

  const { sendMessage } = useTextChat(mode);
  const { sessionRef } = useLiveAvatarContext();
  const videoRef = useRef<HTMLVideoElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraPreviewRef = useRef<HTMLVideoElement>(null);
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [imageAnalysis, setImageAnalysis] = useState<string | null>(null);
  const [videoAnalysis, setVideoAnalysis] = useState<string | null>(null);
  const [isAnalyzingImage, setIsAnalyzingImage] = useState(false);
  const [isAnalyzingVideo, setIsAnalyzingVideo] = useState(false);
  const [isProcessingCameraQuestion, setIsProcessingCameraQuestion] =
    useState(false);
  const [showVisionLoading, setShowVisionLoading] = useState(false);
  const [cameraAvailable, setCameraAvailable] = useState<boolean | null>(null);
  // Mic permission UX (added 2026-04-25 per G — let the OS dialog fire
  // directly on Start (one-click experience), but show a clean recovery
  // screen if permission has been denied. Pre-prompt explainer reverted —
  // tap-twice was unwanted friction.)
  type MicPermState = "unknown" | "granted" | "prompt" | "denied";
  const [micPermState, setMicPermState] = useState<MicPermState>("unknown");
  const [micDeniedOpen, setMicDeniedOpen] = useState(false);
  const [fallbackImage, setFallbackImage] = useState<File | null>(null);
  const [fallbackImagePreview, setFallbackImagePreview] = useState<
    string | null
  >(null);
  const lastProcessedQuestionRef = useRef<string>("");
  const processingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const fallbackImageInputRef = useRef<HTMLInputElement>(null);
  const isDebugProcessingRef = useRef<boolean>(false);
  const lastAvatarResponseRef = useRef<string>("");
  const lastVisionResponseTimeRef = useRef<number>(0);
  // Tracks the last time we actually injected a VISION observation into the
  // TALK brain context. If the scene is genuinely unchanged but the last
  // inject was >25s ago, we re-inject so the TALK brain stays grounded on
  // the current state instead of losing the thread. (Added 2026-04-24 after
  // 6 said "I don't see anything" while Gemini had been reporting the
  // lampshade for 70+ seconds but every frame was deduped.)
  const lastVisionInjectTimeRef = useRef<number>(0);
  const VISION_REINJECT_STALE_MS = 25_000;
  // Synchronous mirror of (isCameraActive && visionMode === "streaming"). State
  // props are stale inside in-flight callbacks due to closure capture; this
  // ref lets Stop immediately halt pending speech. (Added 2026-04-24 after
  // fillers fired after the user hit the main Stop button.)
  const goLiveActiveRef = useRef<boolean>(false);
  // Rotating "Hang tight" / "I'm watching" filler was REMOVED 2026-04-25 after
  // smoke test showed those lines polluting conversation_messages and the TALK
  // brain hallucinating contradictions. Loading overlay + proactive narration
  // (state-change speech) cover the "avatar isn't frozen" need without
  // dirtying transcript context. Don't re-add without a way to keep them out
  // of the LiveAvatar transcript.
  // Debounces the "Oops!" error message so a string of failed vision calls
  // doesn't make the avatar say "Oops" 4+ times in 15 seconds (observed bug).
  const lastOopsTimeRef = useRef<number>(0);
  // Debounces OBJECT_NOT_VISIBLE reframe asks. Gemini often returns the same
  // reframe on 10+ consecutive frames — without this, 6 repeats "Can you make
  // sure the camera is pointing..." every 1.5s for the whole session.
  const lastReframeTimeRef = useRef<number>(0);
  const hasAutoAnalyzedRef = useRef<boolean>(false);
  // Tracks the specific problem the user is trying to fix (persists across vision calls so
  // Gemini can stay laser-focused on the object/problem the user named at the start).
  const currentProblemRef = useRef<string>("");
  // Timestamp when currentProblemRef was first set. We accumulate user text for
  // the first 20 seconds (so "I got some issues with scratches" + "on my sunglasses"
  // both end up in the problem) then lock — prevents later questions from
  // polluting the problem statement.
  const problemFirstSetAtRef = useRef<number>(0);
  // Tracks the last non-silent vision analysis so Grok can compare frames and only break
  // silence when something meaningful has actually changed.
  const lastAnalysisRef = useRef<string>("");

  const isAttachedRef = useRef<boolean>(false);
  const greetingTriggeredRef = useRef<boolean>(false);
  const audioUnlockedRef = useRef<boolean>(false);
  const wasMutedBeforeRecordingRef = useRef<boolean>(false);
  /** LiveAvatar server session id — used for DB + official transcript API (set when CONNECTED). */
  const dbSessionIdRef = useRef<string | null>(null);
  /** Cursor for GET /v1/sessions/{id}/transcript (LiveAvatar `next_timestamp`). */
  const transcriptCursorRef = useRef<number | null>(null);
  const lastSyncedLaSessionIdRef = useRef<string | null>(null);
  /** Mic/voice chat is held inactive until the user taps Start (SDK enables voice on connect). */
  const voiceHeldUntilUserStartRef = useRef(false);
  const [hasUserPressedVoiceStart, setHasUserPressedVoiceStart] = useState(false);
  const [voiceStartAwaitingReady, setVoiceStartAwaitingReady] = useState(false);

  // Vision mode state: 'streaming' for Go Live, 'snapshot' for Camera button, null for inactive
  const [visionMode, setVisionMode] = useState<"streaming" | "snapshot" | null>(
    null,
  );

  const [isRecording, setIsRecording] = useState(false);
  const [recordedVideoBlob, setRecordedVideoBlob] = useState<Blob | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);

  // When session fails to start (e.g. no credits), show message and don't auto-restart
  const [sessionStartError, setSessionStartError] = useState<string | null>(
    null,
  );
  const sessionStartErrorRef = useRef<string | null>(null);

  useEffect(() => {
    if (sessionState === SessionState.DISCONNECTED) {
      if (sessionStartErrorRef.current) {
        setSessionStartError(sessionStartErrorRef.current);
        sessionStartErrorRef.current = null;
        greetingTriggeredRef.current = false;
        return;
      }
      const opts: SessionStoppedReason | undefined = wasStoppedDueToInactivity()
        ? { reason: "inactivity" }
        : undefined;
      onSessionStopped(opts);
      // Reset greeting trigger when session disconnects
      greetingTriggeredRef.current = false;
    }
  }, [sessionState, onSessionStopped, wasStoppedDueToInactivity]);

  useEffect(() => {
    if (sessionState === SessionState.INACTIVE) {
      setSessionStartError(null);
      startSession().catch((err: Error) => {
        const message = err?.message ?? "Session start failed";
        sessionStartErrorRef.current = message;
      });
    }
  }, [startSession, sessionState]);

  // Track LiveAvatar session id for lead capture + official transcript sync
  useEffect(() => {
    if (sessionState === SessionState.DISCONNECTED) {
      const sid = dbSessionIdRef.current;
      const cursor = transcriptCursorRef.current;
      dbSessionIdRef.current = null;
      transcriptCursorRef.current = null;
      lastSyncedLaSessionIdRef.current = null;
      if (sid) {
        void fetch("/api/liveavatar/session-transcript/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            liveAvatarSessionId: sid,
            ...(cursor != null ? { startTimestamp: cursor } : {}),
          }),
          keepalive: true,
        }).catch(() => {});
      }
      return;
    }
    if (sessionState === SessionState.CONNECTED && sessionRef.current?.sessionId) {
      const sid = sessionRef.current.sessionId;
      if (lastSyncedLaSessionIdRef.current !== sid) {
        transcriptCursorRef.current = null;
        lastSyncedLaSessionIdRef.current = sid;
      }
      dbSessionIdRef.current = sid;
    }
  }, [sessionState, sessionRef]);

  // Poll LiveAvatar official transcript API while connected ([Get Session Transcript](https://docs.liveavatar.com/api-reference/sessions/get-session-transcript))
  useEffect(() => {
    if (sessionState !== SessionState.CONNECTED) return;
    const sid = sessionRef.current?.sessionId;
    if (!sid) return;

    const runSync = async () => {
      const body: Record<string, unknown> = { liveAvatarSessionId: sid };
      if (transcriptCursorRef.current != null) {
        body.startTimestamp = transcriptCursorRef.current;
      }
      try {
        const res = await fetch("/api/liveavatar/session-transcript/sync", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (typeof data.nextTimestamp === "number") {
          transcriptCursorRef.current = data.nextTimestamp;
        }
      } catch (e) {
        console.error("LiveAvatar transcript sync failed:", e);
      }
    };

    void runSync();
    const intervalMs = 20_000;
    const id = setInterval(runSync, intervalMs);
    return () => clearInterval(id);
  }, [sessionState, sessionRef]);

  // Function to reset to home screen (close camera, clear uploads, but keep session)
  // Keep goLiveActiveRef in sync with Go Live state so in-flight async work
  // sees the current value synchronously (closures over state are stale).
  useEffect(() => {
    goLiveActiveRef.current =
      isCameraActive && visionMode === "streaming";
  }, [isCameraActive, visionMode]);

  const resetToHomeScreen = useCallback(() => {
    // Immediately halt in-flight Go Live speech/filler work.
    goLiveActiveRef.current = false;

    // Close camera if active
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      setCameraStream(null);
    }
    setIsCameraActive(false);
    setVisionMode(null);

    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
    setRecordedVideoBlob(null);
    recordedChunksRef.current = [];

    // Clean up preview URL if it's not the default fallback image
    if (
      fallbackImagePreview &&
      fallbackImage &&
      fallbackImage.name !== "2c44c052-e58a-4f6d-a6c8-dba901ff0e9e.jpg"
    ) {
      URL.revokeObjectURL(fallbackImagePreview);
    }
    setFallbackImage(null);
    setFallbackImagePreview(null);

    // Clear analysis states (but keep videoAnalysis so avatar can still reference it)
    setImageAnalysis(null);
    setIsAnalyzingImage(false);
    setIsAnalyzingVideo(false);
    setIsProcessingCameraQuestion(false);
    // Note: videoAnalysis is NOT cleared so avatar can still reference uploaded videos

    // Reset processing refs
    lastProcessedQuestionRef.current = "";
    hasAutoAnalyzedRef.current = false;
    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
      processingTimeoutRef.current = null;
    }
  }, [
    cameraStream,
    fallbackImage,
    fallbackImagePreview,
    isRecording,
  ]);

  // Check if we're on the home screen (no camera, no video, no uploads)
  const isOnHomeScreen = useCallback(() => {
    return (
      !isCameraActive &&
      !imageAnalysis &&
      !isAnalyzingImage &&
      !isAnalyzingVideo
    );
  }, [isCameraActive, imageAnalysis, isAnalyzingImage, isAnalyzingVideo]);

  // Wrapper for stopSession - on home screen stop session (parent shows start screen); otherwise reset to home screen
  const handleStopSession = useCallback(() => {
    if (isOnHomeScreen()) {
      // On home screen: stop session so parent can show start screen (Talk to iScott)
      greetingTriggeredRef.current = false; // Reset greeting trigger
      stopSession();
    } else {
      // Not on home screen: reset to home screen (keep session)
      resetToHomeScreen();
    }
  }, [isOnHomeScreen, resetToHomeScreen, stopSession]);

  // SDK starts voice chat on connect; hold mic inactive until the user taps Start.
  useEffect(() => {
    if (sessionState === SessionState.DISCONNECTED) {
      voiceHeldUntilUserStartRef.current = false;
      return;
    }
    if (sessionState !== SessionState.CONNECTED || !isStreamReady) {
      return;
    }
    if (voiceHeldUntilUserStartRef.current) {
      return;
    }
    voiceHeldUntilUserStartRef.current = true;
    stop();
  }, [sessionState, isStreamReady, stop]);

  // No avatar speech without audible output: interrupt if the agent starts speaking before audio is unlocked.
  useEffect(() => {
    const session = sessionRef.current;
    if (!session) {
      return;
    }
    const onAvatarSpeakStarted = () => {
      if (!audioUnlockedRef.current) {
        void interrupt();
      }
      // Mark that the avatar just started speaking so Go Live filler knows
      // not to fire on top. Without this, filler tracked only OUR repeat()
      // calls and ignored the TALK brain's own responses — leading to
      // "talky talky" overlap where filler fired 3s after a TALK response.
      lastVisionResponseTimeRef.current = Date.now();
    };
    session.on(AgentEventsEnum.AVATAR_SPEAK_STARTED, onAvatarSpeakStarted);
    return () => {
      session.removeListener(
        AgentEventsEnum.AVATAR_SPEAK_STARTED,
        onAvatarSpeakStarted,
      );
    };
  }, [sessionRef, interrupt]);

  /** Ensure remote avatar audio can play (mobile autoplay policies). Call from explicit button taps only. */
  const ensureAudioOutputReady = useCallback(async (): Promise<boolean> => {
    if (!videoRef.current || !isStreamReady) {
      return false;
    }
    const video = videoRef.current;
    try {
      video.volume = 1.0;
      video.muted = false;
      if (video.srcObject && video.srcObject instanceof MediaStream) {
        video.srcObject.getAudioTracks().forEach((track) => {
          track.enabled = true;
        });
      }
      await video.play();
      audioUnlockedRef.current = true;
      setTimeout(() => {
        if (videoRef.current) {
          videoRef.current.volume = 1.0;
          videoRef.current.muted = false;
          videoRef.current.play().catch(() => {});
        }
      }, 100);
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
          requestAnimationFrame(done);
          return;
        }
        video.addEventListener("canplay", done, { once: true });
        setTimeout(done, 2500);
      });
      return true;
    } catch (error) {
      console.warn("Audio output not ready:", error);
      return false;
    }
  }, [isStreamReady]);

  /** Idempotent unlock for Go Live / Camera / Gallery (after user gesture). */
  const unlockAudio = useCallback(async () => {
    if (audioUnlockedRef.current) {
      return;
    }
    await ensureAudioOutputReady();
  }, [ensureAudioOutputReady]);

  const handleVoiceStartStop = useCallback(async () => {
    if (isActive) {
      void interrupt();
      stop();
      setHasUserPressedVoiceStart(false);
      if (mode === "FULL") {
        stopListening();
      }
      return;
    }
    if (sessionState !== SessionState.CONNECTED || !isStreamReady) {
      return;
    }
    setVoiceStartAwaitingReady(true);
    try {
      const ok = await ensureAudioOutputReady();
      if (!ok) {
        return;
      }
      await start();
      await repeat(VOICE_START_GREETING);
      if (mode === "FULL") {
        startListening();
      }
      setHasUserPressedVoiceStart(true);
    } finally {
      setVoiceStartAwaitingReady(false);
    }
  }, [
    isActive,
    interrupt,
    repeat,
    stop,
    start,
    mode,
    startListening,
    stopListening,
    sessionState,
    isStreamReady,
    ensureAudioOutputReady,
  ]);

  // Probe mic permission state on mount + listen for changes. Falls back to
  // "prompt" if the browser doesn't expose Permissions API for microphone
  // (some older Android variants).
  useEffect(() => {
    if (typeof navigator === "undefined" || !navigator.permissions) {
      setMicPermState("prompt");
      return;
    }
    let cancelled = false;
    let status: PermissionStatus | null = null;
    const onChange = () => {
      if (!cancelled && status) {
        setMicPermState(status.state as MicPermState);
        if (status.state === "denied") setMicDeniedOpen(true);
      }
    };
    navigator.permissions
      .query({ name: "microphone" as PermissionName })
      .then((p) => {
        if (cancelled) return;
        status = p;
        setMicPermState(p.state as MicPermState);
        p.addEventListener("change", onChange);
      })
      .catch(() => {
        if (!cancelled) setMicPermState("prompt");
      });
    return () => {
      cancelled = true;
      if (status) status.removeEventListener("change", onChange);
    };
  }, []);

  const handleMicDeniedRetry = useCallback(async () => {
    // Re-attempt — if the user enabled mic in browser settings, this will
    // succeed silently. If still blocked, getUserMedia will reject again.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      setMicPermState("granted");
      setMicDeniedOpen(false);
      await handleVoiceStartStop();
    } catch {
      // stays open — user still hasn't enabled it
    }
  }, [handleVoiceStartStop]);

  useEffect(() => {
    if (isStreamReady && videoRef.current) {
      const video = videoRef.current;
      // Muted autoplay is allowed without user gesture - avatar displays automatically
      video.muted = true;
      video.volume = 0;

      attachElement(videoRef.current);

      // Start playback immediately so avatar displays without user click/touch
      video.play().catch((err) => {
        console.warn("Autoplay (muted) failed:", err);
      });

      // If user already unlocked audio earlier (e.g. re-attach), restore sound
      if (audioUnlockedRef.current) {
        void ensureAudioOutputReady();
      }
    }
  }, [attachElement, isStreamReady, ensureAudioOutputReady]);

  // Ensure video has volume and is not muted whenever video element is available
  // Only unmute after user interaction (audio unlock) - CRITICAL to prevent mouth movement during loading
  useEffect(() => {
    if (videoRef.current && isStreamReady && audioUnlockedRef.current) {
      const video = videoRef.current;
      video.volume = 1.0;
      video.muted = false;
      // Also ensure audio tracks are enabled if available
      if (video.srcObject && video.srcObject instanceof MediaStream) {
        video.srcObject.getAudioTracks().forEach((track) => {
          track.enabled = true;
        });
      }
    } else if (videoRef.current && isStreamReady && !audioUnlockedRef.current) {
      // Ensure video stays muted if audio is not unlocked yet
      const video = videoRef.current;
      video.muted = true;
      video.volume = 0;
    }
  }, [isStreamReady, audioUnlockedRef]);

  // DISABLED: Function to trigger greeting - removed to prevent automatic "Hi" on load
  // Greeting should only happen on explicit user action, not automatically
  const triggerGreetingIfNeeded = useCallback(() => {
    // Do nothing - greeting disabled to prevent mouth movement during loading
  }, []);

  // Function to load fallback image from public folder
  const loadFallbackImage = useCallback(async (): Promise<File> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";

      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          reject(new Error("Failed to get canvas context"));
          return;
        }
        ctx.drawImage(img, 0, 0);
        canvas.toBlob(
          (blob) => {
            if (blob) {
              const file = new File(
                [blob],
                "2c44c052-e58a-4f6d-a6c8-dba901ff0e9e.jpg",
                { type: "image/jpeg" },
              );
              resolve(file);
            } else {
              reject(new Error("Failed to convert canvas to blob"));
            }
          },
          "image/jpeg",
          0.95,
        );
      };

      img.onerror = () => {
        reject(new Error("Failed to load fallback image from public folder"));
      };

      // Load image from public folder
      img.src = "/2c44c052-e58a-4f6d-a6c8-dba901ff0e9e.jpg";
    });
  }, []);

  // Handle Go Live button - enable real-time streaming vision mode (verbal questions)
  const handleGoLive = useCallback(async () => {
    // If already in streaming vision mode, return
    if (visionMode === "streaming") {
      return;
    }

    // Activate streaming Vision mode
    setVisionMode("streaming");

    // If camera is not available, show fallback mode with default image
    if (cameraAvailable === false) {
      setIsCameraActive(true);
      // If fallback image is not already set, load it
      if (!fallbackImage) {
        loadFallbackImage()
          .then((file) => {
            setFallbackImage(file);
            const previewUrl = URL.createObjectURL(file);
            setFallbackImagePreview(previewUrl);
          })
          .catch((error) => {
            console.error("Error loading fallback image:", error);
          });
      }
      return;
    }

    try {
      // First try to get rear camera (environment)
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        setCameraAvailable(true);
      } catch (error) {
        // If rear camera fails, try front camera (user)
        console.log("Rear camera not available, trying front camera");
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "user" },
          });
          setCameraAvailable(true);
        } catch (error2) {
          // No camera available, use fallback mode with default image
          console.log("No camera available, using fallback mode");
          setCameraAvailable(false);
          setIsCameraActive(true);
          // If fallback image is not already set, load it
          if (!fallbackImage) {
            loadFallbackImage()
              .then((file) => {
                setFallbackImage(file);
                const previewUrl = URL.createObjectURL(file);
                setFallbackImagePreview(previewUrl);
              })
              .catch((error) => {
                console.error("Error loading fallback image:", error);
              });
          }
          return;
        }
      }

      if (stream) {
        setCameraStream(stream);
        setIsCameraActive(true);
      }
    } catch (error) {
      console.error("Error accessing camera:", error);
      // Use fallback mode instead of showing error
      setCameraAvailable(false);
      setIsCameraActive(true);
      if (!fallbackImage) {
        loadFallbackImage()
          .then((file) => {
            setFallbackImage(file);
            const previewUrl = URL.createObjectURL(file);
            setFallbackImagePreview(previewUrl);
          })
          .catch((error) => {
            console.error("Error loading fallback image:", error);
          });
      }
    }

    // Inject a state signal into the TALK conversation so the avatar's LLM
    // knows vision is now on. Prevents the "6 doesn't know Go Live state" bug
    // where users said "I hit Go Live" but 6 kept asking them to pick a button.
    //
    // Then FORCE-SPEAK a short opener via repeat() so 6 engages immediately.
    // message() alone was unreliable — users saw 30+ seconds of silence after
    // Go Live activated (observed 2026-04-24). repeat() guarantees audible
    // engagement. The opener is templated on whether a problem was already
    // stated so it lands appropriately.
    try {
      if (mode === "FULL" && sessionRef.current) {
        sessionRef.current.message(
          "[GO LIVE IS NOW ACTIVE — the camera feed is live and vision reports are coming in]",
        );
        const hasProblem = !!currentProblemRef.current;
        const opener = hasProblem
          ? "OK — I can see you now. Show me where you're stuck."
          : "Camera's live — show me what we're looking at.";
        // Small delay so the state signal is registered before we force speech.
        setTimeout(() => {
          try {
            sessionRef.current?.repeat(opener);
            lastVisionResponseTimeRef.current = Date.now();
          } catch (err) {
            console.error("Error speaking Go Live opener:", err);
          }
        }, 300);
      }
    } catch (signalError) {
      console.error("Error injecting Go Live ON signal:", signalError);
    }
  }, [
    triggerGreetingIfNeeded,
    visionMode,
    cameraAvailable,
    fallbackImage,
    loadFallbackImage,
    mode,
    sessionRef,
  ]);

  // Allow the initial greeting (intro line) from the backend to play when session is fully loaded
  // No interception - when the avatar starts speaking the intro, let it play

  // Cleanup camera stream on unmount
  useEffect(() => {
    return () => {
      if (cameraStream) {
        cameraStream.getTracks().forEach((track) => track.stop());
      }
      if (processingTimeoutRef.current) {
        clearTimeout(processingTimeoutRef.current);
      }
    };
  }, [cameraStream]);

  // Set camera stream to video element when both are available
  useEffect(() => {
    if (cameraStream && cameraPreviewRef.current) {
      const video = cameraPreviewRef.current;
      video.srcObject = cameraStream;

      // Ensure video plays
      video.play().catch((error) => {
        console.error("Error playing camera video:", error);
      });

      // Log when video is ready
      const onLoadedMetadata = () => {
        console.log("Camera video metadata loaded:", {
          width: video.videoWidth,
          height: video.videoHeight,
          readyState: video.readyState,
        });
      };

      video.addEventListener("loadedmetadata", onLoadedMetadata);

      return () => {
        video.removeEventListener("loadedmetadata", onLoadedMetadata);
      };
    }
  }, [cameraStream, isCameraActive]);

  // Function to capture frame from camera video or use fallback image
  const captureCameraFrame = useCallback(async (): Promise<File | null> => {
    if (!isCameraActive) {
      return null;
    }

    // If using fallback image, return it directly
    if (fallbackImage) {
      console.log("Using fallback image:", fallbackImage.name);
      return fallbackImage;
    }

    // Otherwise, try to capture from camera
    if (!cameraPreviewRef.current) {
      console.error("Camera preview ref not available");
      return null;
    }

    try {
      const video = cameraPreviewRef.current;

      // Wait for video to be ready with valid dimensions
      if (video.readyState < 2) {
        // Video not ready, wait for loadedmetadata
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error("Video metadata loading timeout"));
          }, 3000);

          const onLoadedMetadata = () => {
            clearTimeout(timeout);
            video.removeEventListener("loadedmetadata", onLoadedMetadata);
            resolve();
          };

          video.addEventListener("loadedmetadata", onLoadedMetadata);

          // If already loaded, resolve immediately
          if (video.readyState >= 2) {
            clearTimeout(timeout);
            video.removeEventListener("loadedmetadata", onLoadedMetadata);
            resolve();
          }
        });
      }

      // Check if video has valid dimensions
      if (video.videoWidth === 0 || video.videoHeight === 0) {
        console.error(
          "Video has invalid dimensions:",
          video.videoWidth,
          video.videoHeight,
        );
        return null;
      }

      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        console.error("Failed to get canvas context");
        return null;
      }

      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      return new Promise((resolve) => {
        canvas.toBlob(
          (blob) => {
            if (blob) {
              const file = new File([blob], "camera-frame.jpg", {
                type: "image/jpeg",
              });
              console.log("Camera frame captured successfully:", {
                width: canvas.width,
                height: canvas.height,
                fileSize: file.size,
              });
              resolve(file);
            } else {
              console.error("Failed to convert canvas to blob");
              resolve(null);
            }
          },
          "image/jpeg",
          0.95,
        );
      });
    } catch (error) {
      console.error("Error capturing camera frame:", error);
      return null;
    }
  }, [isCameraActive, fallbackImage]);

  // Function to capture photo and analyze it (only for snapshot mode)
  const handleSnapPhoto = useCallback(async () => {
    if (!isCameraActive || visionMode !== "snapshot") {
      return;
    }
    // Silence 6 the moment the shutter fires.
    try {
      sessionRef.current?.interrupt?.();
    } catch {
      // non-fatal
    }

    // Hoisted so the catch block can also store the frame for failure audit.
    let frameFile: File | null = null;
    try {
      setIsAnalyzingImage(true);
      // Show "Analyzing" immediately (not "Loading")
      setIsProcessingCameraQuestion(true);

      // Capture frame from camera or use fallback image
      frameFile = await captureCameraFrame();

      if (!frameFile) {
        console.error("Failed to capture camera frame");
        setIsAnalyzingImage(false);
        return;
      }

      // Close camera preview and return to full avatar display
      if (cameraStream) {
        cameraStream.getTracks().forEach((track) => track.stop());
        setCameraStream(null);
      }
      setIsCameraActive(false);
      setVisionMode(null);

      // Clean up preview URL if it's not the default fallback image
      if (
        fallbackImagePreview &&
        fallbackImage &&
        fallbackImage.name !== "2c44c052-e58a-4f6d-a6c8-dba901ff0e9e.jpg"
      ) {
        URL.revokeObjectURL(fallbackImagePreview);
      }
      setFallbackImage(null);
      setFallbackImagePreview(null);

      // Analyze the photo (with one retry on transient failures — Vercel cold
      // starts can make the first invocation fail, and the second succeeds).
      // Bind to a local const so the closure sees a non-null type.
      const frame = frameFile;
      const buildForm = () => {
        const fd = new FormData();
        fd.append(
          "image",
          frame,
          frame.name || "camera-frame.jpg",
        );
        fd.append("question", "Describe what you see briefly");
        return fd;
      };

      let response = await fetch("/api/analyze-image", {
        method: "POST",
        body: buildForm(),
      });
      if (!response.ok && response.status >= 500) {
        console.warn(
          `analyze-image first attempt failed (${response.status}), retrying once...`,
        );
        await new Promise((r) => setTimeout(r, 800));
        response = await fetch("/api/analyze-image", {
          method: "POST",
          body: buildForm(),
        });
      }

      if (!response.ok) {
        let errorMessage = "Failed to analyze photo";
        try {
          const error = await response.json();
          errorMessage = error.error || errorMessage;
          if (error.details) errorMessage += ` (${error.details})`;
        } catch {
          errorMessage += ` (${response.status})`;
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();
      const analysis = data.analysis;
      setImageAnalysis(analysis);

      // Store a copy of this snapshot + analysis to Supabase for later audit.
      void captureMedia({
        file: frameFile,
        source: "camera_snapshot",
        sessionId: sessionRef.current?.sessionId ?? null,
        geminiAnalysis: analysis,
        problem: currentProblemRef.current || null,
      });

      // Inject the analysis as context to the TALK brain so it can respond
      // intelligently in the flow of the conversation (e.g. tying a snapshot of
      // a lampshade back to the user's earlier "how do I get this off" question).
      // REVERTED from plain repeat() on 2026-04-24 — repeat() made the avatar
      // read Gemini's raw description without connecting it to the prior thread.
      if (mode === "FULL" && sessionRef.current) {
        const contextMessage = `[IMAGE CONTEXT — not spoken by user] Vision just processed an image the user captured. You are viewing it directly. Here is what's in it: ${analysis}. Respond naturally in first person as 6, tie what you see to the ongoing conversation (especially any problem the user was trying to solve), and ask intelligent follow-up questions about the object or problem. Respond briefly (1-2 sentences). Never say you can't see it or that you're relying on someone else's analysis — you can see it directly.`;
        sessionRef.current.message(contextMessage);
      }

      setIsAnalyzingImage(false);
    } catch (error) {
      console.error("Error capturing and analyzing photo:", error);
      // Capture the frame + error so we can audit failures later.
      if (frameFile) {
        void captureMedia({
          file: frameFile,
          source: "camera_snapshot",
          sessionId: sessionRef.current?.sessionId ?? null,
          problem: currentProblemRef.current || null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if (mode === "FULL") {
        const oopsNow = Date.now();
        if (oopsNow - lastOopsTimeRef.current > 15000) {
          lastOopsTimeRef.current = oopsNow;
          await repeat(
            "Oops! I had a little trouble analyzing the photo. Could you try again?",
          );
        }
      }
      setIsAnalyzingImage(false);
    }
  }, [
    isCameraActive,
    visionMode,
    captureCameraFrame,
    cameraStream,
    fallbackImage,
    fallbackImagePreview,
    mode,
    sessionRef,
    repeat,
  ]);

  // Function to process camera question (only for streaming mode - verbal questions)
  const processCameraQuestion = useCallback(
    async (question: string, skipDuplicateCheck: boolean = false) => {
      console.log("processCameraQuestion called", {
        question,
        skipDuplicateCheck,
        isCameraActive,
        visionMode,
        isProcessingCameraQuestion,
      });

      // Only process in streaming mode (Go Live)
      if (!isCameraActive || visionMode !== "streaming") {
        console.log("Not in streaming vision mode, returning early");
        return;
      }

      const userText = question.trim();

      // Allow empty question for general analysis (when camera mode is first activated)
      // Skip only if we're not doing a general analysis (skipDuplicateCheck is false and question is empty)
      if (userText.length === 0 && !skipDuplicateCheck) {
        console.log(
          "Question is empty and not a general analysis request, returning early",
        );
        return;
      }

      // Skip if already processing (use ref for immediate check to prevent race conditions)
      // Note: We allow processing if isDebugProcessingRef is set by the current call
      // The check is done in handleDebugAnalysis before calling this function
      // BUT: Allow processing if skipDuplicateCheck is true (for initial vision recognition)
      if (isProcessingCameraQuestion && !skipDuplicateCheck) {
        console.log("Already processing, skipping duplicate request");
        return;
      }

      // Skip duplicate check if explicitly skipped (for debug button)
      if (
        !skipDuplicateCheck &&
        lastProcessedQuestionRef.current === userText
      ) {
        console.log("Skipping duplicate question:", userText);
        return;
      }

      // Clear any existing timeout
      if (processingTimeoutRef.current) {
        clearTimeout(processingTimeoutRef.current);
      }

      // Mark as processing and store the question
      console.log("Processing question with camera frame analysis...");
      setIsProcessingCameraQuestion(true);
      setIsAnalyzingImage(true);
      // Don't show loading text - we'll only show "Analyzing" via isProcessingCameraQuestion
      // Removed setShowVisionLoading(true) to prevent flashing text
      lastProcessedQuestionRef.current = userText;

      // Hoisted so catch can still store the frame + error for audit.
      let pollFrameFile: File | null = null;
      try {
        // Capture frame from camera or use fallback image
        console.log("Capturing camera frame or using fallback image...");
        const frameFile = await captureCameraFrame();
        pollFrameFile = frameFile;

        if (!frameFile) {
          console.error("Failed to capture camera frame or no fallback image");
          if (mode === "FULL") {
            if (cameraAvailable === false && !fallbackImage) {
              await repeat(
                "I don't have a camera or image to analyze right now. Please upload an image first by clicking the Camera button and selecting an image!",
              );
            } else {
              await repeat(
                "Hmm, I'm having trouble capturing what I'm seeing right now. Could you try asking again in a moment?",
              );
            }
          }
          setIsProcessingCameraQuestion(false);
          setIsAnalyzingImage(false);
          // Reset after a delay to allow retry
          processingTimeoutRef.current = setTimeout(() => {
            lastProcessedQuestionRef.current = "";
          }, 2000);
          return;
        }

        // BLACK-FRAME SKIP — when the camera is face-down, in a pocket, or
        // pointed at a uniform surface, JPEG compression collapses the file
        // to ~2-3 KB. Burning a Gemini call (and Vercel function invocation)
        // on that frame is pure waste. Threshold of 8 KB is empirical:
        // breakthrough-session frames were 80-140 KB; black/laid-down
        // frames in the same session were 2.5 KB. (Added 2026-04-25 after
        // Vercel 75% credit warning.)
        if (frameFile.size < 8 * 1024) {
          console.log(
            `Vision: skipping tiny frame (${frameFile.size}b) — likely black/laid-down camera.`,
          );
          // Still inject a context line so 6 knows the camera isn't aimed.
          if (sessionRef.current && goLiveActiveRef.current) {
            sessionRef.current.message(
              "[VISION — camera not aimed at the problem object right now]",
            );
          }
          // Also persist as a media event so the audit trail shows we saw
          // a black frame (not that vision broke).
          void captureMedia({
            file: frameFile,
            source: "go_live_frame",
            sessionId: sessionRef.current?.sessionId ?? null,
            problem: currentProblemRef.current || null,
            geminiAnalysis: "[SKIPPED — black/blank frame]",
          });
          setIsProcessingCameraQuestion(false);
          setIsAnalyzingImage(false);
          processingTimeoutRef.current = setTimeout(() => {
            lastProcessedQuestionRef.current = "";
          }, 2000);
          return;
        }

        // Build up `currentProblemRef` during the first 20 seconds of vision:
        // accumulate non-question user utterances so multi-part problem descriptions
        // like "I got scratches" + "on my sunglasses" both land in the problem.
        // Skip questions (contain "?") and very short responses so follow-up
        // questions like "What are you looking at?" don't overwrite the problem.
        if (userText.length > 0) {
          const isQuestion = userText.includes("?");
          const isSubstantive = userText.length >= 15;
          const nowMs = Date.now();
          const problemWindowMs = 20000;

          if (!currentProblemRef.current) {
            // First capture — take whatever we got, mark the timestamp.
            currentProblemRef.current = userText;
            problemFirstSetAtRef.current = nowMs;
          } else if (
            !isQuestion &&
            isSubstantive &&
            problemFirstSetAtRef.current > 0 &&
            nowMs - problemFirstSetAtRef.current < problemWindowMs
          ) {
            // Within the 20s accumulation window: append if not a question.
            currentProblemRef.current = `${currentProblemRef.current} ${userText}`.trim();
          }
          // After 20s or for questions: problem stays locked.
        }

        console.log("Frame captured, sending to API with question:", userText);
        // Send to analyze-image API in streaming mode with problem context + last analysis
        // so Grok stays laser-focused on the user's actual problem and silent when nothing changed.
        const formData = new FormData();
        formData.append("image", frameFile, frameFile.name || "camera-frame.jpg");
        formData.append("question", userText);
        formData.append("mode", "streaming");
        if (currentProblemRef.current) {
          formData.append("problem", currentProblemRef.current);
        }
        if (lastAnalysisRef.current) {
          formData.append("lastAnalysis", lastAnalysisRef.current);
        }

        const response = await fetch("/api/analyze-image", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          let errorMessage = "Failed to analyze camera frame";
          try {
            const error = await response.json();
            errorMessage = error.error || errorMessage;
            if (error.details) errorMessage += ` (${error.details})`;
          } catch {
            errorMessage += ` (${response.status})`;
          }
          console.error("API error:", errorMessage);
          throw new Error(errorMessage);
        }

        const data = await response.json();
        const analysis: string = (data.analysis ?? "").toString();
        console.log("Analysis received:", analysis.substring(0, 100) + "...");

        // Store the frame + Gemini's verdict (including [SILENT]) so we can
        // audit what 6 was actually looking at during Go Live.
        void captureMedia({
          file: frameFile,
          source: "go_live_frame",
          sessionId: sessionRef.current?.sessionId ?? null,
          geminiAnalysis: analysis,
          problem: currentProblemRef.current || null,
        });

        // Silent-first: Gemini outputs [SILENT] when nothing meaningful has
        // changed. Stay quiet — the loading overlay + proactive narration on
        // real state changes already cover the "avatar isn't frozen" need.
        // (2026-04-25: removed the rotating "Hang tight" filler that was
        // polluting transcript and confusing the TALK brain.)
        const trimmed = analysis.trim();
        if (trimmed === "[SILENT]" || trimmed.startsWith("[SILENT]")) {
          console.log("Vision: [SILENT] — avatar staying quiet.");
          // Reset the last processed question so the user can ask again if they want.
          processingTimeoutRef.current = setTimeout(() => {
            lastProcessedQuestionRef.current = "";
          }, 2000);
          return;
        }

        // OBJECT_NOT_VISIBLE: strip the prefix and speak only the quoted prompt.
        // Debounce — if we already spoke a reframe in the last 12 seconds, treat
        // this one as [SILENT]. Gemini can fire OBJECT_NOT_VISIBLE on 10+ frames
        // in a row; without this the avatar spams the same ask every 1.5s.
        let responseMessage = trimmed;
        let isReframe = false;
        const objectNotVisibleMatch = trimmed.match(
          /^OBJECT_NOT_VISIBLE\s*:\s*["“]?(.+?)["”]?$/s,
        );
        if (objectNotVisibleMatch) {
          responseMessage = objectNotVisibleMatch[1].trim();
          isReframe = true;
          console.log("Vision: object not visible — reframe response.");
        }

        if (isReframe) {
          const nowMs = Date.now();
          if (nowMs - lastReframeTimeRef.current < 25000) {
            console.log(
              "Vision: reframe already spoken in last 25s — suppressing duplicate.",
            );
            processingTimeoutRef.current = setTimeout(() => {
              lastProcessedQuestionRef.current = "";
            }, 2000);
            return;
          }
          lastReframeTimeRef.current = nowMs;
        }

        // CLIENT-SIDE DEDUP — but with escape valves so 6 stays grounded.
        //
        // 1. Vision-intent utterance (user just asked "what do you see?"):
        //    ALWAYS speak the observation, even if duplicate. Skipping it
        //    makes 6 appear to not know, which is exactly the bug the
        //    vision system is meant to prevent. (Fixed 2026-04-24 after
        //    6 said "I don't see anything" with 30 consecutive duplicate
        //    observations deduped away.)
        //
        // 2. Duplicate observation but last inject was stale (>25s ago):
        //    re-inject as context so the TALK brain doesn't lose the
        //    thread. The observation hasn't changed, but we need to keep
        //    it fresh in 6's memory.
        //
        // 3. Duplicate observation AND last inject was recent: skip.
        const userLower = userText.toLowerCase();
        // Vision-intent matcher — broadened 2026-04-25 after smoke test where
        // "What does the poster say?" / "What name on the poster?" failed to
        // trigger fresh vision because the regex only covered "what is/are/do
        // you" not "what does". Same scene-shift problem applied to "read the
        // X" and "what color/brand/logo" asks.
        const userHasVisionIntent =
          userLower.length > 0 &&
          /\b(see|look|looking|view|visible|notice|spot|describe|show|find|read(ing)?|what('?s| is| are| do you| does| do| name| color| brand| logo| label| word| say| number)|where('?s| is)?|which|how does it look|is it (off|on|loose|tight|stuck|done|working)|did (i|it|we|that)|can you (see|see it|tell|read|make out))/.test(
            userLower,
          );

        let isDuplicate = false;
        if (!isReframe && lastAnalysisRef.current) {
          const norm = (s: string) =>
            s
              .toLowerCase()
              .replace(/[^\p{L}\p{N}\s]/gu, " ")
              .split(/\s+/)
              .filter((w) => w.length > 2);
          const prevTokens = new Set(norm(lastAnalysisRef.current));
          const currTokens = norm(responseMessage);
          if (currTokens.length > 0 && prevTokens.size > 0) {
            const overlap = currTokens.filter((w) => prevTokens.has(w)).length;
            const ratio = overlap / Math.max(currTokens.length, prevTokens.size);
            if (ratio >= 0.85) {
              isDuplicate = true;
              const injectAgeMs =
                Date.now() - lastVisionInjectTimeRef.current;
              const stale = injectAgeMs > VISION_REINJECT_STALE_MS;
              if (!userHasVisionIntent && !stale) {
                console.log(
                  `Vision dedup: ${(ratio * 100).toFixed(0)}% overlap, inject age ${Math.round(injectAgeMs / 1000)}s — skipping.`,
                );
                processingTimeoutRef.current = setTimeout(() => {
                  lastProcessedQuestionRef.current = "";
                }, 2000);
                return;
              }
              console.log(
                `Vision dedup bypassed: overlap ${(ratio * 100).toFixed(0)}%, age ${Math.round(injectAgeMs / 1000)}s, visionIntent=${userHasVisionIntent}, stale=${stale}`,
              );
            }
          }
        }

        setImageAnalysis(responseMessage);
        // Remember this analysis so the next frame can be compared against it for change detection.
        // Only update on non-duplicates so dedup still works across stale re-injects.
        if (!isDuplicate) {
          lastAnalysisRef.current = responseMessage;
        }

        // Store the response to filter out avatar transcriptions later
        lastAvatarResponseRef.current = responseMessage.substring(0, 100); // Store first 100 chars for comparison

        // Two paths (rewrote 2026-04-24 after vision-hallucination smoke test;
        // tightened further after "talky talky" smoke test same day):
        //
        // VISION-INTENT POLL → the user's latest utterance clearly asks about
        //   what 6 sees. Speak the observation directly via repeat() so the
        //   answer lands fast.
        //
        // EVERYTHING ELSE (idle polls, affirmations like "sure"/"yeah",
        // off-topic utterances) → inject the observation as CONTEXT via
        // message(). The TALK brain has visual grounding for its NEXT
        // response but 6 does NOT parrot the observation aloud unprompted.
        //
        // OBJECT_NOT_VISIBLE is handled above before this branch — it always
        // speaks via repeat() because it's a user-facing reframe ask.
        // PROACTIVE NARRATION (added 2026-04-25 after smoke test where 6
        // saw "finial in your hand, off the lamp" but stayed silent until
        // G asked "what do I have in my hand?"). Three speech paths now:
        //
        //   1) USER ASKED A VISION QUESTION → speak the observation directly.
        //   2) NEW STATE CHANGE (non-duplicate observation on idle poll) →
        //      ALSO speak via repeat(). 6 announces what changed without
        //      waiting for a prompt. Dedup ensures we don't fire on every
        //      frame — only when the scene meaningfully shifts.
        //   3) STALE RE-INJECT (duplicate but >25s since last inject) →
        //      message() inject only, no speech. Keeps TALK brain grounded
        //      without repeating ourselves out loud.
        //
        // Skip everything if Go Live has already been stopped by the user.
        if (mode === "FULL" && goLiveActiveRef.current) {
          const isNewStateChange = !isDuplicate;
          if (userHasVisionIntent || isNewStateChange) {
            console.log(
              `Vision observation → speak (visionIntent=${userHasVisionIntent}, stateChange=${isNewStateChange}).`,
            );
            await repeat(responseMessage);
          } else if (sessionRef.current) {
            console.log(
              "Vision observation → stale re-inject (no speech).",
            );
            sessionRef.current.message(
              `[VISION — current view] ${responseMessage}`,
            );
          }
          lastVisionResponseTimeRef.current = Date.now();
          lastVisionInjectTimeRef.current = Date.now();
        }

        // Reset the last processed question after a delay to allow the same question to be asked again later
        processingTimeoutRef.current = setTimeout(() => {
          lastProcessedQuestionRef.current = "";
        }, 5000);
      } catch (error) {
        console.error("Error processing camera question:", error);
        // Audit: store the frame + error so we can see what Gemini choked on.
        if (pollFrameFile) {
          void captureMedia({
            file: pollFrameFile,
            source: "go_live_frame",
            sessionId: sessionRef.current?.sessionId ?? null,
            problem: currentProblemRef.current || null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        // Polling runs every 1.5s; a transient error resolves within 1-2 polls.
        // Speaking "Oops" at the user for a transient cold-start is just noise —
        // swallow silently and let the next poll try again. (2026-04-24: removed
        // the user-visible Oops during Go Live per G's "no oops on retry" ask.)
        // Reset after error
        processingTimeoutRef.current = setTimeout(() => {
          lastProcessedQuestionRef.current = "";
        }, 2000);
      } finally {
        setIsProcessingCameraQuestion(false);
        setIsAnalyzingImage(false);
        // Loading will be hidden when avatar starts talking (via useEffect) or already hidden above
      }
    },
    [
      isCameraActive,
      isProcessingCameraQuestion,
      visionMode,
      mode,
      captureCameraFrame,
      cameraAvailable,
      fallbackImage,
      sessionRef,
      repeat,
    ],
  );

  // Debug button handler
  const handleDebugAnalysis = useCallback(async () => {
    console.log("Debug button clicked", {
      isDebugProcessing: isDebugProcessingRef.current,
      isProcessingCameraQuestion,
      isCameraActive,
      hasFallbackImage: !!fallbackImage,
      cameraAvailable,
    });

    // Prevent multiple simultaneous calls
    if (isDebugProcessingRef.current || isProcessingCameraQuestion) {
      console.log("Debug analysis already in progress, skipping...");
      return;
    }

    if (!isCameraActive) {
      console.error("Camera is not active, cannot analyze");
      return;
    }

    isDebugProcessingRef.current = true;
    const defaultQuestion =
      "What can you see in this image? Please describe everything you see with enthusiasm and humor!";

    console.log("Starting debug analysis with question:", defaultQuestion);

    try {
      await processCameraQuestion(defaultQuestion, true);
      console.log("Debug analysis completed successfully");
    } catch (error) {
      console.error("Error in debug analysis:", error);
    } finally {
      // Reset after processing completes
      setTimeout(() => {
        isDebugProcessingRef.current = false;
        console.log("Debug processing ref reset");
      }, 500);
    }
  }, [
    processCameraQuestion,
    isProcessingCameraQuestion,
    isCameraActive,
    fallbackImage,
    cameraAvailable,
  ]);

  // Listen to user transcriptions and handle verbal questions in streaming mode (Go Live)
  useEffect(() => {
    if (!sessionRef.current) {
      return;
    }

    const handleUserTranscription = async (event: { text: string }) => {
      const userText = event.text.trim();
      console.log(
        "User transcription received:",
        userText,
        "Vision mode:",
        visionMode,
      );

      // Skip transcription while any camera video recording is in progress
      if (isRecording) {
        console.log(
          "Recording in progress, skipping transcription - avatar should be quiet",
        );
        return;
      }

      // Only process in streaming mode (Go Live)
      if (visionMode !== "streaming") {
        console.log("Not in streaming mode, skipping transcription processing");
        return;
      }

      // Cooldown: do nothing if we just spoke a vision response (avatar still speaking)
      // Must be before interrupt() so we don't cut off our own analysis on duplicate transcriptions
      const VISION_RESPONSE_COOLDOWN_MS = 10000;
      if (
        lastVisionResponseTimeRef.current > 0 &&
        Date.now() - lastVisionResponseTimeRef.current <
          VISION_RESPONSE_COOLDOWN_MS
      ) {
        console.log(
          "Skipping transcription - within vision response cooldown (avatar still speaking)",
        );
        return;
      }

      // Interrupt the agent immediately so it never says "I can't access your camera"
      // We will answer from camera analysis only via processCameraQuestion -> repeat(analysis)
      interrupt();

      // Skip if this transcription matches our recent avatar response (avatar's speech being transcribed)
      // This prevents infinite loops where avatar's response triggers another analysis
      if (lastAvatarResponseRef.current && userText.length > 30) {
        const responseStart = lastAvatarResponseRef.current
          .toLowerCase()
          .trim();
        const transcriptionStart = userText
          .substring(0, Math.min(150, userText.length))
          .toLowerCase()
          .trim();

        // Check if transcription matches our response (avatar speaking our response)
        // Compare first 50-100 characters for similarity
        const responsePrefix = responseStart.substring(0, 80);
        const transcriptionPrefix = transcriptionStart.substring(0, 80);

        // If they're very similar (80% match), it's likely the avatar's response
        if (responsePrefix.length > 30 && transcriptionPrefix.length > 30) {
          let matchCount = 0;
          const minLength = Math.min(
            responsePrefix.length,
            transcriptionPrefix.length,
          );
          for (let i = 0; i < minLength; i++) {
            if (responsePrefix[i] === transcriptionPrefix[i]) {
              matchCount++;
            }
          }
          const similarity = matchCount / minLength;

          if (similarity > 0.7) {
            console.log(
              "Skipping transcription - appears to be avatar's response being transcribed",
              {
                similarity,
                responsePrefix: responsePrefix.substring(0, 50),
                transcriptionPrefix: transcriptionPrefix.substring(0, 50),
              },
            );
            return;
          }
        }
      }

      // Also skip if transcription is very long (likely avatar response, not user question)
      // User questions are typically shorter, avatar responses are longer
      if (userText.length > 200) {
        console.log(
          "Skipping transcription - too long, likely avatar response",
        );
        return;
      }

      // Skip if transcription is too short (likely noise or partial speech)
      if (userText.length < 3) {
        console.log("Skipping transcription - too short, likely noise");
        return;
      }

      // Skip if already processing to prevent duplicate triggers
      if (isProcessingCameraQuestion) {
        console.log("Skipping transcription - already processing");
        return;
      }

      // Persist transcript and drive contact info collection prompts (email/phone/name)
      const captureSessionId = dbSessionIdRef.current;
      try {
        const captureResponse =
          captureSessionId != null
            ? await fetch("/api/transcription/capture", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  sessionId: captureSessionId,
                  text: userText,
                }),
              })
            : null;

        if (captureResponse?.ok) {
          const captureData = await captureResponse.json();
          if (
            captureData?.assistantPrompt &&
            typeof captureData.assistantPrompt === "string"
          ) {
            await repeat(captureData.assistantPrompt);
            lastAvatarResponseRef.current = captureData.assistantPrompt;
            lastVisionResponseTimeRef.current = Date.now();
          }

          if (captureData?.shouldSkipVision) {
            return;
          }
        } else if (captureResponse) {
          const captureError = await captureResponse.text();
          console.error("Failed to capture transcription:", captureError);
        }
      } catch (captureError) {
        console.error("Error calling transcription capture route:", captureError);
      }

      // Removed: prior code re-injected a long video-context prompt into the avatar
      // via sessionRef.current.message(), which was being treated as USER input and
      // overwhelming the TALK brain. Follow-up questions about the video are now
      // handled by the normal streaming flow via processCameraQuestion below.

      // Process the question using the reusable function (only in streaming mode)
      await processCameraQuestion(userText, false);
    };

    console.log(
      "Setting up USER_TRANSCRIPTION listener, vision mode:",
      visionMode,
    );
    sessionRef.current.on(
      AgentEventsEnum.USER_TRANSCRIPTION,
      handleUserTranscription,
    );

    return () => {
      if (processingTimeoutRef.current) {
        clearTimeout(processingTimeoutRef.current);
      }
      if (sessionRef.current) {
        console.log("Cleaning up USER_TRANSCRIPTION listener");
        // Use removeListener if off is not available
        if (typeof (sessionRef.current as any).off === "function") {
          (sessionRef.current as any).off(
            AgentEventsEnum.USER_TRANSCRIPTION,
            handleUserTranscription,
          );
        } else if (
          typeof (sessionRef.current as any).removeListener === "function"
        ) {
          (sessionRef.current as any).removeListener(
            AgentEventsEnum.USER_TRANSCRIPTION,
            handleUserTranscription,
          );
        }
      }
    };
  }, [
    sessionRef,
    visionMode,
    processCameraQuestion,
    isRecording,
    interrupt,
    mode,
    repeat,
    isProcessingCameraQuestion,
  ]);

  // Track if initial analysis has been triggered to prevent repeated automatic analysis
  const hasInitialAnalysisRef = useRef<boolean>(false);

  // Automatically trigger vision recognition when Go Live streaming mode is activated
  // BUT only once - prevent repeated automatic analysis that causes excessive talking
  useEffect(() => {
    if (
      visionMode === "streaming" &&
      isCameraActive &&
      !isProcessingCameraQuestion &&
      !hasInitialAnalysisRef.current
    ) {
      // Wait a moment for camera to be ready, then analyze what's in view ONCE
      // The "Analyzing" text will show when processCameraQuestion sets isProcessingCameraQuestion to true
      const timeoutId = setTimeout(() => {
        // Double-check conditions before triggering
        if (
          visionMode === "streaming" &&
          isCameraActive &&
          !isProcessingCameraQuestion &&
          !hasInitialAnalysisRef.current
        ) {
          hasInitialAnalysisRef.current = true;
          processCameraQuestion("", true);
        }
      }, 1000);

      return () => {
        clearTimeout(timeoutId);
      };
    } else if (visionMode !== "streaming" && !isCameraActive) {
      // Reset processing state and initial analysis flag when vision mode is deactivated,
      // so the next Go Live session can fire its initial analysis.
      setIsProcessingCameraQuestion(false);
      hasInitialAnalysisRef.current = false;
      // PERSIST currentProblemRef across Go Live restarts so 6 picks up where he left off
      // (e.g. user restarts Go Live after 2-minute timeout to continue on the same problem).
      // Only clear last-analysis so Grok's frame-change comparison starts fresh each session.
      lastAnalysisRef.current = "";
    }
  }, [
    visionMode,
    isCameraActive,
    isProcessingCameraQuestion,
    processCameraQuestion,
  ]);

  // Hide loading text when avatar starts talking
  useEffect(() => {
    if (isAvatarTalking && showVisionLoading) {
      setShowVisionLoading(false);
    }
  }, [isAvatarTalking, showVisionLoading]);

  // Automatically analyze and speak when camera mode is activated
  // DISABLED: This was causing automatic snap when camera opens on mobile
  // Users should manually trigger analysis by asking questions via voice
  /*
  useEffect(() => {
    if (!isCameraActive) {
      // Reset the flag when camera is deactivated
      hasAutoAnalyzedRef.current = false;
      return;
    }

    // Skip if we've already auto-analyzed for this activation
    if (hasAutoAnalyzedRef.current) {
      return;
    }

    // Wait a bit for camera stream or fallback image to be ready
    const timeoutId = setTimeout(async () => {
      // Check if we have either a camera stream or fallback image
      const hasImage = fallbackImage !== null;
      const hasCameraStream = cameraStream !== null && cameraPreviewRef.current;
      
      if (!hasImage && !hasCameraStream) {
        console.log("Waiting for camera or fallback image to be ready...");
        return;
      }

      // If camera stream, wait a bit more for video to be ready
      if (hasCameraStream && cameraPreviewRef.current) {
        const video = cameraPreviewRef.current;
        if (video.readyState < 2 || video.videoWidth === 0) {
          // Wait for video to be ready
          const checkVideoReady = () => {
            if (!isCameraActive || hasAutoAnalyzedRef.current) {
              return; // Camera was turned off or already analyzed
            }
            if (video.readyState >= 2 && video.videoWidth > 0) {
              console.log("Camera video is ready, triggering auto-analysis");
              hasAutoAnalyzedRef.current = true;
              // Use empty string for general analysis (no specific question)
              processCameraQuestion("", true);
            } else {
              setTimeout(checkVideoReady, 200);
            }
          };
          checkVideoReady();
          return;
        }
      }

      // Trigger automatic analysis without a question (just describe what it sees)
      console.log("Camera mode activated, triggering automatic analysis");
      hasAutoAnalyzedRef.current = true;
      // Use empty string to trigger general analysis without a specific question
      processCameraQuestion("", true);
    }, 500); // Wait 500ms for setup

    return () => {
      clearTimeout(timeoutId);
    };
  }, [isCameraActive, cameraStream, fallbackImage, processCameraQuestion]);
  */

  // Check camera availability on mount and set default broken glass image
  useEffect(() => {
    const checkCameraAvailability = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const hasVideoInput = devices.some(
          (device) => device.kind === "videoinput",
        );
        setCameraAvailable(hasVideoInput);

        // If no camera available, load and set default fallback image
        if (!hasVideoInput) {
          try {
            const fallbackImageFile = await loadFallbackImage();
            setFallbackImage(fallbackImageFile);
            const previewUrl = URL.createObjectURL(fallbackImageFile);
            setFallbackImagePreview(previewUrl);
          } catch (error) {
            console.error("Error loading fallback image:", error);
          }
        }
      } catch (error) {
        console.error("Error checking camera availability:", error);
        setCameraAvailable(false);
        // Still try to load fallback image
        try {
          const fallbackImageFile = await loadFallbackImage();
          setFallbackImage(fallbackImageFile);
          const previewUrl = URL.createObjectURL(fallbackImageFile);
          setFallbackImagePreview(previewUrl);
        } catch (err) {
          console.error("Error loading fallback image:", err);
        }
      }
    };
    checkCameraAvailability();
  }, [loadFallbackImage]);

  const handleCameraClick = async () => {
    // If 6 is mid-sentence, cut him off. User wants to show us something —
    // talking over that is a UX fail. (Added 2026-04-24 per G.)
    try {
      sessionRef.current?.interrupt?.();
    } catch {
      // non-fatal
    }
    if (visionMode === "snapshot") {
      // Stop camera if already in snapshot mode
      if (cameraStream) {
        cameraStream.getTracks().forEach((track) => track.stop());
        setCameraStream(null);
      }
      setIsCameraActive(false);
      setVisionMode(null);
      setFallbackImage(null);
      setFallbackImagePreview(null);

      // CRITICAL: Don't pause or mute the video element
      // Audio should continue playing
      return;
    }

    // Set to snapshot mode (for taking a single photo)
    setVisionMode("snapshot");

    // If camera is not available, show fallback mode with default image
    if (cameraAvailable === false) {
      setIsCameraActive(true);
      // If fallback image is not already set, load it
      if (!fallbackImage) {
        loadFallbackImage()
          .then((file) => {
            setFallbackImage(file);
            const previewUrl = URL.createObjectURL(file);
            setFallbackImagePreview(previewUrl);
          })
          .catch((error) => {
            console.error("Error loading fallback image:", error);
          });
      }
      return;
    }

    try {
      // First try to get rear camera (environment)
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
        setCameraAvailable(true);
      } catch (error) {
        // If rear camera fails, try front camera (user)
        console.log("Rear camera not available, trying front camera");
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "user" },
          });
          setCameraAvailable(true);
        } catch (error2) {
          // No camera available, use fallback mode with default image
          console.log("No camera available, using fallback mode");
          setCameraAvailable(false);
          setIsCameraActive(true);
          // If fallback image is not already set, load it
          if (!fallbackImage) {
            loadFallbackImage()
              .then((file) => {
                setFallbackImage(file);
                const previewUrl = URL.createObjectURL(file);
                setFallbackImagePreview(previewUrl);
              })
              .catch((error) => {
                console.error("Error loading fallback image:", error);
              });
          }
          return;
        }
      }

      if (stream) {
        setCameraStream(stream);
        setIsCameraActive(true);
      }
    } catch (error) {
      console.error("Error accessing camera:", error);
      // Use fallback mode instead of showing error
      setCameraAvailable(false);
      setIsCameraActive(true);
      fallbackImageInputRef.current?.click();
    }
  };

  const handleFallbackImageChange = (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (file) {
      if (!file.type.startsWith("image/")) {
        alert("Please upload an image file");
        if (fallbackImageInputRef.current) {
          fallbackImageInputRef.current.value = "";
        }
        return;
      }
      // Clean up previous preview URL if it exists
      if (fallbackImagePreview) {
        URL.revokeObjectURL(fallbackImagePreview);
      }
      setFallbackImage(file);
      // Create preview URL
      const previewUrl = URL.createObjectURL(file);
      setFallbackImagePreview(previewUrl);
    }
    // Reset input
    if (fallbackImageInputRef.current) {
      fallbackImageInputRef.current.value = "";
    }
  };

  const handleGalleryClick = useCallback(async () => {
    // Interrupt 6 if he's mid-speech — user is showing us something.
    try {
      sessionRef.current?.interrupt?.();
    } catch {
      // non-fatal
    }
    await unlockAudio();
    if (fileInputRef.current) {
      fileInputRef.current.setAttribute("accept", "image/*,video/*");
      fileInputRef.current.click();
    }
  }, [unlockAudio, sessionRef]);

  // Record video from the live camera preview (snapshot mode only)
  const handleStartRecording = useCallback(() => {
    if (visionMode !== "snapshot" || !cameraStream) {
      return;
    }
    // Interrupt 6 mid-sentence — user is about to record, don't talk over it.
    try {
      sessionRef.current?.interrupt?.();
    } catch {
      // non-fatal
    }
    const stream = cameraStream;

    recordedChunksRef.current = [];

    let mimeType = "video/webm;codecs=vp9,opus";
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      mimeType = "video/webm;codecs=vp8,opus";
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        mimeType = "video/webm";
        if (!MediaRecorder.isTypeSupported(mimeType)) {
          mimeType = "";
        }
      }
    }

    const options: MediaRecorderOptions = mimeType ? { mimeType } : {};
    const mediaRecorder = new MediaRecorder(stream, options);

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunksRef.current.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(recordedChunksRef.current, { type: "video/webm" });
      setRecordedVideoBlob(blob);

      stream.getTracks().forEach((track) => track.stop());
      setCameraStream(null);
      setIsCameraActive(false);
      setVisionMode(null);
      if (
        fallbackImagePreview &&
        fallbackImage &&
        fallbackImage.name !== "2c44c052-e58a-4f6d-a6c8-dba901ff0e9e.jpg"
      ) {
        URL.revokeObjectURL(fallbackImagePreview);
      }
      setFallbackImage(null);
      setFallbackImagePreview(null);

      setIsAnalyzingVideo(true);
      // Hoisted so catch can still store the file for failure audit.
      let recordedVideoFile: File | null = null;
      try {
        recordedVideoFile = new File([blob], "recorded-video.webm", {
          type: "video/webm",
        });
        // 10 frames over a 15s video = 1.5s granularity, enough to catch quick
        // actions like a finial coming off. Was 5 frames which missed fast moments.
        const frames = await extractVideoFrames(recordedVideoFile, 10);

        // Retry once on 5xx — Vercel cold starts and Gemini transient errors.
        let response = await fetch("/api/analyze-video", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ frames }),
        });
        if (!response.ok && response.status >= 500) {
          console.warn(
            `analyze-video first attempt failed (${response.status}), retrying once...`,
          );
          await new Promise((r) => setTimeout(r, 800));
          response = await fetch("/api/analyze-video", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ frames }),
          });
        }

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Failed to analyze video");
        }

        const data = await response.json();
        console.log("Video analyzed successfully");

        setVideoAnalysis(data.analysis);

        // Audit capture: recorded video + Gemini analysis.
        void captureMedia({
          file: recordedVideoFile,
          source: "video_recording",
          sessionId: sessionRef.current?.sessionId ?? null,
          geminiAnalysis: data.analysis,
          problem: currentProblemRef.current || null,
        });

        if (mode === "FULL" && sessionRef.current) {
          // Inject the video analysis as context so the TALK brain can respond
          // in the flow of the conversation (tying the video back to the problem
          // the user was trying to solve). Previously used repeat() which made
          // the avatar read Gemini's flowery description aloud without tying
          // it to what the user had been asking about. (Fixed 2026-04-24.)
          const contextMessage = `[VIDEO CONTEXT — not spoken by user] Vision just processed a video the user recorded. You are viewing it directly. Here is what happens in it: ${data.analysis}. Respond naturally in first person as 6, tie what you saw to the ongoing conversation (especially any problem the user was trying to solve), and ask intelligent follow-up questions about the object or problem. Respond briefly (1-2 sentences). Never say you can't see it or that you're relying on someone else's analysis — you can see it directly.`;
          sessionRef.current.message(contextMessage);
        }

        setIsAnalyzingVideo(false);
        setVideoBusy(false);
      } catch (error) {
        console.error("Error analyzing video:", error);
        // Audit capture for failure — keep the file for debugging.
        if (recordedVideoFile) {
          void captureMedia({
            file: recordedVideoFile,
            source: "video_recording",
            sessionId: sessionRef.current?.sessionId ?? null,
            problem: currentProblemRef.current || null,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        alert("Failed to analyze video. Please try again.");
        setIsAnalyzingVideo(false);
        setVideoBusy(false);
      }
    };

    mediaRecorderRef.current = mediaRecorder;
    mediaRecorder.start();
    setIsRecording(true);
    // Block silence re-engage signals + any avatar speech while recording.
    // Flag stays on through analysis and is cleared in the onstop handler below.
    setVideoBusy(true);

    // Auto-stop recording at 15 seconds so users don't have to remember to hit Stop
    // and so analyze-video has a bounded input (Gemini timeout risk on very long clips).
    setTimeout(() => {
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state === "recording"
      ) {
        console.log("Video: auto-stopping at 15s cap.");
        mediaRecorderRef.current.stop();
        setIsRecording(false);
        // handleStopRecording handles mic restart — mirror the relevant cleanup here.
        if (mode === "FULL") {
          setTimeout(() => {
            startListening();
            if (isActive && isMuted && !wasMutedBeforeRecordingRef.current) {
              unmute();
            }
          }, 500);
        }
      }
    }, 15000);

    if (mode === "FULL") {
      stopListening();
      wasMutedBeforeRecordingRef.current = isMuted;
      if (isActive && !isMuted) {
        mute();
      }
    }
  }, [
    visionMode,
    cameraStream,
    mode,
    sessionRef,
    stopListening,
    isActive,
    isMuted,
    mute,
    fallbackImagePreview,
    fallbackImage,
  ]);

  // Stop video recording
  const handleStopRecording = useCallback(() => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);

      // Restart listening and restore microphone state after recording stops
      // The video will be analyzed after recording completes (in mediaRecorder.onstop)
      if (mode === "FULL") {
        // Small delay to ensure recording has fully stopped
        setTimeout(() => {
          startListening();
          // Restore microphone state: unmute only if it wasn't muted before recording
          if (isActive && isMuted && !wasMutedBeforeRecordingRef.current) {
            unmute();
          }
        }, 500);
      }
    }
  }, [isRecording, mode, startListening, isActive, isMuted, unmute]);

  const handleCameraChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      // Handle camera image
      console.log("Camera image selected:", file);
      // Add your camera image handling logic here
    }
    // Reset input
    if (cameraInputRef.current) {
      cameraInputRef.current.value = "";
    }
  };

  const closeCameraPreview = useCallback(() => {
    // Inject a state signal so the TALK brain knows Go Live is no longer on.
    // Without this, 6 keeps acting as if he can see.
    try {
      if (mode === "FULL" && sessionRef.current) {
        sessionRef.current.message(
          "[GO LIVE IS OFF — user must hit the Go Live button before you can see anything]",
        );
      }
    } catch (signalError) {
      console.error("Error injecting Go Live OFF signal:", signalError);
    }
    if (cameraStream) {
      cameraStream.getTracks().forEach((track) => track.stop());
      setCameraStream(null);
    }
    setIsCameraActive(false);
    setVisionMode(null);
    // Clean up preview URL if it's not the default fallback image
    if (
      fallbackImagePreview &&
      fallbackImage &&
      fallbackImage.name !== "2c44c052-e58a-4f6d-a6c8-dba901ff0e9e.jpg"
    ) {
      URL.revokeObjectURL(fallbackImagePreview);
    }
    setFallbackImage(null);
    setFallbackImagePreview(null);
    // Reset processing state when camera is closed
    setIsProcessingCameraQuestion(false);
    setIsAnalyzingImage(false);
    lastProcessedQuestionRef.current = "";
    if (processingTimeoutRef.current) {
      clearTimeout(processingTimeoutRef.current);
      processingTimeoutRef.current = null;
    }
  }, [cameraStream, fallbackImagePreview, fallbackImage, mode, sessionRef]);

  // Continuous vision polling during Go Live.
  // Fires every 1.5s; Grok's [SILENT] token keeps the avatar quiet when nothing meaningful has changed.
  // Hard 2-minute cap: at the 2-minute mark, speak the timeout line and auto-deactivate Go Live.
  useEffect(() => {
    if (visionMode !== "streaming" || !isCameraActive) return;

    const POLLING_INTERVAL_MS = 1500; // back to 1.5s 2026-04-25 — Vercel 75% credit warning, drop poll rate to save function invocations. Combined with black-frame skip, ~50% reduction in vision API calls.
    const MAX_SESSION_MS = 300_000; // 5 min — bumped from 2 min per G 2026-04-24
    const sessionStartTime = Date.now();

    const intervalId = setInterval(() => {
      const elapsed = Date.now() - sessionStartTime;
      if (elapsed >= MAX_SESSION_MS) {
        clearInterval(intervalId);
        if (mode === "FULL") {
          repeat(
            "Sorry — we ran out of time on this one. If you need more time, restart Go Live and we'll pick it right back up.",
          ).catch((err) => {
            console.error("Error speaking timeout line:", err);
          });
        }
        closeCameraPreview();
        return;
      }

      // Skip if a previous vision call is still in flight — avoids overlapping requests.
      if (isProcessingCameraQuestion) return;

      // Skip if video recording/analysis is busy — don't compete with it.
      if (isVideoBusy()) return;

      processCameraQuestion("", true);
    }, POLLING_INTERVAL_MS);

    return () => clearInterval(intervalId);
  }, [
    visionMode,
    isCameraActive,
    mode,
    isProcessingCameraQuestion,
    processCameraQuestion,
    repeat,
    closeCameraPreview,
  ]);

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      if (fallbackImagePreview) {
        URL.revokeObjectURL(fallbackImagePreview);
      }
    };
  }, [fallbackImagePreview]);

  // Helper function to extract frames from video
  const extractVideoFrames = async (
    videoFile: File,
    numFrames: number = 5,
  ): Promise<string[]> => {
    return new Promise((resolve, reject) => {
      const video = document.createElement("video");
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");

      if (!ctx) {
        reject(new Error("Failed to get canvas context"));
        return;
      }

      video.preload = "metadata";
      video.onloadedmetadata = () => {
        video.currentTime = 0;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      };

      const frames: string[] = [];
      let frameCount = 0;

      video.onseeked = () => {
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const frameData = canvas.toDataURL("image/jpeg", 0.8);
        // Extract base64 data (remove data:image/jpeg;base64, prefix)
        const base64Data = frameData.split(",")[1];
        frames.push(base64Data);
        frameCount++;

        if (frameCount < numFrames) {
          // Seek to next frame position
          const nextTime =
            (video.duration / (numFrames + 1)) * (frameCount + 1);
          video.currentTime = nextTime;
        } else {
          resolve(frames);
        }
      };

      video.onerror = () => {
        reject(new Error("Error loading video"));
      };

      video.src = URL.createObjectURL(videoFile);
    });
  };

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }

    const isImage = file.type.startsWith("image/");
    const isVideo = file.type.startsWith("video/");

    if (!isImage && !isVideo) {
      alert("Please upload an image or video file");
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
      return;
    }

    if (isImage) {
      setIsAnalyzingImage(true);
      try {
        const formData = new FormData();
        formData.append("image", file, file.name || "image.jpg");

        const response = await fetch("/api/analyze-image", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          let errorMessage = "Failed to analyze image";
          try {
            const error = await response.json();
            errorMessage = error.error || errorMessage;
            if (error.details) errorMessage += ` (${error.details})`;
          } catch {
            errorMessage += ` (${response.status})`;
          }
          throw new Error(errorMessage);
        }

        const data = await response.json();
        setImageAnalysis(data.analysis);
        console.log("Image analyzed successfully");

        // Audit capture: gallery image + Gemini's analysis.
        void captureMedia({
          file,
          source: "gallery_image",
          sessionId: sessionRef.current?.sessionId ?? null,
          geminiAnalysis: data.analysis,
          problem: currentProblemRef.current || null,
        });

        // Inject the analysis as context to the TALK brain so it can respond
        // intelligently and tie the image to the ongoing conversation (e.g.
        // a snapshot of a lampshade back to the user's "how do I get this off"
        // question). REVERTED from plain repeat() on 2026-04-24 — repeat() made
        // the avatar just read Gemini's description without conversational context.
        if (mode === "FULL" && sessionRef.current) {
          const contextMessage = `[IMAGE CONTEXT — not spoken by user] Vision just processed an image the user captured. You are viewing it directly. Here is what's in it: ${data.analysis}. Respond naturally in first person as 6, tie what you see to the ongoing conversation (especially any problem the user was trying to solve), and ask intelligent follow-up questions about the object or problem. Respond briefly (1-2 sentences). Never say you can't see it or that you're relying on someone else's analysis — you can see it directly.`;
          sessionRef.current.message(contextMessage);
        }
      } catch (error) {
        console.error("Error analyzing image:", error);
        // Audit capture for failures — file still worth saving.
        void captureMedia({
          file,
          source: "gallery_image",
          sessionId: sessionRef.current?.sessionId ?? null,
          problem: currentProblemRef.current || null,
          error: error instanceof Error ? error.message : String(error),
        });
        alert("Failed to analyze image. Please try again.");
      } finally {
        setIsAnalyzingImage(false);
        setIsProcessingCameraQuestion(false);
      }
    } else if (isVideo) {
      setIsAnalyzingVideo(true);
      try {
        // Extract frames from video
        const frames = await extractVideoFrames(file, 5);

        const response = await fetch("/api/analyze-video", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ frames }),
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Failed to analyze video");
        }

        const data = await response.json();
        console.log("Video analyzed successfully");

        // Store video analysis in state so it persists even after closing video button
        setVideoAnalysis(data.analysis);

        // Audit capture: gallery video + analysis.
        void captureMedia({
          file,
          source: "gallery_video",
          sessionId: sessionRef.current?.sessionId ?? null,
          geminiAnalysis: data.analysis,
          problem: currentProblemRef.current || null,
        });

        // For FULL mode, send the analysis as context to the AI (no scripted repeat prompt)
        if (mode === "FULL") {
          // Speak the analysis directly via repeat() so the avatar says what it saw.
          // Using repeat() keeps this as avatar speech (role=assistant); earlier this
          // used sessionRef.current.message() which logged it as USER input and
          // confused the TALK brain.
          try {
            await repeat(data.analysis);
          } catch (speakError) {
            console.error("Error speaking video analysis:", speakError);
          }
        }
      } catch (error) {
        console.error("Error analyzing video:", error);
        // Audit capture for failures.
        void captureMedia({
          file,
          source: "gallery_video",
          sessionId: sessionRef.current?.sessionId ?? null,
          problem: currentProblemRef.current || null,
          error: error instanceof Error ? error.message : String(error),
        });
        alert("Failed to analyze video. Please try again.");
      } finally {
        setIsAnalyzingVideo(false);
      }
    }

    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <div className="fixed inset-0 w-screen h-screen bg-black flex flex-col">
      {/* Session start error (e.g. no credits) - show message and do not auto-restart */}
      {sessionStartError && (
        <div className="absolute inset-x-0 top-0 z-50 bg-red-900/95 text-white px-4 py-4 text-center shadow-lg">
          <p className="text-inset text-lg font-semibold">{sessionStartError}</p>
          <p className="text-inset mt-2 text-sm text-red-200">
            Add credits to your LiveAvatar account in the dashboard to continue.
          </p>
          {onExit && (
            <button
              type="button"
              onClick={() => onExit(false)}
              className="mt-3 px-4 py-2 bg-white text-red-900 rounded-md font-medium"
            >
              Back
            </button>
          )}
        </div>
      )}

      {/* Analyzing popup overlay - only show for snapshot mode, not streaming mode */}
      {(isAnalyzingImage || isAnalyzingVideo) && visionMode !== "streaming" && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-70">
          <div className="bg-gray-800/90 text-white px-8 py-6 rounded-lg shadow-2xl">
            <p className="text-inset text-xl font-semibold text-center">
              {isAnalyzingImage ? "Analyzing Photo...." : "Analyzing Video...."}
            </p>
          </div>
        </div>
      )}

      {/* MIC PERMISSION — denied/blocked recovery (Option B).
          Fires when the OS dialog was rejected, or permission state probes
          as 'denied'. Gives clear instructions per platform + retry. */}
      {micDeniedOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 px-6">
          <div className="w-full max-w-sm rounded-2xl bg-gray-900 border border-white/10 shadow-2xl p-7 text-center">
            <div className="mx-auto mb-4 w-16 h-16 rounded-full bg-white/10 flex items-center justify-center">
              <MicOff className="w-8 h-8 text-white" aria-hidden />
            </div>
            <h2 className="text-white text-xl font-semibold mb-2">
              Microphone blocked
            </h2>
            <p className="text-white/70 text-sm leading-relaxed mb-4">
              6 can&apos;t hear you without it. Enable mic access for this
              site, then tap Try Again.
            </p>
            <div className="text-left text-white/60 text-xs leading-relaxed mb-6 bg-white/5 rounded-lg p-3">
              <p className="font-semibold text-white/80 mb-1">Android Chrome / Firefox / Comet</p>
              <p>Tap the lock icon in the address bar → Site settings → Microphone → Allow.</p>
              <p className="font-semibold text-white/80 mt-3 mb-1">iPhone Safari</p>
              <p>Settings → Safari → Microphone → Allow this site.</p>
            </div>
            <div className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => void handleMicDeniedRetry()}
                className="w-full bg-white text-black font-semibold py-3 rounded-lg hover:bg-white/90 transition"
              >
                Try Again
              </button>
              <button
                type="button"
                onClick={() => setMicDeniedOpen(false)}
                className="w-full text-white/60 text-sm py-2 hover:text-white/80 transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Text overlays at the top */}
      <div className="absolute top-0 left-0 right-0 z-10 flex flex-col items-center pt-2 pb-2">
        <div className="text-center px-4 mb-2">
          <h1 className="inline-block text-white text-[1.2rem] sm:text-[1.7rem] font-bold tracking-tight leading-tight">
            iSolveUrProblems.ai - beta
          </h1>
          <p className="mx-auto max-w-[16.5rem] text-white text-[0.72rem] sm:text-[0.78rem] font-medium text-white/85 leading-snug">
            Your Home &amp; Garden Solution Center
          </p>
        </div>
        {microphoneWarning && (
          // Ordinary, small, no color — per G 2026-04-25.
          <div className="mt-2 px-3 py-1 text-xs text-white/70 text-center">
            {microphoneWarning}
          </div>
        )}
        {/* {isAnalyzingImage && (
          <div className="mt-4 bg-blue-500 text-white px-4 py-2 rounded-md max-w-2xl text-center">
            <p className="font-semibold">🔄 Analyzing image...</p>
          </div>
        )}
        {imageAnalysis && !isAnalyzingImage && (
          <div className="mt-4 bg-green-500 text-white px-4 py-2 rounded-md max-w-2xl text-center">
            <p className="font-semibold">✅ Image analyzed successfully</p>
          </div>
        )} */}
      </div>

      {/* Full screen video */}
      <div
        className={`relative w-full flex-1 flex items-center justify-center ${isCameraActive ? "pt-24" : ""}`}
      >
        {/* Avatar video - full screen when camera inactive, small overlay in left corner when active */}
        <video
          ref={videoRef}
          autoPlay // Native autoplay
          playsInline
          preload="auto"
          muted={true} // Start muted to prevent mouth movement during loading
          className={`${
            isCameraActive
              ? "absolute top-24 left-4 w-24 h-44 object-contain z-20 rounded-lg border-2 border-white shadow-2xl"
              : "h-full w-full object-contain"
          }`}
        />

        {/* Loading overlay — persists until the avatar's video stream is
            actually ready (isStreamReady). Before 2026-04-24 the parent
            hid the Loading... spinner the moment a session token came
            back, but the HeyGen stream still needed a few seconds to
            paint, so users briefly saw a black screen. */}
        {!isStreamReady && !isCameraActive && (
          <div className="absolute inset-0 z-30 flex items-center justify-center bg-black">
            <div className="text-inset text-xl text-white/90">Loading...</div>
          </div>
        )}

        {mode === "FULL" && (
          <>
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleCameraChange}
            />
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*,video/*"
              className="hidden"
              onChange={handleFileChange}
            />
          </>
        )}

        {/* Camera Preview - full screen under header when active */}
        {isCameraActive && (
          <div className="absolute inset-0 pt-24 flex items-center justify-center z-10">
            {cameraAvailable === false && fallbackImagePreview ? (
              // Fallback image preview (default image from public folder)
              <div className="relative w-full h-full max-w-4xl max-h-[calc(100vh-8rem)] flex flex-col">
                <img
                  src={fallbackImagePreview}
                  alt="Fallback"
                  className="w-full h-full object-contain rounded-lg"
                />
                {/* <button
                  onClick={() => fallbackImageInputRef.current?.click()}
                  className="absolute top-4 right-4 bg-blue-600 text-white px-4 py-2 rounded-md z-40 hover:bg-blue-700 text-sm"
                >
                  Change Image
                </button> */}
                <input
                  ref={fallbackImageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFallbackImageChange}
                />
              </div>
            ) : cameraAvailable === false && !fallbackImagePreview ? (
              // Loading fallback image
              <div className="flex flex-col items-center justify-center w-full h-full max-w-4xl max-h-[calc(100vh-8rem)] bg-gray-900 rounded-lg p-8">
                <div className="text-center">
                  <p className="text-inset text-lg">Loading...</p>
                </div>
              </div>
            ) : fallbackImagePreview ? (
              // User uploaded image preview
              <div className="relative w-full h-full max-w-4xl max-h-[calc(100vh-8rem)] flex flex-col">
                <img
                  src={fallbackImagePreview}
                  alt="Uploaded preview"
                  className="w-full h-full object-contain rounded-lg"
                />
                <button
                  onClick={() => fallbackImageInputRef.current?.click()}
                  className="absolute top-4 right-4 bg-blue-600 text-white px-4 py-2 rounded-md z-40 hover:bg-blue-700 text-sm"
                >
                  Change Image
                </button>
                <input
                  ref={fallbackImageInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleFallbackImageChange}
                />
              </div>
            ) : (
              // Camera video preview
              <video
                ref={cameraPreviewRef}
                autoPlay
                playsInline
                className="max-h-[calc(100vh-6rem)] w-full object-contain"
              />
            )}
          </div>
        )}

        {/* Snapshot: photo capture + optional video record (same camera session) */}
        {isCameraActive && visionMode === "snapshot" && (
          <div className="fixed bottom-32 left-1/2 transform -translate-x-1/2 z-30 flex gap-4 items-center justify-center">
            <button
              type="button"
              onClick={() => void handleSnapPhoto()}
              disabled={
                isRecording ||
                isAnalyzingImage ||
                isProcessingCameraQuestion ||
                (!cameraStream && !fallbackImage)
              }
              className="btn-inset rounded-lg px-5 py-3 min-w-[8.5rem] min-h-[3.25rem] flex items-center justify-center gap-2 text-sm font-medium disabled:opacity-70"
              aria-label="Capture photo"
            >
              <Camera className="w-4.5 h-4.5" />
              Camera
            </button>
            {!isRecording ? (
              <button
                type="button"
                onClick={() => handleStartRecording()}
                disabled={!cameraStream || isAnalyzingImage}
                className="btn-inset rounded-lg px-5 py-3 min-w-[8.5rem] min-h-[3.25rem] flex items-center justify-center gap-2 text-sm font-medium disabled:opacity-70"
                aria-label="Record video"
              >
                <Video className="w-4.5 h-4.5" />
                Video
              </button>
            ) : (
              <button
                type="button"
                onClick={() => handleStopRecording()}
                className="btn-inset rounded-lg px-6 py-3 flex items-center justify-center text-sm font-semibold"
              >
                Stop Recording
              </button>
            )}
          </div>
        )}
      </div>

      {/* Fixed buttons at bottom - positioned relative to viewport */}
      {mode === "FULL" && (
        <>
          {/* <button
            className="fixed bottom-20 left-1/4 bg-white text-black px-6 py-3 rounded-md z-20 transform -translate-x-1/2 flex items-center justify-center gap-2"
            onClick={handleCameraClick}
          >
            📷 {isCameraActive ? "Close Camera" : "Camera"}
          </button>
          <button
            className="fixed bottom-20 right-1/4 bg-white text-black px-6 py-3 rounded-md z-20 transform translate-x-1/2 flex items-center justify-center gap-2"
            onClick={handleFileUploadClick}
          >
            📁 Upload
          </button> */}

          {/* Debug button - only visible in camera mode */}
          {/* {isCameraActive && (
            <button
              className="fixed bottom-20 left-1/2 bg-purple-600 text-white px-6 py-3 rounded-md z-20 transform -translate-x-1/2 flex items-center justify-center gap-2 hover:bg-purple-700 disabled:bg-gray-400 disabled:cursor-not-allowed"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log("Debug button onClick triggered", {
                  isProcessingCameraQuestion,
                  isAnalyzingImage,
                  isDebugProcessing: isDebugProcessingRef.current,
                  isCameraActive,
                  hasFallbackImage: !!fallbackImage
                });
                // Always call the handler - it will check internally if it should proceed
                handleDebugAnalysis().catch((error) => {
                  console.error("Error in handleDebugAnalysis:", error);
                });
              }}
              disabled={isProcessingCameraQuestion || isAnalyzingImage || isDebugProcessingRef.current}
            >
              {isAnalyzingImage || isDebugProcessingRef.current ? (
                <>🔄 Analyzing...</>
              ) : (
                <>🔍 Debug: Analyze Image</>
              )}
            </button>
          )} */}

          {/* Analyzing text for vision recognition in streaming mode - ONLY show when actually processing */}
          {/* Positioned above Stop button (bottom-16) with breathing room — bumped from bottom-28 to bottom-36 2026-04-25 per G */}
          {visionMode === "streaming" && isProcessingCameraQuestion && (
            <div className="fixed bottom-36 left-1/2 -translate-x-1/2 z-30">
              <p className="text-inset text-2xl font-semibold text-center drop-shadow-lg">
                <span className="inline-flex items-center">
                  Analyzing...
                </span>
              </p>
            </div>
          )}

          {visionMode !== "streaming" && !isCameraActive && (
            <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-[95%] max-w-7xl z-20 px-4 pb-2 flex flex-col items-center">
              {sessionState !== SessionState.DISCONNECTED &&
                !isAvatarTalking &&
                isStreamReady && (
                  <div className="mb-4 w-full flex items-center justify-center text-center">
                    <p className="text-inset drop-shadow-lg px-1 w-full max-w-none text-[1.05rem] sm:text-[1.2rem] font-semibold leading-tight">
                      {!isActive ? (
                        voiceStartAwaitingReady ? (
                          <span className="block">Starting…</span>
                        ) : (
                          <span className="block text-[1rem] sm:text-[1.1rem]">Tap Start to Begin</span>
                        )
                      ) : (
                        <>
                          <span className="block">Tell 6 What&apos;s Wrong</span>
                          <span className="block">
                            or <em>Show Him</em>
                          </span>
                        </>
                      )}
                    </p>
                  </div>
                )} 
              <div className="mx-auto w-full max-w-sm">
                <div className="grid grid-cols-2 gap-3 mb-2.5">
                  <button
                    type="button"
                    className="btn-inset py-2 px-2.5 rounded-md flex items-center justify-center text-sm font-medium whitespace-nowrap min-h-[2.75rem]"
                    disabled={
                      sessionState !== SessionState.CONNECTED ||
                      !isStreamReady ||
                      voiceStartAwaitingReady ||
                      (isLoading && !isActive)
                    }
                    onClick={() => void handleVoiceStartStop()}
                  >
                    {/* <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className={isActive ? "" : "text-[0.8em] leading-none"}
                      >
                        {isActive ? "⏹" : "▶"}
                      </span>
                      <span className={isActive ? "" : "-ml-0.5"}>
                        {isActive ? "Stop" : "Start"}
                      </span>
                    </span> */}
                    {isActive ? (
                      // Hollow (no fill-current) + slightly smaller. 2026-04-25 per G.
                      <Square
                        className="mr-1.5 w-3.5 h-3.5 shrink-0 text-white"
                        strokeWidth={2.5}
                        aria-hidden
                      />
                    ) : (
                      <Play
                        className="mr-1.5 w-3.5 h-3.5 shrink-0 text-white"
                        strokeWidth={2.5}
                        aria-hidden
                      />
                    )}
                    {isActive ? "Stop" : "Start"}
                  </button>
                  <button
                    type="button"
                    className="btn-inset py-2 px-2.5 rounded-md flex items-center justify-center text-sm font-medium whitespace-nowrap min-h-[2.75rem]"
                    onClick={async () => {
                      await unlockAudio();
                      handleGoLive();
                    }}
                  >
                    <Radio className="mr-1.5 w-4 h-4 shrink-0" aria-hidden />
                    Go Live
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-3 mb-2.5">
                  <button
                    type="button"
                    className="btn-inset py-2 px-2.5 rounded-md flex items-center justify-center text-sm font-medium whitespace-nowrap min-h-[2.75rem]"
                    onClick={async () => {
                      await unlockAudio();
                      void handleCameraClick();
                    }}
                  >
                    <Camera className="mr-1.5 w-4 h-4 shrink-0" aria-hidden />
                    Camera
                  </button>
                  <button
                    type="button"
                    className="btn-inset py-2 px-2.5 rounded-md flex items-center justify-center text-sm font-medium whitespace-nowrap min-h-[2.75rem]"
                    onClick={() => void handleGalleryClick()}
                  >
                    <Images className="mr-1.5 w-4 h-4 shrink-0" aria-hidden />
                    Gallery
                  </button>
                </div>
              </div>
              <div className="h-14 flex items-center justify-center">
                <Link
                  href="/terms"
                  target="_blank"
                  className="block text-center text-[10px] sm:text-[11px] text-white/55 hover:text-white/80 transition-colors whitespace-nowrap"
                >
                  © 2026 iSolveUrProblems.ai All Rights Reserved · Terms
                </Link>
              </div>
            </div>
          )}
        </>
      )}

      {/* Stop: exit Go Live / camera overlay (or end session when already on home) */}
      {(visionMode === "streaming" || isCameraActive) && (
        <>
          <div className="fixed bottom-16 left-1/2 -translate-x-1/2 w-[95%] max-w-7xl z-20 px-4">
            <div className="flex justify-center">
              <button
                className="btn-inset py-2.5 px-6 rounded-lg flex items-center justify-center text-lg font-medium whitespace-nowrap"
                onClick={async () => {
                  // Unlock audio on button click (user interaction)
                  await unlockAudio();
                  handleStopSession();
                }}
              >
                <span className="inline-flex items-center gap-1.5">
                  <Square
                    className="w-4 h-4 shrink-0 text-white fill-current"
                    aria-hidden
                  />
                  <span>Stop</span>
                </span>
              </button>
            </div>
          </div>
          <div className="fixed bottom-1 left-1/2 -translate-x-1/2 z-20">
            <Link
              href="/terms"
              target="_blank"
              className="block text-center text-[11px] sm:text-xs text-white/55 hover:text-white/80 transition-colors py-1"
            >
              Terms
            </Link>
          </div>
        </>
      )}
    </div>
  );
};

export const LiveAvatarSession: React.FC<{
  mode: "FULL" | "CUSTOM";
  sessionAccessToken: string;
  onSessionStopped: (opts?: SessionStoppedReason) => void;
  onExit?: () => void;
}> = ({ mode, sessionAccessToken, onSessionStopped, onExit }) => {
  return (
    <LiveAvatarContextProvider sessionAccessToken={sessionAccessToken}>
      <LiveAvatarSessionComponent
        mode={mode}
        onSessionStopped={onSessionStopped}
        onExit={onExit}
      />
    </LiveAvatarContextProvider>
  );
};
