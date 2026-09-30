import type { SupabaseClient } from "@supabase/supabase-js";
import { apiFetch } from "@/lib/api-fetch";

// Client-side upload for video input — reworked Sept 15, 2026 after a real
// user request for 3-5+ minute video support, which the original "read
// the file, base64-encode it, POST it as JSON" approach could never
// accommodate: Vercel Serverless Functions cap the incoming request body
// at 4.5MB on every plan, a hard platform limit that cannot be raised (see
// architecture-decisions.md's Sept 2026 video entries for the full 413
// investigation this replaces).
//
// The fix: the browser now uploads the video file DIRECTLY to Supabase
// Storage using a short-lived signed upload URL (see app/api/video-
// upload-url/route.ts), completely bypassing this Next.js app's own
// request handling — the file never touches a Vercel function body at
// all. The server then downloads the bytes from Storage itself (an
// outbound fetch, not an inbound request — no 4.5MB limit applies there)
// and re-uploads them to Gemini's File API for analysis (see lib/video-
// file-pipeline.ts and lib/gemini-file-upload.ts).
//
// MAX_BYTES here matches the bucket's file_size_limit in supabase/
// migrations/0009_temp_video_storage.sql — kept as a fast client-side
// reject before even attempting the upload, though Supabase Storage would
// also refuse an oversized upload server-side regardless. IMPORTANT: the
// migration's own header explains a real caveat worth repeating here —
// Supabase's Storage global limit is plan-based and NEVER exceedable
// beyond it (50MB, hard, on the Free plan), so this 250MB client-side
// check can still be rejected by Storage itself if vuryfy-test/
// vuryfy-prod are on a Supabase plan with a lower global limit than what
// this app assumes.
const MAX_BYTES = 250 * 1024 * 1024; // 250MB raw — comfortably fits several minutes of typical phone-camera video

export interface UploadedVideo {
  storagePath: string;
  mimeType: string;
}

export class VideoUploadError extends Error {}

export async function uploadVideoToStorage(file: File, supabase: SupabaseClient): Promise<UploadedVideo> {
  if (file.size > MAX_BYTES) {
    throw new VideoUploadError(
      "That video is too large — the current limit is 250MB. Try a shorter clip or a more compressed export."
    );
  }
  const mimeType = file.type || "video/mp4";

  // Bug fixed Sept 30 2026: this called a plain fetch("/api/video-upload-url")
  // instead of apiFetch(...) — a relative path that's fine on the web app
  // (same-origin) but resolves against the Capacitor app's own bundled-local
  // origin on the native app, which has no /api/* routes at all (see
  // scripts/build-capacitor.js). Unlike lib/decode-image-text.ts's identical
  // mistake, this one fails loud (throws VideoUploadError below), so on the
  // native app every video Quick Check/Deep Investigation would have failed
  // immediately at the upload step. Found and fixed alongside that OCR bug
  // once the same missing-apiFetch pattern was searched for across the repo.
  const tokenResponse = await apiFetch("/api/video-upload-url", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mime_type: mimeType }),
  });
  const tokenData = await tokenResponse.json().catch(() => null);
  if (!tokenResponse.ok || !tokenData) {
    throw new VideoUploadError(tokenData?.error || "Could not prepare the upload. Please try again.");
  }

  const { error } = await supabase.storage
    .from("temp-video-uploads")
    .uploadToSignedUrl(tokenData.storage_path, tokenData.token, file, { contentType: mimeType });

  if (error) {
    throw new VideoUploadError("Couldn't upload that video. Please try again.");
  }

  return { storagePath: tokenData.storage_path, mimeType };
}

// Best-effort cleanup when the user abandons a video after the free
// transcribe step without ever running a check (see supabase/migrations/
// 0009_temp_video_storage.sql's header: there's deliberately no scheduled
// cleanup job for this in V1, so the client offers this courtesy delete
// wherever it reasonably can — e.g. when the user picks "Choose another").
// Fails silently; this is a nice-to-have, never something that should
// block the UI or surface an error to the user.
export async function deleteUploadedVideo(storagePath: string, supabase: SupabaseClient): Promise<void> {
  try {
    await supabase.storage.from("temp-video-uploads").remove([storagePath]);
  } catch {
    // best-effort — ignored
  }
}
