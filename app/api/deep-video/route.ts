import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runVideoDeepInvestigation, VIDEO_DEEP_ENGINE_VERSION, type VideoAnalysisResult } from "@/lib/video-analysis";
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
// (Pro's generally-available default/max under Fluid compute) — see
// app/api/verify-video/route.ts's comment for the full rationale. Raised
// again the same day, 300s -> 450s, after a real live test against a
// genuine multi-minute video hit runVideoDeepInvestigation's own internal
// timeout (see lib/video-analysis.ts's comment on that function) — paired
// with that fix so the route's own ceiling doesn't cut the call off before
// its own (now-longer) timeout would. Still comfortably under Vercel Pro's
// 800s GA ceiling (no beta opt-in needed for anything <=800s).
export const maxDuration = 450;

// Video authenticity Deep Investigation — mirrors app/api/verify-video/
// route.ts exactly (see that file's header for the full rationale, and for
// the Sept 15, 2026 storage_path/content-hash-cache-key rework, and the
// Sept 16, 2026 language-aware cache namespace). Only differences from the
// Quick Check version: the reasoning-tier pipeline
// (runVideoDeepInvestigation), its own engine version/cache namespace, and
// decrement_deep_investigation/refund_deep_investigation — same asymmetry
// as every other Quick Check/Deep Investigation pair in this app.
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

  const { data: remaining, error: rpcError } = await admin.rpc("decrement_deep_investigation", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[deep-video] decrement_deep_investigation RPC failed:", rpcError);
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
  let result: VideoAnalysisResult | CachedVerification;
  let cacheKey: string;
  let cacheHit: boolean;

  try {
    const { bytes, contentHash } = await downloadVideoFromStorage(admin, storagePath);
    cacheKey = computeCacheKey(`sha256:${contentHash}|ctx:${context}`, videoCacheNamespace, VIDEO_DEEP_ENGINE_VERSION);

    const cached = await getCachedVerification(admin, cacheKey);
    cacheHit = cached !== null;

    if (cached) {
      result = cached;
    } else {
      const geminiFile = await uploadDownloadedVideoToGemini(bytes, mimeType);
      geminiFileName = geminiFile.name;
      result = await runVideoDeepInvestigation(geminiFile.fileUri, mimeType, context || null, language);
    }
  } catch (err) {
    console.error("[deep-video] pipeline failed (refunding credit):", err);

    const { error: refundError } = await admin.rpc("refund_deep_investigation", { p_user_id: user.id });
    if (refundError) {
      console.error("[deep-video] refund_deep_investigation RPC ALSO failed:", refundError);
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
      mode: "deep",
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
    console.error("[deep-video] verifications insert failed:", insertError);
    await cleanupVideoFile(admin, storagePath, geminiFileName, true);
    return NextResponse.json(
      {
        error: "Investigation ran but couldn't be saved. Please try again.",
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
    credit_type: "deep_investigation",
    amount: -1,
    reason: cacheHit ? "deep_investigation_completed_cache_hit" : "deep_investigation_completed",
    verification_id: verification.id,
  });
  if (txnError) {
    console.error("[deep-video] credit_transactions insert failed:", txnError);
  }

  const { data: balance } = await admin
    .from("credit_balances")
    .select("quick_checks_remaining, deep_investigations_remaining")
    .eq("user_id", user.id)
    .single();

  await cleanupVideoFile(admin, storagePath, geminiFileName, true);

  return NextResponse.json({
    id: verification.id,
    mode: "deep",
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
