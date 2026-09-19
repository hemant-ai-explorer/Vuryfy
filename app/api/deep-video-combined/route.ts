import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runDeepInvestigation, DEEP_ENGINE_VERSION, type DeepInvestigationResult } from "@/lib/deep-investigation";
import { normalizeClaim } from "@/lib/quick-check";
import { runVideoDeepInvestigation, VIDEO_DEEP_ENGINE_VERSION, type VideoAnalysisResult } from "@/lib/video-analysis";
import { getUserLanguage } from "@/lib/user-language";
import { translate } from "@/lib/translations";
import { withRetryOnce } from "@/lib/db-retry";
import {
  downloadVideoFromStorage,
  uploadDownloadedVideoToGemini,
  cleanupVideoFile,
  VideoStorageError,
  ContentFlaggedError,
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
// app/api/verify-video/route.ts's comment for the full rationale. Raised
// again the same day, 300s -> 450s, after a real live test against a
// genuine multi-minute video hit runVideoDeepInvestigation's own internal
// timeout (see lib/video-analysis.ts's comment on that function) — paired
// with that fix so the route's own ceiling doesn't cut the call off before
// its own (now-longer) timeout would. Still comfortably under Vercel Pro's
// 800s GA ceiling (no beta opt-in needed for anything <=800s).
export const maxDuration = 450;

// Combined video Deep Investigation — mirrors app/api/deep-audio-combined/
// route.ts exactly, one level down (see app/api/verify-video-combined/
// route.ts and the audio combined routes for the full rationale). Only
// differences from the Quick Check version: the reasoning-tier pipelines
// (runDeepInvestigation, runVideoDeepInvestigation) and their own engine
// versions/cache namespaces, decrement_deep_investigation/
// refund_deep_investigation, and including caveats on the transcript row
// too (Deep Investigation's text pipeline produces caveats; Quick Check's
// doesn't).
//
// Sept 15, 2026: storage_path/content-hash-cache-key rework — see
// app/api/verify-video-combined/route.ts's header for the full rationale.
// Sept 16, 2026: both cache namespaces are now language-aware — see that
// same file's header for the full rationale.
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
  const language = await getUserLanguage(admin, user.id);
  const textCacheNamespace = language === "en" ? "video_transcript" : `video_transcript:${language}`;
  const videoCacheNamespace = language === "en" ? "video" : `video:${language}`;
  const normalizedTranscript = normalizeClaim(transcript);
  const textCacheKey = computeCacheKey(normalizedTranscript, textCacheNamespace, DEEP_ENGINE_VERSION);

  const { data: remaining, error: rpcError } = await admin.rpc("decrement_deep_investigation", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[deep-video-combined] decrement_deep_investigation RPC failed:", rpcError);
    return NextResponse.json(
      { error: "Could not check your credit balance. Please try again." },
      { status: 500 }
    );
  }
  if (remaining === null || remaining === undefined) {
    return NextResponse.json(
      { error: "You're out of Deep Investigation credits. Upgrade your plan to continue." },
      { status: 402 }
    );
  }

  let geminiFileName: string | undefined;
  let textResult: DeepInvestigationResult | CachedVerification;
  let videoResult: VideoAnalysisResult | CachedVerification;
  let videoCacheKey: string;
  let textCacheHit: boolean;
  let videoCacheHit: boolean;
  let textCachedAt: string | null = null;
  // Semantic-cache fallback for the TEXT/transcript half only — see
  // app/api/verify-video-combined/route.ts's identical comment.
  let textCacheMatchType: "exact" | "semantic" | null = null;
  let textSemanticEmbedding: number[] | null = null;

  try {
    const { bytes, contentHash } = await downloadVideoFromStorage(admin, storagePath, {
      userId: user.id,
      sourceRoute: "deep-video-combined",
    });
    videoCacheKey = computeCacheKey(`sha256:${contentHash}|ctx:${context}`, videoCacheNamespace, VIDEO_DEEP_ENGINE_VERSION);

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
      const semantic = await checkSemanticCache(admin, normalizedTranscript, textCacheNamespace, DEEP_ENGINE_VERSION);
      textSemanticEmbedding = semantic.embedding;
      textSemanticMatch = semantic.match;
      if (textSemanticMatch) {
        textCacheHit = true;
        textCacheMatchType = "semantic";
        textCachedAt = textSemanticMatch.cached_at;
      }
    }

    const [freshText, freshVideo] = await Promise.all([
      textCached || textSemanticMatch ? Promise.resolve(null) : runDeepInvestigation(transcript, language),
      videoCached
        ? Promise.resolve(null)
        : (async () => {
            const geminiFile = await uploadDownloadedVideoToGemini(bytes, mimeType);
            geminiFileName = geminiFile.name;
            return runVideoDeepInvestigation(geminiFile.fileUri, mimeType, context || null, language);
          })(),
    ]);
    textResult = textCached ?? textSemanticMatch ?? (freshText as DeepInvestigationResult);
    videoResult = videoCached ?? (freshVideo as VideoAnalysisResult);
  } catch (err) {
    console.error("[deep-video-combined] pipeline failed (refunding credit):", err);

    const { error: refundError } = await admin.rpc("refund_deep_investigation", { p_user_id: user.id });
    if (refundError) {
      console.error("[deep-video-combined] refund_deep_investigation RPC ALSO failed:", refundError);
    }

    await admin.from("credit_transactions").insert([
      { user_id: user.id, credit_type: "deep_investigation", amount: -1, reason: "deep_investigation_reserved" },
      { user_id: user.id, credit_type: "deep_investigation", amount: 1, reason: "deep_investigation_refunded_infra_error" },
    ]);

    // Sept 15, 2026 bug fix: see app/api/verify-video/route.ts's identical
    // comment — deleting the Storage object on every failure (transient
    // Gemini timeouts/503s included) meant no "Try Again" could ever
    // actually work, confirmed via a real live test. Only the transient
    // Gemini file is cleaned up here now; the Storage object survives so a
    // real retry can reuse it.
    const isStorageError = err instanceof VideoStorageError;
    // Content safety (Part 15, Sept 19, 2026) — see lib/content-safety.ts.
    const contentFlagged = err instanceof ContentFlaggedError;
    await cleanupVideoFile(admin, storagePath, geminiFileName, false);
    if (contentFlagged) {
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
  }

  const claimTextForVideo = context || "[Video submitted for authenticity analysis]";

  const { data: transcriptRow, error: insertError1 } = await withRetryOnce(
    (client) =>
      client
        .from("verifications")
        .insert({
          user_id: user.id,
          mode: "deep",
          input_type: "video_transcript",
          claim_text: transcript,
          normalized_claim: normalizedTranscript,
          verdict: textResult.verdict,
          confidence: textResult.confidence,
          summary: textResult.summary,
          key_evidence: textResult.key_evidence,
          sources: textResult.sources,
          caveats: textResult.caveats,
          engine_version: textResult.engine_version,
          credit_charged: true,
        })
        .select()
        .single(),
    admin
  );

  if (insertError1 || !transcriptRow) {
    console.error("[deep-video-combined] transcript verifications insert failed:", insertError1);
    await cleanupVideoFile(admin, storagePath, geminiFileName, true);
    return NextResponse.json(
      {
        error: "Investigation ran but couldn't be saved. Please try again.",
        ...(process.env.NODE_ENV !== "production" && insertError1
          ? {
              debug: {
                message: insertError1.message,
                details: insertError1.details,
                hint: insertError1.hint,
                code: insertError1.code,
              },
            }
          : {}),
      },
      { status: 500 }
    );
  }

  const { data: videoRow, error: insertError2 } = await withRetryOnce(
    (client) =>
      client
        .from("verifications")
        .insert({
          user_id: user.id,
          mode: "deep",
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
        .single(),
    admin
  );

  if (insertError2 || !videoRow) {
    console.error("[deep-video-combined] video verifications insert failed:", insertError2);
  }

  if (!textCacheHit) {
    await writeCache(admin, textCacheKey, transcriptRow.id, transcript);
    if (textSemanticEmbedding) {
      await writeSemanticCache(
        admin,
        textSemanticEmbedding,
        textCacheNamespace,
        DEEP_ENGINE_VERSION,
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
    credit_type: "deep_investigation",
    amount: -1,
    reason:
      textCacheHit && textCacheMatchType === "semantic"
        ? "deep_investigation_completed_combined_video_semantic"
        : "deep_investigation_completed_combined_video",
    verification_id: transcriptRow.id,
  });
  if (txnError) {
    console.error("[deep-video-combined] credit_transactions insert failed:", txnError);
  }

  const { data: balance } = await admin
    .from("credit_balances")
    .select("quick_checks_remaining, deep_investigations_remaining")
    .eq("user_id", user.id)
    .single();

  await cleanupVideoFile(admin, storagePath, geminiFileName, true);

  return NextResponse.json({
    id: transcriptRow.id,
    mode: "deep",
    claim: transcriptRow.claim_text,
    verdict: transcriptRow.verdict,
    confidence: transcriptRow.confidence,
    explanation: transcriptRow.summary,
    evidence: transcriptRow.key_evidence,
    sources: transcriptRow.sources,
    caveats: transcriptRow.caveats,
    cached: textCacheHit,
    cached_at: textCacheHit ? textCachedAt : null,
    secondary: videoRow
      ? {
          id: videoRow.id,
          eyebrow: translate(language, "result.eyebrowVideo"),
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
