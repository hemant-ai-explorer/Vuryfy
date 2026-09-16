import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runQuickCheck, normalizeClaim, ENGINE_VERSION, type QuickCheckResult } from "@/lib/quick-check";
import { runVideoQuickCheck, VIDEO_QUICK_ENGINE_VERSION, type VideoAnalysisResult } from "@/lib/video-analysis";
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
  checkSemanticCache,
  writeSemanticCache,
  AUDIO_CACHE_FRESHNESS,
  type CachedVerification,
} from "@/lib/verification-cache";

// Route-level execution budget — Sept 15, 2026: raised from 60s to 300s
// (Pro's generally-available default/max under Fluid compute) — see
// app/api/verify-video/route.ts's comment for the full rationale. This
// route runs two AI pipelines in parallel (text + video), so it's exposed
// to the same Storage-download/Gemini-upload latency as the video-only
// route, plus the text pipeline running alongside it — 300s covers both
// comfortably.
export const maxDuration = 300;

// Combined video Quick Check — mirrors app/api/verify-audio-combined/
// route.ts exactly, one level down (see that file's header for the full
// rationale: why one button runs both pipelines, the explicit 1-credit
// product decision despite two AI pipelines running, and the caching
// design). Built combined from the START for video — audio's original
// ship went through a separate "two buttons on one screen" bug and fix
// first; video learns from that directly instead of repeating it.
//
// Two verifications rows are still written — one input_type
// "video_transcript", one "video" — so each pipeline's own verdict
// vocabulary and history entry stay intact. Only the transcript row is
// credit_charged: true; the video row rides along on that single charge.
// The response bundles both under the optional `secondary` field that
// app/result/page.tsx already renders generically (built for audio, reused
// unchanged here).
//
// Sept 15, 2026: storage_path replaces video_base64 (see lib/video-file-
// pipeline.ts's header for the full rework). This route downloads the
// video from Storage ONCE (needed either way, since the video cache key is
// a hash of its own content), computes the video cache key from that hash,
// then — only on a video cache miss — uploads to Gemini's File API and
// runs the authenticity analysis in parallel with the (separately cached)
// text pipeline on the transcript. This is the terminal step for these
// bytes: deletes both the Supabase Storage object and the Gemini File API
// upload in a finally-equivalent cleanup, whether or not the request
// succeeded.
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
  const transcript: string = (body?.transcript ?? "").trim();
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
  if (transcript.length < 5) {
    return NextResponse.json(
      { error: "No usable transcript to combine — use the video-only check instead." },
      { status: 400 }
    );
  }
  if (transcript.length > 10000) {
    return NextResponse.json({ error: "Transcript is too long (10,000 character limit)." }, { status: 400 });
  }

  const admin = createAdminClient();
  const normalizedTranscript = normalizeClaim(transcript);
  const textCacheKey = computeCacheKey(normalizedTranscript, "video_transcript", ENGINE_VERSION);

  const { data: remaining, error: rpcError } = await admin.rpc("decrement_quick_check", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[verify-video-combined] decrement_quick_check RPC failed:", rpcError);
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
  let textResult: QuickCheckResult | CachedVerification;
  let videoResult: VideoAnalysisResult | CachedVerification;
  let videoCacheKey: string;
  let textCacheHit: boolean;
  let videoCacheHit: boolean;
  let textCachedAt: string | null = null;
  // Semantic-cache fallback for the TEXT/transcript half only (Part 11's
  // "Semantic" layer, Sept 16, 2026) — see app/api/verify/route.ts's
  // identical comment for the full rationale. Never applied to the video
  // half — that cache key is a content hash of the video bytes themselves,
  // not a "claim" with any meaningful semantic similarity to embed.
  let textCacheMatchType: "exact" | "semantic" | null = null;
  let textSemanticEmbedding: number[] | null = null;

  try {
    const { bytes, contentHash } = await downloadVideoFromStorage(admin, storagePath);
    videoCacheKey = computeCacheKey(`sha256:${contentHash}|ctx:${context}`, "video", VIDEO_QUICK_ENGINE_VERSION);

    const [textCached, videoCached] = await Promise.all([
      getCachedVerification(admin, textCacheKey),
      getCachedVerification(admin, videoCacheKey),
    ]);
    textCacheHit = textCached !== null;
    videoCacheHit = videoCached !== null;
    textCachedAt = textCached?.cached_at ?? null;
    textCacheMatchType = textCacheHit ? "exact" : null;

    let textSemanticMatch: CachedVerification | null = null;
    if (!textCached) {
      const semantic = await checkSemanticCache(admin, normalizedTranscript, "video_transcript", ENGINE_VERSION);
      textSemanticEmbedding = semantic.embedding;
      textSemanticMatch = semantic.match;
      if (textSemanticMatch) {
        textCacheHit = true;
        textCacheMatchType = "semantic";
        textCachedAt = textSemanticMatch.cached_at;
      }
    }

    const [freshText, freshVideo] = await Promise.all([
      textCached || textSemanticMatch ? Promise.resolve(null) : runQuickCheck(transcript),
      videoCached
        ? Promise.resolve(null)
        : (async () => {
            const geminiFile = await uploadDownloadedVideoToGemini(bytes, mimeType);
            geminiFileName = geminiFile.name;
            return runVideoQuickCheck(geminiFile.fileUri, mimeType, context || null);
          })(),
    ]);
    textResult = textCached ?? textSemanticMatch ?? (freshText as QuickCheckResult);
    videoResult = videoCached ?? (freshVideo as VideoAnalysisResult);
  } catch (err) {
    console.error("[verify-video-combined] pipeline failed (refunding credit):", err);

    const { error: refundError } = await admin.rpc("refund_quick_check", { p_user_id: user.id });
    if (refundError) {
      console.error("[verify-video-combined] refund_quick_check RPC ALSO failed:", refundError);
    }

    await admin.from("credit_transactions").insert([
      { user_id: user.id, credit_type: "quick_check", amount: -1, reason: "quick_check_reserved" },
      { user_id: user.id, credit_type: "quick_check", amount: 1, reason: "quick_check_refunded_infra_error" },
    ]);

    // Sept 15, 2026 bug fix: see app/api/verify-video/route.ts's identical
    // comment — deleting the Storage object on every failure (transient
    // Gemini timeouts/503s included) meant no "Try Again" could ever
    // actually work, confirmed via a real live test. Only the transient
    // Gemini file is cleaned up here now; the Storage object survives so a
    // real retry can reuse it.
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

  const claimTextForVideo = context || "[Video submitted for authenticity analysis]";

  const { data: transcriptRow, error: insertError1 } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      input_type: "video_transcript",
      claim_text: transcript,
      normalized_claim: normalizedTranscript,
      verdict: textResult.verdict,
      confidence: textResult.confidence,
      summary: textResult.summary,
      key_evidence: textResult.key_evidence,
      sources: textResult.sources,
      engine_version: textResult.engine_version,
      credit_charged: true,
    })
    .select()
    .single();

  if (insertError1 || !transcriptRow) {
    console.error("[verify-video-combined] transcript verifications insert failed:", insertError1);
    await cleanupVideoFile(admin, storagePath, geminiFileName, true);
    return NextResponse.json(
      { error: "Check ran but couldn't be saved. Please try again." },
      { status: 500 }
    );
  }

  const { data: videoRow, error: insertError2 } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      input_type: "video",
      claim_text: claimTextForVideo,
      normalized_claim: normalizeClaim(claimTextForVideo),
      verdict: videoResult.verdict,
      confidence: videoResult.confidence,
      summary: videoResult.summary,
      key_evidence: videoResult.key_evidence,
      sources: videoResult.sources,
      caveats: videoResult.caveats,
      engine_version: videoResult.engine_version,
      credit_charged: false,
    })
    .select()
    .single();

  if (insertError2 || !videoRow) {
    console.error("[verify-video-combined] video verifications insert failed:", insertError2);
  }

  if (!textCacheHit) {
    await writeCache(admin, textCacheKey, transcriptRow.id, transcript);
    if (textSemanticEmbedding) {
      await writeSemanticCache(
        admin,
        textSemanticEmbedding,
        "video_transcript",
        ENGINE_VERSION,
        transcriptRow.id,
        normalizedTranscript,
        transcript
      );
    }
  }
  if (!videoCacheHit && videoRow) {
    await writeCache(admin, videoCacheKey, videoRow.id, "[video content]", AUDIO_CACHE_FRESHNESS);
  }

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: user.id,
    credit_type: "quick_check",
    amount: -1,
    reason:
      textCacheHit && textCacheMatchType === "semantic"
        ? "quick_check_completed_combined_video_semantic"
        : "quick_check_completed_combined_video",
    verification_id: transcriptRow.id,
  });
  if (txnError) {
    console.error("[verify-video-combined] credit_transactions insert failed:", txnError);
  }

  const { data: balance } = await admin
    .from("credit_balances")
    .select("quick_checks_remaining, deep_investigations_remaining")
    .eq("user_id", user.id)
    .single();

  await cleanupVideoFile(admin, storagePath, geminiFileName, true);

  return NextResponse.json({
    id: transcriptRow.id,
    mode: "quick",
    claim: transcriptRow.claim_text,
    verdict: transcriptRow.verdict,
    confidence: transcriptRow.confidence,
    explanation: transcriptRow.summary,
    evidence: transcriptRow.key_evidence,
    sources: transcriptRow.sources,
    cached: textCacheHit,
    cached_at: textCacheHit ? textCachedAt : null,
    secondary: videoRow
      ? {
          id: videoRow.id,
          eyebrow: "THE VIDEO ITSELF",
          verdict: videoRow.verdict,
          confidence: videoRow.confidence,
          explanation: videoRow.summary,
          caveats: videoRow.caveats,
        }
      : null,
    credits: {
      quick_checks: balance?.quick_checks_remaining ?? 0,
      deep_investigations: balance?.deep_investigations_remaining ?? 0,
      total: (balance?.quick_checks_remaining ?? 0) + (balance?.deep_investigations_remaining ?? 0),
    },
  });
}
