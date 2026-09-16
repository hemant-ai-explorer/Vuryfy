import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runAudioDeepInvestigation, AUDIO_DEEP_ENGINE_VERSION, type AudioAnalysisResult } from "@/lib/audio-analysis";
import { normalizeClaim } from "@/lib/quick-check";
import { getUserLanguage } from "@/lib/user-language";
import {
  computeCacheKey,
  getCachedVerification,
  writeCache,
  AUDIO_CACHE_FRESHNESS,
  type CachedVerification,
} from "@/lib/verification-cache";

// Route-level execution budget (Sept 2026 fix — see app/api/deep/route.ts's
// comment for the full rationale: this was missing from every AI-calling
// route, not just video's). 60 is Hobby's max; without it Vercel's silent
// 10s default kill can cut off runAudioDeepInvestigation before it returns.
export const maxDuration = 60;

// Audio authenticity Deep Investigation — mirrors app/api/verify-audio/
// route.ts as closely as possible (see that file's header, and lib/
// audio-analysis.ts's header, for the full rationale). The only pipeline
// difference is which function it calls: runAudioDeepInvestigation uses
// the reasoning tier with a more thorough prompt rather than a second
// evidence-gathering pass — unlike image Deep Investigation, there is no
// reverse-audio-search provider to call here, so "deeper" means a slower,
// more careful listen to the same recording, not more AI calls or more
// evidence.
//
// Caching (added Sept 15, 2026, alongside verify-audio/route.ts — see that
// file's header for the full rationale): cache key uses
// AUDIO_DEEP_ENGINE_VERSION instead of the Quick Check version, so a Deep
// Investigation on a clip never serves a cached Quick Check result or vice
// versa, same separation the text pipeline already relies on.
//
// Sept 16, 2026 fast-follow: cache namespace is now language-aware — see
// app/api/verify-audio/route.ts's identical comment for the full rationale.
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
  const language = await getUserLanguage(admin, user.id);
  const audioCacheNamespace = language === "en" ? "audio" : `audio:${language}`;
  const cacheKey = computeCacheKey(`${audioBase64}|ctx:${context}`, audioCacheNamespace, AUDIO_DEEP_ENGINE_VERSION);

  const { data: remaining, error: rpcError } = await admin.rpc("decrement_deep_investigation", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[deep-audio] decrement_deep_investigation RPC failed:", rpcError);
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

  const cached = await getCachedVerification(admin, cacheKey);
  const cacheHit = cached !== null;

  let result: AudioAnalysisResult | CachedVerification;
  if (cached) {
    result = cached;
  } else {
    try {
      result = await runAudioDeepInvestigation(audioBase64, mimeType, context || null, language);
    } catch (err) {
      console.error("[deep-audio] pipeline failed (refunding credit):", err);

      const { error: refundError } = await admin.rpc("refund_deep_investigation", { p_user_id: user.id });
      if (refundError) {
        console.error("[deep-audio] refund_deep_investigation RPC ALSO failed:", refundError);
      }

      await admin.from("credit_transactions").insert([
        { user_id: user.id, credit_type: "deep_investigation", amount: -1, reason: "deep_investigation_reserved" },
        { user_id: user.id, credit_type: "deep_investigation", amount: 1, reason: "deep_investigation_refunded_infra_error" },
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
      mode: "deep",
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
    console.error("[deep-audio] verifications insert failed:", insertError);
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
    await writeCache(admin, cacheKey, verification.id, "[audio content]", AUDIO_CACHE_FRESHNESS);
  }

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: user.id,
    credit_type: "deep_investigation",
    amount: -1,
    reason: cacheHit ? "deep_investigation_completed_cache_hit" : "deep_investigation_completed",
    verification_id: verification.id,
  });
  if (txnError) {
    console.error("[deep-audio] credit_transactions insert failed:", txnError);
  }

  const { data: balance } = await admin
    .from("credit_balances")
    .select("quick_checks_remaining, deep_investigations_remaining")
    .eq("user_id", user.id)
    .single();

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
