import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { transcribeVideoSpeech } from "@/lib/video-transcript";
import {
  downloadVideoFromStorage,
  uploadDownloadedVideoToGemini,
  cleanupVideoFile,
  VideoStorageError,
  ContentFlaggedError,
} from "@/lib/video-file-pipeline";

// Route-level execution budget — Sept 15, 2026: raised from 60s to 300s
// (Pro's generally-available default/max under Fluid compute — confirmed
// current on the Vercel Functions docs the same day this changed) now
// that video supports multi-minute clips via direct-to-storage upload +
// Gemini's File API rather than a small inline payload (see lib/video-
// file-pipeline.ts, lib/gemini-file-upload.ts, and supabase/migrations/
// 0009_temp_video_storage.sql). Downloading a large file from Storage,
// re-uploading it to Gemini, and waiting for Gemini to process it all take
// real, size-dependent time now — 60s was comfortable margin for the old
// ~3MB clip cap but not for several minutes of video.
export const maxDuration = 300;

// Free preview step for video input's transcript sub-path — mirrors
// app/api/transcribe-audio/route.ts exactly (see that file's header for
// the full rationale on why transcription is kept free despite being a
// real AI call). Charges NO credit and writes NO verifications row — it
// only produces a transcript for the user to review (and edit) before
// deciding whether to spend a Quick Check or Deep Investigation credit
// checking it, via /api/verify or /api/deep with
// input_type: "video_transcript".
//
// Sept 15, 2026: takes a Supabase Storage path instead of inline base64
// (see the migration/pipeline files above for the full rework — driven by
// a real user request for 3-5+ minute video support, which the old ~3MB
// inline-body cap could never accommodate). This route deliberately does
// NOT delete the Storage object after use — the follow-up Quick Check/
// Deep Investigation call (verify-video-combined, deep-video-combined, or
// the video-only routes if no speech was found) reuses the SAME uploaded
// bytes rather than asking the browser to upload the whole file a second
// time. Those routes own deleting it from Storage.
//
// Sept 15, 2026 (same day): this route briefly moved off Gemini onto
// Deepgram (see lib/deepgram-transcript.ts's header for the full story),
// after three separate live Gemini 503s on this exact call in one testing
// session. That pilot was reverted the same day: Deepgram's nova-3 model
// produced a genuinely wrong transcript on real Hinglish content (not just
// imperfect — incoherent), which is a worse failure mode for a trust
// product than an occasional retry-able error. Back on Gemini here, now
// paired with lib/video-transcript.ts's fallback-model list (see
// ai-gateway.ts's StructuredCallParams) for real resilience against the
// 503s without sacrificing transcript quality. lib/deepgram-transcript.ts
// is left in the repo, unused, in case a different model/config is worth
// revisiting later.
const ALLOWED_MIME_TYPES = new Set([
  "video/mp4",
  "video/quicktime",
  "video/webm",
  "video/x-matroska",
  "video/3gpp",
  "video/x-msvideo",
]);

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const storagePath: string = body?.storage_path ?? "";
  const mimeType: string = body?.mime_type ?? "";

  if (!storagePath) {
    return NextResponse.json({ error: "No video was provided." }, { status: 400 });
  }
  if (!storagePath.startsWith(`${user.id}/`)) {
    return NextResponse.json({ error: "That upload doesn't belong to this account." }, { status: 403 });
  }
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return NextResponse.json({ error: "Unsupported video type." }, { status: 400 });
  }

  const admin = createAdminClient();
  let geminiFileName: string | undefined;

  try {
    const { bytes } = await downloadVideoFromStorage(admin, storagePath, {
      userId: user.id,
      sourceRoute: "transcribe-video",
    });
    const geminiFile = await uploadDownloadedVideoToGemini(bytes, mimeType);
    geminiFileName = geminiFile.name;
    const transcript = await transcribeVideoSpeech(geminiFile.fileUri, mimeType);
    return NextResponse.json({ transcript });
  } catch (err) {
    console.error("[transcribe-video] transcription failed:", err);
    const isStorageError = err instanceof VideoStorageError;
    // Content safety (Part 15, Sept 19, 2026) — see lib/content-safety.ts.
    if (err instanceof ContentFlaggedError) {
      return NextResponse.json({ error: "This content can't be processed." }, { status: 422 });
    }
    return NextResponse.json(
      {
        error: isStorageError ? err.message : "Try Again",
        ...(process.env.NODE_ENV !== "production" && !isStorageError
          ? { debug: { message: err instanceof Error ? err.message : String(err) } }
          : {}),
      },
      { status: isStorageError ? 400 : 502 }
    );
  } finally {
    await cleanupVideoFile(admin, storagePath, geminiFileName, false);
  }
}
