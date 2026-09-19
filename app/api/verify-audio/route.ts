import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runAudioQuickCheck, AUDIO_QUICK_ENGINE_VERSION, type AudioAnalysisResult } from "@/lib/audio-analysis";
import { normalizeClaim } from "@/lib/quick-check";
import { getUserLanguage } from "@/lib/user-language";
import { checkContentSafety, ContentFlaggedError, hashBase64 } from "@/lib/content-safety";
import {
  computeCacheKey,
  getCachedVerification,
  writeCache,
  AUDIO_CACHE_FRESHNESS,
  type CachedVerification,
} from "@/lib/verification-cache";

// Route-level execution budget (Sept 2026 fix — see app/api/deep/route.ts's
// comment for the full rationale). 60 is Hobby's max; without it Vercel's
// silent 10s default kill can cut off runAudioQuickCheck before it returns.
export const maxDuration = 60;

// Audio authenticity Quick Check — mirrors app/api/verify-image/route.ts as
// closely as possible (see that file's header for the full rationale on
// why this is a separate route, the credit pattern, and media retention —
// all identical here, just audio instead of image). Same
// separate-files-over-shared-handler reasoning applies.
//
// The OTHER half of audio input — the transcript — does NOT come through
// here. It goes through the free /api/transcribe-audio preview step, then
// reuses /api/verify directly with input_type: "audio_transcript", exactly
// like OCR reuses /api/verify with input_type: "ocr". This route exists
// only for the recording itself.
//
// Credit pattern: identical reserve-then-refund-on-infra-failure semantics
// as /api/verify-image, spending a Quick Check credit — audio authenticity
// analysis is still a Quick Check from the billing perspective, same
// principle as Part 26.4 addition #1 ("charge on completion, including a
// non-committal verdict — Inconclusive here plays the same role
// Unverified/Clean do for text").
//
// Caching (added Sept 15, 2026 — originally shipped uncached, see
// lib/audio-analysis.ts's older header comments for that history): reuses
// the exact-match cache from verification-cache.ts, keyed on a hash of the
// AUDIO CONTENT ITSELF (not a text claim) plus the optional context, so
// the identical file resubmitted later — a forwarded voice note, someone
// re-checking the same clip — skips the Gemini call entirely. A cache hit
// still charges the normal credit and still writes a fresh per-user
// verifications row, same "charge on completion, private history per
// user" rules as text caching. Uses AUDIO_CACHE_FRESHNESS rather than
// classifyFreshness() — that classifier's keyword regexes are meaningless
// against raw audio content (see verification-cache.ts's comment on this).
//
// Sept 16, 2026 fast-follow: cache namespace is now language-aware (same
// pattern as app/api/verify/route.ts) — the audio bytes are the same
// regardless of viewer language, but the returned summary/caveats text
// differs by language. English keeps the original, un-suffixed namespace
// so existing cache entries still hit.
const ALLOWED_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/ogg",
  "audio/webm",
  "audio/m4a",
  "audio/mp4",
  "audio/aac",
  "audio/flac",
  "audio/3gpp",
]);
const MAX_BASE64_LENGTH = 20_000_000;

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const audioBase64: string = body?.audio_base64 ?? "";
  const mimeType: string = body?.mime_type ?? "";
  const context: string = (body?.context ?? "").trim().slice(0, 500);

  if (!audioBase64) {
    return NextResponse.json({ error: "No audio was provided." }, { status: 400 });
  }
  if (audioBase64.length > MAX_BASE64_LENGTH) {
    return NextResponse.json({ error: "That audio file is too large. Try a shorter clip." }, { status: 400 });
  }
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return NextResponse.json({ error: "Unsupported audio type." }, { status: 400 });
  }

  const admin = createAdminClient();

  // Content safety (Part 15, Sept 19, 2026) — scan before any credit is
  // charged or the audio reaches an AI provider. See lib/content-safety.ts's
  // file header (currently a stub; no real hash-matching provider is wired
  // in yet).
  try {
    await checkContentSafety({
      admin,
      userId: user.id,
      contentType: "audio",
      contentHash: hashBase64(audioBase64),
      sourceRoute: "verify-audio",
    });
  } catch (err) {
    if (err instanceof ContentFlaggedError) {
      return NextResponse.json({ error: "This content can't be processed." }, { status: 422 });
    }
    throw err;
  }

  const language = await getUserLanguage(admin, user.id);
  const audioCacheNamespace = language === "en" ? "audio" : `audio:${language}`;
  const cacheKey = computeCacheKey(`${audioBase64}|ctx:${context}`, audioCacheNamespace, AUDIO_QUICK_ENGINE_VERSION);

  const { data: remaining, error: rpcError } = await admin.rpc("decrement_quick_check", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[verify-audio] decrement_quick_check RPC failed:", rpcError);
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

  const cached = await getCachedVerification(admin, cacheKey);
  const cacheHit = cached !== null;

  let result: AudioAnalysisResult | CachedVerification;
  if (cached) {
    result = cached;
  } else {
    try {
      result = await runAudioQuickCheck(audioBase64, mimeType, context || null, language);
    } catch (err) {
      console.error("[verify-audio] pipeline failed (refunding credit):", err);

      const { error: refundError } = await admin.rpc("refund_quick_check", { p_user_id: user.id });
      if (refundError) {
        console.error("[verify-audio] refund_quick_check RPC ALSO failed:", refundError);
      }

      await admin.from("credit_transactions").insert([
        { user_id: user.id, credit_type: "quick_check", amount: -1, reason: "quick_check_reserved" },
        { user_id: user.id, credit_type: "quick_check", amount: 1, reason: "quick_check_refunded_infra_error" },
      ]);

      return NextResponse.json(
        {
          error: "Try Again",
          ...(process.env.NODE_ENV !== "production"
            ? { debug: { message: err instanceof Error ? err.message : String(err) } }
            : {}),
        },
        { status: 502 }
      );
    }
  }

  const claimText = context || "[Audio submitted for authenticity analysis]";

  const { data: verification, error: insertError } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      mode: "quick",
      input_type: "audio",
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
    console.error("[verify-audio] verifications insert failed:", insertError);
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
    await writeCache(admin, cacheKey, verification.id, "[audio content]", AUDIO_CACHE_FRESHNESS);
  }

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: user.id,
    credit_type: "quick_check",
    amount: -1,
    reason: cacheHit ? "quick_check_completed_cache_hit" : "quick_check_completed",
    verification_id: verification.id,
  });
  if (txnError) {
    console.error("[verify-audio] credit_transactions insert failed:", txnError);
  }

  const { data: balance } = await admin
    .from("credit_balances")
    .select("quick_checks_remaining, deep_investigations_remaining")
    .eq("user_id", user.id)
    .single();

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
