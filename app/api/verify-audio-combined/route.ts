import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runQuickCheck, normalizeClaim, ENGINE_VERSION, type QuickCheckResult } from "@/lib/quick-check";
import { runAudioQuickCheck, AUDIO_QUICK_ENGINE_VERSION, type AudioAnalysisResult } from "@/lib/audio-analysis";
import { getUserLanguage } from "@/lib/user-language";
import { translate } from "@/lib/translations";
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

// Combined audio Quick Check — Sept 14, 2026 addition. The original ship
// offered the transcript fact-check and the audio-authenticity listen-
// through as two fully independent sub-paths, each with its own Quick
// Check / Deep Investigation buttons — meaning a recording with speech
// showed FOUR buttons (two labeled "Quick Check") on one screen. User
// feedback: confusing, and not what was wanted — one Quick Check button
// should run both and show both results together.
//
// Credit cost was an explicit product decision, not an engineering
// default: running two AI pipelines (text fact-check + audio listen-
// through) from one button press could reasonably cost 2 credits (one per
// pipeline actually run, consistent with the "charge on completion" rule
// everywhere else in the app), but the user chose 1 credit total —
// knowingly discounting the combined path relative to its real AI cost.
// So this route decrements decrement_quick_check() exactly ONCE, runs
// both pipelines, and only refunds that one credit if the pair fails.
// Credit charging is entirely independent of caching below — it's always
// exactly 1 credit regardless of which half(s) hit cache.
//
// Two verifications rows are still written — one input_type
// "audio_transcript", one "audio" — so each pipeline's own verdict
// vocabulary and history entry stay intact and comparable to a standalone
// check of either kind. Only the transcript row is credit_charged: true;
// the audio row is credit_charged: false since it didn't cause its own
// charge — it rode along on the transcript row's single credit. The
// response bundles both under an optional `secondary` field that
// app/result/page.tsx renders as a second, clearly labeled block on the
// same result screen (see that file for the rendering).
//
// Caching (added Sept 15, 2026 — originally shipped uncached; see the
// prior version of this comment for why "muddying the charge story" was
// the original worry). That worry is moot now that credit charging is
// flat (always 1 credit, see above) regardless of cache hits — so each
// half is cached independently and looked up in parallel BEFORE either
// pipeline runs, and only the half(s) that miss are actually computed:
//   - Text half: same exact-match cache as /api/verify, keyed on
//     (normalized transcript, input_type "audio_transcript", ENGINE_VERSION)
//     — a transcript identical to one already fact-checked (e.g. the same
//     quote forwarded as different audio files) skips the search+AI call.
//   - Audio half: keyed on a hash of the raw audio content + context (see
//     app/api/verify-audio/route.ts's header) — the identical audio file
//     resubmitted skips the Gemini listen-through.
// Both cache lookups are independent of the flat 1-credit charge — a
// double cache hit still costs 1 credit, same as a double cache miss.
//
// Sept 16, 2026 fast-follow: both cache namespaces ("audio_transcript" and
// "audio") are now language-aware, same pattern as app/api/verify/
// route.ts and app/api/verify-audio/route.ts respectively.
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
  const language = await getUserLanguage(admin, user.id);
  const textCacheNamespace = language === "en" ? "audio_transcript" : `audio_transcript:${language}`;
  const audioCacheNamespace = language === "en" ? "audio" : `audio:${language}`;
  const normalizedTranscript = normalizeClaim(transcript);
  const textCacheKey = computeCacheKey(normalizedTranscript, textCacheNamespace, ENGINE_VERSION);
  const audioCacheKey = computeCacheKey(`${audioBase64}|ctx:${context}`, audioCacheNamespace, AUDIO_QUICK_ENGINE_VERSION);

  const { data: remaining, error: rpcError } = await admin.rpc("decrement_quick_check", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[verify-audio-combined] decrement_quick_check RPC failed:", rpcError);
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

  const [textCached, audioCached] = await Promise.all([
    getCachedVerification(admin, textCacheKey),
    getCachedVerification(admin, audioCacheKey),
  ]);
  let textCacheHit = textCached !== null;
  const audioCacheHit = audioCached !== null;

  // Sept 17, 2026 fix: track the cached_at value alongside textCacheHit
  // rather than re-deriving it from `textCached` at response time (see the
  // `cached_at:` line below). A real, live 500 surfaced this exact request
  // ("Check failed" on the client) — "TypeError: Cannot read properties of
  // null (reading 'cached_at')" — because textCacheHit can become true via
  // the SEMANTIC match branch just below while `textCached` itself stays
  // null (only `textSemanticMatch` gets set in that case). The old
  // `(textCached as CachedVerification).cached_at` blew up exactly there.
  // app/api/verify-video-combined/route.ts already had this right (it
  // tracks its own `textCachedAt` the same way) — this brings the audio
  // route in line with that, already-correct pattern.
  let textCachedAt: string | null = textCached?.cached_at ?? null;

  // Semantic-cache fallback for the TEXT/transcript half only (Part 11's
  // "Semantic" layer, Sept 16, 2026 — see app/api/verify/route.ts's
  // identical comment for the full rationale). Never applied to the audio
  // half — that cache key is a hash of the raw audio bytes themselves
  // (see this file's header), not a "claim" with any meaningful semantic
  // similarity to embed.
  let textCacheMatchType: "exact" | "semantic" | null = textCacheHit ? "exact" : null;
  let textSemanticEmbedding: number[] | null = null;
  let textSemanticMatch: CachedVerification | null = null;
  if (!textCached) {
    const semantic = await checkSemanticCache(admin, normalizedTranscript, textCacheNamespace, ENGINE_VERSION);
    textSemanticEmbedding = semantic.embedding;
    textSemanticMatch = semantic.match;
    if (textSemanticMatch) {
      textCacheHit = true;
      textCacheMatchType = "semantic";
      textCachedAt = textSemanticMatch.cached_at;
    }
  }

  let textResult: QuickCheckResult | CachedVerification;
  let audioResult: AudioAnalysisResult | CachedVerification;
  try {
    const [freshText, freshAudio] = await Promise.all([
      textCached || textSemanticMatch ? Promise.resolve(null) : runQuickCheck(transcript, language),
      audioCached ? Promise.resolve(null) : runAudioQuickCheck(audioBase64, mimeType, context || null, language),
    ]);
    textResult = textCached ?? textSemanticMatch ?? (freshText as QuickCheckResult);
    audioResult = audioCached ?? (freshAudio as AudioAnalysisResult);
  } catch (err) {
    console.error("[verify-audio-combined] pipeline failed (refunding credit):", err);

    const { error: refundError } = await admin.rpc("refund_quick_check", { p_user_id: user.id });
    if (refundError) {
      console.error("[verify-audio-combined] refund_quick_check RPC ALSO failed:", refundError);
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

  const claimTextForAudio = context || "[Audio submitted for authenticity analysis]";

  const { data: transcriptRow, error: insertError1 } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      input_type: "audio_transcript",
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
    console.error("[verify-audio-combined] transcript verifications insert failed:", insertError1);
    return NextResponse.json(
      { error: "Check ran but couldn't be saved. Please try again." },
      { status: 500 }
    );
  }

  const { data: audioRow, error: insertError2 } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
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
    // The text half is already saved and charged — log loudly but don't
    // fail the whole request; the user still gets the result they paid for.
    console.error("[verify-audio-combined] audio verifications insert failed:", insertError2);
  }

  if (!textCacheHit) {
    await writeCache(admin, textCacheKey, transcriptRow.id, transcript);
    if (textSemanticEmbedding) {
      await writeSemanticCache(
        admin,
        textSemanticEmbedding,
        textCacheNamespace,
        ENGINE_VERSION,
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
    credit_type: "quick_check",
    amount: -1,
    reason:
      textCacheHit && textCacheMatchType === "semantic"
        ? "quick_check_completed_combined_audio_semantic"
        : "quick_check_completed_combined_audio",
    verification_id: transcriptRow.id,
  });
  if (txnError) {
    console.error("[verify-audio-combined] credit_transactions insert failed:", txnError);
  }

  const { data: balance } = await admin
    .from("credit_balances")
    .select("quick_checks_remaining, deep_investigations_remaining")
    .eq("user_id", user.id)
    .single();

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
