"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
// import Image from "next/image";
import { LiveAvatarSession } from "./LiveAvatarSession";
import { Link } from "../i18n/routing";
import { rememberAnonymousSessionId } from "../lib/auth/AuthProvider";
export const LiveAvatarDemo = () => {
  const t = useTranslations("home");
  const [sessionToken, setSessionToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isExited, setIsExited] = useState(false);
  const sessionBootstrapRef = useRef(false);

  const startSession = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const res = await fetch("/api/start-session", {
        method: "POST",
      });
      if (!res.ok) {
        const err = await res.json();
        setError(err.error ?? t("failedToStart"));
        setIsLoading(false);
        return;
      }
      const { session_token, session_id } = await res.json();
      setSessionToken(session_token);
      // Stash the anonymous session_id so /api/auth/link-session can re-key
      // its rows to the user when they sign in (M1.1 anonymous → authed).
      if (session_id) rememberAnonymousSessionId(session_id);
      setIsLoading(false);
    } catch (err: unknown) {
      setError((err as Error).message);
      setIsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (isExited || sessionToken) {
      return;
    }
    if (sessionBootstrapRef.current) {
      return;
    }
    sessionBootstrapRef.current = true;
    void startSession();
  }, [isExited, sessionToken, startSession]);

  const onSessionStopped = (opts?: { reason?: "inactivity" | "explicit" }) => {
    sessionBootstrapRef.current = false;
    if (opts?.reason === "inactivity" || opts?.reason === "explicit") {
      // Explicit/voice close OR inactivity: show the existing Session Ended +
      // Restart surface instead of silently auto-restarting (which re-mints 6).
      setIsExited(true);
      setSessionToken("");
      return;
    }
    setSessionToken("");
  };

  // Helper function to try closing the tab with multiple methods
  const tryCloseTab = () => {
    if (typeof window === "undefined") return;

    // Try window.close() multiple times with different approaches
    try {
      window.close();
    } catch (e) {
      // Ignore
    }

    // Try self.close() (some browsers support this)
    try {
      (window as any).self?.close();
    } catch (e) {
      // Ignore
    }

    // Try top.close() if in iframe
    try {
      if (window.top && window.top !== window) {
        (window.top as any).close();
      }
    } catch (e) {
      // Ignore
    }
  };

  const handleExit = (completeExit: boolean = false) => {
    if (completeExit) {
      // Aggressively try to exit/close the tab on mobile
      if (typeof window !== "undefined") {
        // Detect if we're on mobile
        const isMobile =
          /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(
            navigator.userAgent,
          );

        // For mobile: Try multiple aggressive exit strategies
        if (isMobile) {
          // Strategy 1: Try window.close() immediately (works if opened by script)
          try {
            if (window.opener || window.history.length === 1) {
              window.close();
              // Give it a moment to close
              setTimeout(() => {
                // If still open, try other methods
                tryCloseTab();
              }, 100);
              return;
            }
          } catch (e) {
            // Fall through to other methods
          }

          // Strategy 2: Navigate to about:blank to minimize the page
          // This creates a blank page that's easy to close
          try {
            window.location.replace("about:blank");
            // Also try to close after navigation
            setTimeout(() => {
              try {
                window.close();
              } catch (e) {
                // Ignore - already on blank page
              }
            }, 100);
            return;
          } catch (e) {
            console.warn("Failed to navigate to about:blank:", e);
          }

          // Strategy 3: Try history.back() if available
          if (window.history.length > 1) {
            try {
              window.history.back();
              return;
            } catch (e) {
              // Continue to next strategy
            }
          }

          // Strategy 4: Navigate to referrer if available
          const referrer = document.referrer;
          if (
            referrer &&
            referrer !== window.location.href &&
            referrer !== ""
          ) {
            try {
              window.location.replace(referrer);
              return;
            } catch (e) {
              // Continue to final strategy
            }
          }

          // Strategy 5: Final fallback - Navigate to about:blank
          // This at least minimizes the page content
          try {
            window.location.replace("about:blank");
          } catch (e) {
            // Last resort: Show exit message
            setIsExited(true);
            setSessionToken("");
          }
        } else {
          // For desktop: Use standard navigation
          if (window.history.length > 1) {
            try {
              window.history.back();
              return;
            } catch (e) {
              // Fall through
            }
          }

          const referrer = document.referrer;
          if (
            referrer &&
            referrer !== window.location.href &&
            referrer !== ""
          ) {
            try {
              window.location.href = referrer;
              return;
            } catch (e) {
              // Fall through
            }
          }

          try {
            window.location.href = "/";
          } catch (e) {
            setIsExited(true);
            setSessionToken("");
          }
        }
      }
      return;
    }
    // Regular exit - show "Session Ended" message
    setIsExited(true);
    setSessionToken("");
  };

  if (isExited) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-4">
        <div className="text-inset text-2xl font-semibold">{t("sessionEnded")}</div>
        <div className="text-inset text-center text-lg opacity-90">
          {t("thankYou")}
        </div>
        <div className="text-inset text-center text-base opacity-90">
          {t("restartPrompt")}
        </div>
        <button
          type="button"
          onClick={() => {
            setIsExited(false);
            sessionBootstrapRef.current = true;
            void startSession();
          }}
          className="btn-inset py-2.5 px-6 rounded-lg text-base font-medium"
        >
          {t("restart")}
        </button>
      </div>
    );
  }

  /*
  // Start screen (disabled — app bootstraps session automatically; restore this block to show landing UI)
  if (!sessionToken) {
    return (
      <div className="relative w-full h-full min-h-screen flex flex-col items-center justify-end overflow-hidden bg-black">
        <Image
          src="/startscreen.png"
          alt="Start screen"
          fill
          className="object-cover object-center"
          priority
          sizes="100vw"
        />
        <div className="absolute top-0 left-0 right-0 z-10 flex flex-col items-center pt-4 pb-2">
          <h1 className="text-white text-[1.35rem] sm:text-2xl font-bold tracking-tight">
            iSolveUrProblems.ai - beta
          </h1>
          <p className="text-white text-xs sm:text-[0.8125rem] font-medium mt-1 text-white/90">
            Your Home &amp; Garden Solution Center
          </p>
        </div>
        <div className="fixed bottom-40 left-1/2 -translate-x-1/2 w-[95%] max-w-7xl z-20 px-4">
          {error && (
            <div className="mb-3 max-w-xl mx-auto rounded-xl bg-black/55 px-5 py-4 backdrop-blur-sm border border-white/10">
              <p className="text-center text-white text-xl sm:text-2xl font-semibold leading-snug [text-shadow:0_2px_16px_rgba(0,0,0,0.9)]">
                {error}
              </p>
            </div>
          )}
          <div className="flex justify-center mb-4">
            <button
              type="button"
              onClick={startSession}
              disabled={isLoading}
              aria-label="To talk to this guy, tap this button"
              aria-busy={isLoading}
              className="btn-inset py-3 px-6 sm:px-8 rounded-lg flex flex-col items-center justify-center gap-1 max-w-[min(100%,20rem)] text-center"
            >
              {isLoading ? (
                <span className="text-xl font-medium">Starting…</span>
              ) : (
                <>
                  <span className="text-[11px] sm:text-xs font-normal text-white/75 leading-tight">
                    (Tap this button)
                  </span>
                  <span className="text-xl sm:text-2xl font-semibold leading-snug">
                    To talk to this guy
                  </span>
                </>
              )}
            </button>
          </div>
        </div>
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 w-[95%] max-w-7xl z-20 px-4">
          <Link
            href="/terms"
            className="block text-center text-[11px] sm:text-xs text-white/55 hover:text-white/80 transition-colors py-2"
          >
            © 2026 iSolveUrProblems.ai All Rights Reserved · Terms
          </Link>
        </div>
      </div>
    );
  }
  */

  if (!sessionToken) {
    return (
      <div className="w-full min-h-screen flex flex-col items-center justify-center gap-4 bg-black px-4">
        {error && (
          <div className="max-w-xl rounded-xl bg-black/55 px-5 py-4 backdrop-blur-sm border border-gold/20">
            <p className="text-center text-gold text-lg font-semibold leading-snug">
              {error}
            </p>
            <button
              type="button"
              onClick={() => {
                void startSession();
              }}
              className="mt-4 w-full btn-inset py-2 rounded-md text-sm font-medium"
            >
              {t("retry")}
            </button>
          </div>
        )}
        {!error && (
          <div className="text-inset text-xl">{t("loading")}</div>
        )}
        <Link
          href="/terms"
          className="fixed bottom-6 left-1/2 -translate-x-1/2 w-[95%] max-w-7xl block text-center text-[11px] sm:text-xs text-gold/60 hover:text-gold transition-colors py-2"
        >
          {t("footer")}
        </Link>
      </div>
    );
  }

  return (
    <LiveAvatarSession
      mode="FULL"
      sessionAccessToken={sessionToken}
      onSessionStopped={onSessionStopped}
      onExit={handleExit}
    />
  );
};
