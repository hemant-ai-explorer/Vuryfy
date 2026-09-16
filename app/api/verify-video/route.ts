import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runVideoQuickCheck, VIDEO_QUICK_ENGINE_VERSION, type VideoAnalysisResult } from "@/lib/video-analysis";
import { normalizeClaim } from "@/lib/quick-check";
import { getUserLanguage } from "@/lib/user-language";
import {
  downloadVideoFromStorage,
  uploadDownloadedVideoToGemini,
  cleanupVideoFile,
  VideoStorageError,
} from "@/lib/video-file-pipeline";
import {
  computeCacheKey,
  getCachedVerification,
  writeCache,
  AUDIO_CACHE_FRESHNESS,
  type CachedVerification,
} from "@/lib/verification-cache";

// Route-level execution budget — Sept 15, 2026: raised from 60s to 300s
// (Pro's generally-available default/max under Fluid compute) now that
// video supports multi-minute clips via direct-to-storage upload +
// Gemini's File API rather than a small inline payload (see lib/video-
// file-pipeline.ts, lib/gemini-file-upload.ts, and supabase/migrations/
// 0009_temp_video_storage.sql for the full rework).
export const maxDuration = 300;

// Video authenticity Quick Check — mirrors app/api/verify-audio/route.ts as
// closely as possible (see that file's header, and app/api/verify-image/
// route.ts before it, for the full rationale on the credit pattern and
// media retention — all identical here, just video instead of audio).
//
// The OTHER half of video input — the transcript — does NOT come through
// here. It goes through the free /api/transcribe-video preview step, then
// reuses /api/verify directly with input_type: "video_transcript", exactly
// like OCR/audio_transcript reuse /api/verify. This route exists only for
// the video itself.
//
// Reuses AUDIO_CACHE_FRESHNESS (verification-cache.ts) rather than adding
// a video-specific constant — the reasoning is identical (a fixed-content
// media file doesn't go stale the way a text claim about current events
// does, and the 14-day TTL is just as reasonable a default here as it is
// for audio), so a separate constant would only be duplication.
//
// Sept 15, 2026: storage_path replaces video_base64 (see lib/video-file-
// pipeline.ts's header for the full rework). The cache key now hashes the
// raw video bytes (sha256, computed while downloading from Storage) rather
// than a base64 string of them — same exact-match idea, computed off
// content already in memory anyway. A cache hit skips the Gemini File API
// upload + analysis call entirely (only the Storage download still
// happens, since the content hash can only come from the actual bytes).
// This route is the terminal step for these bytes on the "video itself"
// path — it deletes BOTH the Supabase Storage object and the Gemini File
// API upload in a finally block, whether or not the request succeeded.
//
// Sept 16, 2026 fast-follow: cache namespace is now language-aware (same
// pattern as app/api/verify/route.ts) — the video bytes are the same
// regardless of viewer language, but the returned summary/caveats text
// differs by language, so a plain "video" namespace would let a Hindi
// user get back an English-cached result (or vice versa). English keeps
// the original, un-suffixed namespace so existing cache entries still hit.
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
  const context: string = (body?.context ?? "").trim().slice(0, 500);

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
  const language = await getUserLanguage(admin, user.id);
  const videoCacheNamespace = language === "en" ? "video" : `video:${language}`;

  const { data: remaining, error: rpcError } = await admin.rpc("decrement_quick_check", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[verify-video] decrement_quick_check RPC failed:", rpcError);
    return NextResponse.json(
      { error: "Could not check your credit balance. Please try again." },
      { status: 500 }
    );
  }

  if (remaining === null || remaining === undefined) {
    return NextResponse.json(
      { error: "You're out of Quick Check credits. Upgrade your plan to continue." },
      { status: 402 }
    );
  }

  let geminiFileName: string | undefined;
  let result: VideoAnalysisResult | CachedVerification;
  let cacheKey: string;
  let cacheHit: boolean;

  try {
    const { bytes, contentHash } = await downloadVideoFromStorage(admin, storagePath);
    cacheKey = computeCacheKey(`sha256:${contentHash}|ctx:${context}`, videoCacheNamespace, VIDEO_QUICK_ENGINE_VERSION);

    const cached = await getCachedVerification(admin, cacheKey);
    cacheHit = cached !== null;

    if (cached) {
      result = cached;
    } else {
      const geminiFile = await uploadDownloadedVideoToGemini(bytes, mimeType);
      geminiFileName = geminiFile.name;
      result = await runVideoQuickCheck(geminiFile.fileUri, mimeType, context || null, language);
    }
  } catch (err) {
    console.error("[verify-video] pipeline failed (refunding credit):", err);

    const { error: refundError } = await admin.rpc("refund_quick_check", { p_user_id: user.id });
    if (refundError) {
      console.error("[verify-video] refund_quick_check RPC ALSO failed:", refundError);
    }

    await admin.from("credit_transactions").insert([
      { user_id: user.id, credit_type: "quick_check", amount: -1, reason: "quick_check_reserved" },
      { user_id: user.id, credit_type: "quick_check", amount: 1, reason: "quick_check_refunded_infra_error" },
    ]);

    // Sept 15, 2026 bug fix: this used to pass deleteStorage=true here too,
    // deleting the Storage object on ANY failure — including a transient
    // Gemini timeout/503 that has nothing wrong with the uploaded video
    // itself. That meant the very first failed attempt permanently
    // destroyed the upload, so every subsequent "Try Again" click (the
    // route's own error message!) was guaranteed to fail with "That upload
    // could not be found" — confirmed via a real live test that hit exactly
    // this sequence. Only the transient Gemini File API upload is cleaned
    // up here now; the Storage object survives a failed attempt so a real
    // retry can reuse it without asking the browser to re-upload the whole
    // file. It's still deleted on eventual success (see below) or via the
    // client's own best-effort delete on "Choose another" — an abandoned
    // failed upload isn't orphaned forever, just not destroyed on the first
    // hiccup.
    const isStorageError = err instanceof VideoStorageError;
    await cleanupVideoFile(admin, storagePath, geminiFileName, false);
    return NextResponse.json(
      {
        error: isStorageError ? err.message : "Try Again",
        ...(process.env.NODE_ENV !== "production" && !isStorageError
          ? { debug: { message: err instanceof Error ? err.message : String(err) } }
          : {}),
      },
      { status: isStorageError ? 400 : 502 }
    );
  }

  const claimText = context || "[Video submitted for authenticity analysis]";

  const { data: verification, error: insertError } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      mode: "quick",
      input_type: "video",
      claim_text: claimText,
      normalized_claim: normalizeClaim(claimText),
      verdict: result.verdict,
      confidence: result.confidence,
      summary: result.summary,
      key_evidence: result.key_evidence,
      sources: result.sources,
      caveats: result.caveats,
      engine_version: result.engine_version,
      credit_charged: true,
    })
    .select()
    .single();

  if (insertError || !verification) {
    console.error("[verify-video] verifications insert failed:", insertError);
    await cleanupVideoFile(admin, storagePath, geminiFileName, true);
    return NextResponse.json(
      {
        error: "Analysis ran but couldn't be saved. Please try again.",
        ...(process.env.NODE_ENV !== "production" && insertError
          ? { debug: { message: insertError.message, details: insertError.details, hint: insertError.hint, code: insertError.code } }
          : {}),
      },
      { status: 500 }
    );
  }

  if (!cacheHit) {
    await writeCache(admin, cacheKey, verification.id, "[video content]", AUDIO_CACHE_FRESHNESS);
  }

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: user.id,
    credit_type: "quick_check",
    amount: -1,
    reason: cacheHit ? "quick_check_completed_cache_hit" : "quick_check_completed",
    verification_id: verification.id,
  });
  if (txnError) {
    console.error("[verify-video] credit_transactions insert failed:", txnError);
  }

  const { data: balance } = await admin
    .from("credit_balances")
    .select("quick_checks_remaining, deep_investigations_remaining")
    .eq("user_id", user.id)
    .single();

  await cleanupVideoFile(admin, storagePath, geminiFileName, true);

  return NextResponse.json({
    id: verification.id,
    mode: "quick",
    claim: verification.claim_text,
    verdict: verification.verdict,
    confidence: verification.confidence,
    explanation: verification.summary,
    evidence: verification.key_evidence,
    sources: verification.sources,
    caveats: verification.caveats,
    cached: cacheHit,
    cached_at: cacheHit ? (result as CachedVerification).cached_at : null,
    credits: {
      quick_checks: balance?.quick_checks_remaining ?? 0,
      deep_investigations: balance?.deep_investigations_remaining ?? 0,
      total: (balance?.quick_checks_remaining ?? 0) + (balance?.deep_investigations_remaining ?? 0),
    },
  });
}
