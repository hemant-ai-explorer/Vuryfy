import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { uploadVideoToGemini, deleteGeminiFile, type GeminiFileRef } from "@/lib/gemini-file-upload";
import { checkContentSafety, ContentFlaggedError } from "@/lib/content-safety";

// Shared download-from-Supabase-Storage / upload-to-Gemini-File-API steps
// used identically by all 5 video routes (transcribe-video, verify-video,
// deep-video, verify-video-combined, deep-video-combined) — pulled out
// once rather than repeated 5 times, since the steps and error handling
// are identical regardless of which AI call happens afterward. See
// supabase/migrations/0009_temp_video_storage.sql and lib/gemini-file-
// upload.ts for why both hops exist.
//
// Split into two steps (download+hash, then upload-to-Gemini) rather than
// one combined function specifically so the 4 credit-charging routes can
// compute their cache key from the content hash and check cache BEFORE
// paying for a Gemini File API upload + analysis call — the Storage
// download is unavoidable either way (the content hash can only come from
// the actual bytes), but a cache hit still skips the far more expensive
// Gemini half entirely, same as the old inline-base64 cache design did.
//
// Content safety (Part 15, Sept 19, 2026): this is also the single choke
// point for the illegal-content-handling pipeline's video path — see
// lib/content-safety.ts's file header for the full design (it's currently
// a stub; no real hash-matching provider is connected yet). Checked here,
// right after computing the real content hash and BEFORE the Gemini File
// API upload below, so flagged video never reaches an AI provider and
// every one of the 5 video routes gets this for free rather than needing
// its own copy. Throws ContentFlaggedError (re-exported below) on a
// match — callers should catch it specifically and skip their normal
// "Try Again"/infra-error handling; see any video route's catch block for
// the pattern already wired in.
export { ContentFlaggedError };

export class VideoStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VideoStorageError";
  }
}

export interface DownloadedVideo {
  bytes: ArrayBuffer;
  contentHash: string; // sha256 of the raw bytes — used as the cache-key input instead of the old base64 string
}

export async function downloadVideoFromStorage(
  admin: SupabaseClient,
  storagePath: string,
  safety: { userId: string; sourceRoute: string }
): Promise<DownloadedVideo> {
  const { data: blob, error } = await admin.storage.from("temp-video-uploads").download(storagePath);
  if (error || !blob) {
    // Sept 15, 2026 diagnostic addition: the user-facing message below is
    // deliberately generic, but until now the ACTUAL Supabase Storage error
    // (permission denied, object genuinely missing, network error, etc.)
    // was silently discarded — making a real first-live-test failure
    // undiagnosable from server logs alone. Log it here so the next failure
    // (if any) is actually debuggable.
    console.error("[video-file-pipeline] Storage download failed:", {
      storagePath,
      error,
    });
    throw new VideoStorageError("That upload could not be found — please choose the video again.");
  }
  const bytes = await blob.arrayBuffer();
  const contentHash = createHash("sha256").update(Buffer.from(bytes)).digest("hex");

  // Storage path is recorded on the flag row (not deleted here on a flag —
  // see checkContentSafety's caller and cleanupVideoFile below) so the
  // object survives for the operator to review/report manually rather
  // than being destroyed the moment it's flagged.
  await checkContentSafety({
    admin,
    userId: safety.userId,
    contentType: "video",
    contentHash,
    sourceRoute: safety.sourceRoute,
    storagePath,
  });

  return { bytes, contentHash };
}

export async function uploadDownloadedVideoToGemini(bytes: ArrayBuffer, mimeType: string): Promise<GeminiFileRef> {
  return uploadVideoToGemini(bytes, mimeType);
}

// Cleanup after use — always called from a finally block at the route
// level, regardless of success or failure above it. geminiFileName is
// undefined on a cache hit (nothing was ever uploaded to Gemini) or if the
// pipeline failed before the Gemini upload completed — cleanupVideoFile
// handles that gracefully (no-op for the Gemini half). deleteStorage is
// false for the free transcribe step (see app/api/transcribe-video/
// route.ts's header: the object is kept for the follow-up paid check call
// to reuse) and true for every other video route (nothing further will
// need these bytes afterward). Also false whenever downloadVideoFromStorage
// threw ContentFlaggedError, same reasoning as the free-preview case:
// see each route's catch block, which passes deleteStorage=false on that
// path deliberately, so a flagged object is preserved rather than
// destroyed.
export async function cleanupVideoFile(
  admin: SupabaseClient,
  storagePath: string,
  geminiFileName: string | undefined,
  deleteStorage: boolean
): Promise<void> {
  if (geminiFileName) {
    await deleteGeminiFile(geminiFileName);
  }
  if (deleteStorage) {
    const { error } = await admin.storage.from("temp-video-uploads").remove([storagePath]);
    if (error) {
      console.error("[video-file-pipeline] failed to delete storage object:", error);
    }
  }
}
