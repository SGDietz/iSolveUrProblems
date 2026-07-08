"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Session, User } from "@supabase/supabase-js";
import { getSupabaseBrowser } from "./supabaseBrowser";
import { installClientLogger, setClientLoggerUser } from "../observability/clientLogger";

type AuthContextValue = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue>({
  user: null,
  session: null,
  loading: true,
  signOut: async () => {},
});

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  // Track previous user id so we only fire the anonymous-link call once
  // per sign-in transition.
  const lastLinkedRef = useRef<string | null>(null);

  useEffect(() => {
    // Install global error handlers exactly once for the app's lifetime.
    installClientLogger();

    const supabase = getSupabaseBrowser();

    // Initial fetch. Magic-link callbacks land via a full page navigation, so
    // the first authenticated state is often this initial getSession() result —
    // not an onAuthStateChange SIGNED_IN event. Drain stashed LiveAvatar session
    // ids here too, or the returned/phone session keeps user_id null until some
    // later auth event happens.
    void supabase.auth.getSession().then(({ data }) => {
      const nextSession = data.session;
      const nextUser = nextSession?.user ?? null;
      setSession(nextSession);
      setUser(nextUser);
      setLoading(false);
      setClientLoggerUser(nextUser?.id ?? null);
      if (nextUser?.id && lastLinkedRef.current !== nextUser.id) {
        lastLinkedRef.current = nextUser.id;
        void linkAnonymousSessions();
      }
    });

    // Subscribe to changes
    const { data: sub } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next);
      setUser(next?.user ?? null);

      // SIGNED_IN fires on both sign-in and token refresh; only act on
      // the first transition for a given user id.
      if (
        event === "SIGNED_IN" &&
        next?.user?.id &&
        lastLinkedRef.current !== next.user.id
      ) {
        lastLinkedRef.current = next.user.id;
        setClientLoggerUser(next.user.id);
        void linkAnonymousSessions();
      }
      if (event === "SIGNED_OUT") {
        lastLinkedRef.current = null;
        setClientLoggerUser(null);
      }
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, []);

  const signOut = useCallback(async () => {
    const supabase = getSupabaseBrowser();
    await supabase.auth.signOut();
  }, []);

  const value = useMemo(
    () => ({ user, session, loading, signOut }),
    [user, session, loading, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useUser() {
  return useContext(AuthContext);
}

/**
 * Drains any anonymous session ids stashed in localStorage and posts them
 * to /api/auth/link-session so server-side rows get re-keyed to the now-
 * authenticated user. Safe to call on every sign-in; the route is idempotent.
 */
async function linkAnonymousSessions() {
  if (typeof window === "undefined") return;
  const KEY = "isolve.anonymous.session_ids";
  let ids: string[] = [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) ids = JSON.parse(raw) as string[];
  } catch {
    return;
  }
  if (!Array.isArray(ids) || ids.length === 0) return;

  try {
    const res = await fetch("/api/auth/link-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_ids: ids }),
    });
    if (res.ok) {
      window.localStorage.removeItem(KEY);
    }
  } catch (e) {
    console.error("link-session failed", e);
  }
}

/**
 * Helper for the LiveAvatar session flow to record a new anonymous
 * session id in localStorage, so it can later be re-keyed on sign-in.
 */
export function rememberAnonymousSessionId(sessionId: string) {
  if (typeof window === "undefined" || !sessionId) return;
  const KEY = "isolve.anonymous.session_ids";
  try {
    const raw = window.localStorage.getItem(KEY);
    const ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    if (!ids.includes(sessionId)) {
      ids.push(sessionId);
      // Cap to last 20 to keep localStorage small.
      const trimmed = ids.slice(-20);
      window.localStorage.setItem(KEY, JSON.stringify(trimmed));
    }
  } catch {
    // ignore localStorage failures
  }
}
