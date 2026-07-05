import { getAppEventSessionId } from "../observability/clientEvents";

type IdleSchedulerWindow = Window &
  typeof globalThis & {
    requestIdleCallback?: (
      callback: () => void,
      options?: { timeout?: number },
    ) => number;
  };

/**
 * Push the save off the hot UI path (Herm TASK iPad-fixboard P0): on iPad the
 * signed-url POST + large blob PUT would otherwise race Safari's tight
 * media/memory path while the review clip is mounting. requestIdleCallback
 * when available, else a short timeout.
 */
function scheduleMediaSave(task: () => void): void {
  if (typeof window === "undefined") {
    task();
    return;
  }
  const w = window as IdleSchedulerWindow;
  if (typeof w.requestIdleCallback === "function") {
    w.requestIdleCallback(task, { timeout: 2500 });
    return;
  }
  window.setTimeout(task, 250);
}

/**
 * Fire-and-forget media persistence (G order 2026-07-02 night: "start
 * saving all pics and vids as standard"). Asks /api/media/save for a
 * one-shot signed URL into the PRIVATE session-media bucket, then PUTs the
 * blob straight to Storage. EVERY failure collapses to silence — a failed
 * save must never slow or break capture/analyze (house telemetry rule).
 */
export function saveSessionMedia(blob: Blob, kind: "photo" | "video"): void {
  try {
    scheduleMediaSave(() => {
      void (async () => {
        const res = await fetch("/api/media/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            kind,
            mime: blob.type || undefined,
            bytes: blob.size,
            session_id: getAppEventSessionId() ?? undefined,
          }),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { upload_url?: string };
        if (!data.upload_url) return;
        await fetch(data.upload_url, {
          method: "PUT",
          headers: {
            "Content-Type": blob.type || "application/octet-stream",
            "x-upsert": "false",
          },
          body: blob,
        });
      })().catch(() => {});
    });
  } catch {
    // Never let media persistence surface into the calling code path.
  }
}
