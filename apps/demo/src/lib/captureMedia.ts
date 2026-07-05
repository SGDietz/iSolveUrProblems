// Fire-and-forget uploader for every image/video frame 6 is shown.
// Sends to /api/media/capture which stores in the isolve-media bucket and
// writes a row in media_events. Never awaits in a way that blocks the
// main flow — if this call fails, we log and move on.

export type MediaSource =
  | "camera_snapshot"
  | "video_recording"
  | "gallery_image"
  | "gallery_video"
  | "go_live_frame";

export interface CaptureMediaArgs {
  file: File | Blob;
  source: MediaSource;
  sessionId?: string | null;
  geminiAnalysis?: string | null;
  problem?: string | null;
  error?: string | null;
}

export async function captureMedia(args: CaptureMediaArgs): Promise<void> {
  try {
    const form = new FormData();
    // FormData + Blob needs a filename to register as a File on the server.
    const filename =
      args.file instanceof File ? args.file.name : `${args.source}.bin`;
    form.append("file", args.file, filename);
    form.append("source", args.source);
    if (args.sessionId) form.append("session_id", args.sessionId);
    if (args.geminiAnalysis) form.append("gemini_analysis", args.geminiAnalysis);
    if (args.problem) form.append("problem", args.problem);
    if (args.error) form.append("error", args.error);

    // NOTE: do NOT set keepalive: true here. Browsers cap keepalive request
    // bodies at 64KB per-origin and REJECT requests that would exceed the
    // quota — which silently killed every media upload in the first
    // deployment that shipped with it (2026-04-24). Frames run 80KB–2.5MB
    // so keepalive is unusable for this payload size. Tab-close durability
    // for large media is tracked as a separate follow-up (direct-to-storage
    // upload with a pre-signed Supabase URL).
    const res = await fetch("/api/media/capture", {
      method: "POST",
      body: form,
    });
    if (!res.ok) {
      // Don't throw — media capture is diagnostic, it must never block the
      // user-visible flow. Just log + breadcrumb and continue.
      console.warn("captureMedia: non-OK response", res.status);
      mediaCaptureBreadcrumb("media_capture_fail", {
        source: args.source,
        status: res.status,
        bytes: args.file instanceof File ? args.file.size : null,
        sessionId: args.sessionId ? String(args.sessionId).slice(0, 8) : null,
      });
    }
  } catch (err) {
    console.warn("captureMedia: request failed", err);
    mediaCaptureBreadcrumb("media_capture_error", {
      source: args.source,
      status: null,
      bytes: args.file instanceof File ? args.file.size : null,
      msg: (err instanceof Error ? err.message : String(err)).slice(0, 160),
      sessionId: args.sessionId ? String(args.sessionId).slice(0, 8) : null,
    });
  }
}

// Server-visible breadcrumb (Vercel fn logs) so a missing media_events row is
// explainable instead of silently lost (Herm 2026-06-30). Non-secret only.
function mediaCaptureBreadcrumb(
  step: string,
  extra: Record<string, unknown>,
): void {
  try {
    void fetch("/api/diag-account", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ step: `bc:${step}`, ...extra }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // best-effort; never throw from instrumentation
  }
}

/** Convert a base64 string (no prefix) to a Blob of the given mime. */
export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}
