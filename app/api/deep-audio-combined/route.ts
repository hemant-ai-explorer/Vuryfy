import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runDeepInvestigation, DEEP_ENGINE_VERSION, type DeepInvestigationResult } from "@/lib/deep-investigation";
import { normalizeClaim } from "@/lib/quick-check";
import { runAudioDeepInvestigation, AUDIO_DEEP_ENGINE_VERSION, type AudioAnalysisResult } from "@/lib/audio-analysis";
import { getUserLanguage } from "@/lib/user-language";
import { translate } from "@/lib/translations";
import { checkContentSafety, ContentFlaggedError, hashBase64 } from "@/lib/content-safety";
import { track } from "@/lib/analytics";
import {
  computeCacheKey,
  getCachedVerification,
  writeCache,
  checkSemanticCache,
  writeSemanticCache,
  AUDIO_CACHE_FRESHNESS,
  type CachedVerification,
} from "@/lib/verification-cache";

// Route-level execution budget (Sept 2026 fix — see app/api/deep/route.ts's
// comment for the full rationale). This route runs two AI pipelines in
// parallel (text + audio), so it's exposed to Vercel's silent 10s default
// kill even more than most. 60 is Hobby's max.
export const maxDuration = 60;

// Combined audio Deep Investigation — mirrors app/api/verify-audio-combined/
// route.ts exactly (see that file's header for the full rationale: why
// this exists, the explicit product decision behind charging 1 Deep
// Investigation credit total rather than 2 even though two AI pipelines
// run, and the Sept 15, 2026 caching addition — credit charging is flat
// regardless of which half(s) hit cache). The only differences from the
// Quick Check version: the reasoning-tier pipelines (runDeepInvestigation,
// runAudioDeepInvestigation) and their own engine versions/cache
// namespaces, decrement_deep_investigation/refund_deep_investigation, and
// including caveats on the transcript row too (Deep Investigation's text
// pipeline produces caveats; Quick Check's doesn't — see
// app/api/deep/route.ts vs app/api/verify/route.ts for the same asymmetry
// elsewhere in the app).
//
// Sept 16, 2026 fast-follow: both cache namespaces are now language-aware
// — see app/api/verify-audio-combined/route.ts's identical comment.
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
  const transcript: string = (body?.transcript ?? "").trim();
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
  if (transcript.length < 5) {
    return NextResponse.json(
      { error: "No usable transcript to combine — use the audio-only check instead." },
      { status: 400 }
    );
  }
  if (transcript.length > 10000) {
    return NextResponse.json({ error: "Transcript is too long (10,000 character limit)." }, { status: 400 });
  }

  const admin = createAdminClient();

  // Analytics (Part 23, Sept 21, 2026) — see lib/analytics.ts's header.
  track(user.id, "verification_submitted", { mode: "deep", input_type: "audio_combined" });

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
      sourceRoute: "deep-audio-combined",
    });
  } catch (err) {
    if (err instanceof ContentFlaggedError) {
      return NextResponse.json({ error: "This content can't be processed." }, { status: 422 });
    }
    throw err;
  }

  const language = await getUserLanguage(admin, user.id);
  const textCacheNamespace = language === "en" ? "audio_transcript" : `audio_transcript:${language}`;
  const audioCacheNamespace = language === "en" ? "audio" : `audio:${language}`;
  const normalizedTranscript = normalizeClaim(transcript);
  const textCacheKey = computeCacheKey(normalizedTranscript, textCacheNamespace, DEEP_ENGINE_VERSION);
  const audioCacheKey = computeCacheKey(`${audioBase64}|ctx:${context}`, audioCacheNamespace, AUDIO_DEEP_ENGINE_VERSION);

  const { data: remaining, error: rpcError } = await admin.rpc("decrement_deep_investigation", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[deep-audio-combined] decrement_deep_investigation RPC failed:", rpcError);
    return NextResponse.json(
      { error: "Could not check your credit balance. Please try again." },
      { status: 500 }
    );
  }
  if (remaining === null || remaining === undefined) {
    track(user.id, "credits_exhausted", { mode: "deep", credit_type: "deep_investigation" });
    return NextResponse.json(
      { error: "You're out of Deep Investigation credits. Upgrade your plan to continue." },
      { status: 402 }
    );
  }

  const [textCached, audioCached] = await Promise.all([
    getCachedVerification(admin, textCacheKey),
    getCachedVerification(admin, audioCacheKey),
  ]);
  let textCacheHit = textCached !== null;
  const audioCacheHit = audioCached !== null;

  // Sept 17, 2026 fix: same null-dereference bug as
  // app/api/verify-audio-combined/route.ts (see that file's identical
  // comment) — textCacheHit can go true via the semantic-match branch
  // below while `textCached` itself stays null, so the old
  // `(textCached as CachedVerification).cached_at` in the response threw
  // on exactly that path. Tracking `textCachedAt` alongside textCacheHit
  // (same pattern app/api/deep-video-combined/route.ts already used)
  // fixes it here too.
  let textCachedAt: string | null = textCached?.cached_at ?? null;

  // Semantic-cache fallback for the TEXT/transcript half only — see
  // app/api/verify-audio-combined/route.ts's identical comment.
  let textCacheMatchType: "exact" | "semantic" | null = textCacheHit ? "exact" : null;
  let textSemanticEmbedding: number[] | null = null;
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

  let textResult: DeepInvestigationResult | CachedVerification;
  let audioResult: AudioAnalysisResult | CachedVerification;
  try {
    const [freshText, freshAudio] = await Promise.all([
      textCached || textSemanticMatch ? Promise.resolve(null) : runDeepInvestigation(transcript, language),
      audioCached ? Promise.resolve(null) : runAudioDeepInvestigation(audioBase64, mimeType, context || null, language, transcript),
    ]);
    textResult = textCached ?? textSemanticMatch ?? (freshText as DeepInvestigationResult);
    audioResult = audioCached ?? (freshAudio as AudioAnalysisResult);
  } catch (err) {
    console.error("[deep-audio-combined] pipeline failed (refunding credit):", err);

    const { error: refundError } = await admin.rpc("refund_deep_investigation", { p_user_id: user.id });
    if (refundError) {
      console.error("[deep-audio-combined] refund_deep_investigation RPC ALSO failed:", refundError);
    }

    await admin.from("credit_transactions").insert([
      { user_id: user.id, credit_type: "deep_investigation", amount: -1, reason: "deep_investigation_reserved" },
      { user_id: user.id, credit_type: "deep_investigation", amount: 1, reason: "deep_investigation_refunded_infra_error" },
    ]);

    track(user.id, "verification_failed", { mode: "deep", input_type: "audio_combined", reason: "infra_error" });

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

  const claimTextForAudio = context || "[Audio submitted for authenticity analysis]";

  const { data: transcriptRow, error: insertError1 } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      mode: "deep",
      input_type: "audio_transcript",
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
    .single();

  if (insertError1 || !transcriptRow) {
    console.error("[deep-audio-combined] transcript verifications insert failed:", insertError1);
    return NextResponse.json(
      { error: "Investigation ran but couldn't be saved. Please try again." },
      { status: 500 }
    );
  }

  const { data: audioRow, error: insertError2 } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      mode: "deep",
      input_type: "audio",
      claim_text: claimTextForAudio,
      normalized_claim: normalizeClaim(claimTextForAudio),
      verdict: audioResult.verdict,
      confidence: audioResult.confidence,
      summary: audioResult.summary,
      key_evidence: audioResult.key_evidence,
      sources: audioResult.sources,
      caveats: audioResult.caveats,
      engine_version: audioResult.engine_version,
      credit_charged: false,
    })
    .select()
    .single();

  if (insertError2 || !audioRow) {
    console.error("[deep-audio-combined] audio verifications insert failed:", insertError2);
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
  if (!audioCacheHit && audioRow) {
    await writeCache(admin, audioCacheKey, audioRow.id, "[audio content]", AUDIO_CACHE_FRESHNESS);
  }

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: user.id,
    credit_type: "deep_investigation",
    amount: -1,
    reason:
      textCacheHit && textCacheMatchType === "semantic"
        ? "deep_investigation_completed_combined_audio_semantic"
        : "deep_investigation_completed_combined_audio",
    verification_id: transcriptRow.id,
  });
  if (txnError) {
    console.error("[deep-audio-combined] credit_transactions insert failed:", txnError);
  }

  const { data: balance } = await admin
    .from("credit_balances")
    .select("quick_checks_remaining, deep_investigations_remaining")
    .eq("user_id", user.id)
    .single();

  track(user.id, "verification_completed", {
    mode: "deep",
    input_type: "audio_transcript",
    verdict: transcriptRow.verdict,
    cached: textCacheHit,
    credit_charged: true,
  });
  if (audioRow) {
    track(user.id, "verification_completed", {
      mode: "deep",
      input_type: "audio",
      verdict: audioRow.verdict,
      cached: audioCacheHit,
      credit_charged: false,
    });
  }

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
    secondary: audioRow
      ? {
          id: audioRow.id,
          eyebrow: translate(language, "result.eyebrowRecording"),
          verdict: audioRow.verdict,
          confidence: audioRow.confidence,
          explanation: audioRow.summary,
          caveats: audioRow.caveats,
        }
      : null,
    credits: {
      quick_checks: balance?.quick_checks_remaining ?? 0,
      deep_investigations: balance?.deep_investigations_remaining ?? 0,
      total: (balance?.quick_checks_remaining ?? 0) + (balance?.deep_investigations_remaining ?? 0),
    },
  });
}
