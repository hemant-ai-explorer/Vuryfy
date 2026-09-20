import { callStructured } from "@/lib/ai-gateway";
import type { QuickCheckEvidence } from "@/lib/quick-check";
import { translate, LANGUAGE_NAMES, type Language } from "@/lib/translations";

// Audio authenticity analysis — the second half of audio input (the first
// half, transcript-based fact-checking, reuses quick-check.ts/
// deep-investigation.ts unchanged via input_type "audio_transcript"; see
// audio-transcript.ts). This file exists for a genuinely different
// question, same shape as lib/image-analysis.ts's photo-as-claim pipeline
// but for a recording: not "is what's said true", but "does this audio
// itself sound real / synthesized / spliced, and if the user told us what
// it's supposed to be, is that plausible".
//
// One real difference from lib/image-analysis.ts, worth being explicit
// about rather than silently copying the image shape: Deep Investigation
// here does NOT get an extra evidence-gathering step the way image Deep
// Investigation gets Google Cloud Vision's Web Detection (reverse image
// search). There is no reverse-audio-search provider in this stack, and no
// "Out of Context" verdict is offered for audio at all — offering it
// without a way to ever ground it would repeat exactly the ungrounded-
// verdict mistake Part 19's evidence-grounding principle and the Scam-
// verdict false-positive lesson both warn against. So for audio, "Deep
// Investigation" means only a slower, more careful listen with the
// reasoning-tier model — same verdict vocabulary as Quick Check, just a
// more thorough pass over the same recording. If a real reverse-audio-
// search / audio-fingerprint-matching provider is ever added to the stack,
// this file is where an "Out of Context"-style verdict would go, mirroring
// image-analysis.ts's pattern exactly.
//
// AI-generation call (added Sept 14, 2026, same day as initial ship — see
// architecture-decisions.md): the very first test of this feature was a
// Stable Audio-generated bird-call soundscape, which the initial version
// of this prompt called "Clean" at 90% confidence — a real miss. The root
// cause: the original signals list was written entirely with SPEECH
// synthesis/splicing in mind (prosody, robotic timbre, cut points), so a
// clip with no speech at all found nothing to flag. Fixed by (a) adding an
// explicit, required ai_generated_likelihood field so the model must make
// a direct call on the exact question users actually ask — "is this AI
// generated?" — rather than leaving it as an inference from unrelated
// signals, and (b) extending the signals guidance to cover generative
// audio models for MUSIC/AMBIENCE/SOUNDSCAPES (Stable Audio, MusicGen,
// AudioLDM, etc.), not just synthesized speech. The explicit call is
// surfaced as the LEAD sentence of the summary (the "WHY" section is the
// most prominent text on the result screen) rather than buried in caveats.
// A defensive downgrade (mirroring image-analysis.ts's pattern) keeps
// verdict and the AI-generation call from contradicting each other: a
// "likely AI-generated" result can never come back as verdict "Clean".
//
// Verdict vocabulary (deliberately NOT the True/False/Misleading/
// Unverified/Scam set text claims get, for the same reason as image
// analysis — no evidence source exists here to ground a truth/falsity
// verdict on):
//   - "Clean"       — no audible signs of synthesis/generation/splicing
//                      found. Does NOT mean "confirmed authentic" — a
//                      well-made synthetic recording can sound Clean to a
//                      listen-through alone; the caveats below say so on
//                      every result.
//   - "Suspicious"  — specific, describable audible indicators found
//                      (listed in caveats), OR the AI-generation call came
//                      back "likely" (see defensive downgrade above).
//   - "Inconclusive" — audio quality too poor/noisy to assess meaningfully,
//                      or signals point different directions.
// confidence always reflects confidence in the SIGNALS found, never a
// claim about "is this recording real" beyond what was actually observed.
//
// Media retention (Part 15): the audio reaches the server and the AI
// provider as inline base64 data and is NEVER written to Supabase storage
// or any other persistence layer by this file or its callers
// (app/api/verify-audio/route.ts, app/api/deep-audio/route.ts) — exists
// only in server memory for the duration of the request, same principle as
// image analysis.
//
// Caching: deliberately NOT integrated with verification-cache.ts, same
// simplicity/parity decision as image analysis. Worth flagging one
// difference: unlike a phone-camera photo (re-compressed differently on
// every capture, so an exact-match cache would rarely hit), the SAME audio
// file genuinely can be resubmitted byte-identical (a forwarded voice
// note, the same recording checked twice) — so this is a real missed
// caching opportunity, more so than for photos. Left uncached in V1 for
// consistency and to avoid scope creep; revisit if real usage shows
// meaningful duplicate-audio traffic.
//
// Output localization (Sept 16, 2026 fast-follow) — see
// lib/video-analysis.ts's identical comment for the full rationale; same
// mechanism applied here, just for audio's own fields.

// Sept 17, 2026: bumped v4 -> v5 — audio Quick Check moved from the
// "cheap" tier (gemini-3.1-flash-lite) to the "reasoning" tier (same
// model Deep Investigation uses). Root cause: a live test with an
// obvious Narakeet-generated voice came back "Inconclusive" on Quick
// Check while Deep Investigation correctly flagged it — not a bug in the
// strict sense (HONESTY_RULES' "uncertain" -> "Inconclusive" downgrade
// worked exactly as designed, never falsely claiming "Clean"), but the
// cheap-tier model was punting to "uncertain" on well-produced TTS speech
// far too often for the single most common check path to be useful
// against the AI-voice-scam case this feature exists for. Bumping the
// version also matters independent of the model swap itself: cache
// entries are keyed on this string (see computeCacheKey calls in
// app/api/verify-audio/route.ts and verify-audio-combined/route.ts), so
// leaving it unchanged would keep serving pre-change "Inconclusive"
// verdicts out of the exact-match cache indefinitely.
// Sept 17, 2026: HONESTY_RULES below no longer names "ElevenLabs" as its
// example TTS brand, and now explicitly forbids naming any specific AI
// voice/TTS tool from general knowledge. Root cause of a real anomaly:
// re-testing a Narakeet-generated clip, Quick Check's ai_generated_reasoning
// said the voice "was created using the ElevenLabs AI voice generator" —
// wrong brand, even though the verdict and underlying observations
// (self-announcement + synthetic prosody) were correct, and even though
// Deep Investigation on the same clip correctly said "Narakeet." The
// prompt itself was the likely cause: HONESTY_RULES named ElevenLabs as
// its canonical example of a top-tier TTS tool, which plausibly primed the
// model to reach for that name when explaining itself rather than reading
// the actual transcript/context it was given. No engine_version bump for
// this — it's a prompt-wording fix, not a new capability or a change to
// what gets cached (same schema, same verdict logic).
// Sept 20, 2026: HONESTY_RULES' ai_generated_reasoning instruction no
// longer allows asserting specific spoken words/phrases as evidence — same
// class of bug as the Sept 17 ElevenLabs fix above, different symptom.
// Root cause of a real anomaly found in testing: a Deep Investigation
// result's transcript panel (from the separate, transcript-based pipeline
// in deep-investigation.ts) correctly read "Moon and team," while this
// file's own authenticity summary confidently asserted it heard a specific
// different word — "quarantine" — nowhere in the actual recording. This
// pipeline never sees the confirmed transcript (it listens to the raw
// audio independently) and was never a transcription tool to begin with,
// so asking it to be "specific and concrete" invited it to name exact
// words it wasn't equipped to reliably identify. Fixed by restricting
// "concrete evidence" to acoustic/paralinguistic properties only (pacing,
// prosody, background noise, splicing, artifacts) and explicitly
// forbidding quoting/asserting specific spoken content. No engine_version
// bump — a prompt-wording fix, not a new capability or schema change, same
// as the Sept 17 fix.
export const AUDIO_QUICK_ENGINE_VERSION = "v5-gemini-audio-quick-aigen-reasoning";
export const AUDIO_DEEP_ENGINE_VERSION = "v5-gemini-audio-deep-aigen";

// Sept 15, 2026: added same day, after a live 503 surfaced this gap on
// text Deep Investigation's identical call (see deep-investigation.ts's
// SYNTHESIS_FALLBACK_MODELS for the full story) — modelForTier's
// "reasoning" tier now points every Deep Investigation pipeline at
// gemini-3.8-flash, but the fallback safety net had only ever been wired
// into video Deep Investigation. Audio shares the same exposure.
//
// Sept 17, 2026: now also passed to runAudioQuickCheck, since Quick
// Check calls the reasoning tier too as of the version bump above and
// inherits the exact same transient-503 exposure Deep Investigation has
// — leaving Quick Check without the fallback net it never needed on the
// cheap tier would be a new failure mode introduced by this change.
const AUDIO_REASONING_FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

export interface AudioAnalysisResult {
  verdict: string;
  confidence: number;
  summary: string;
  key_evidence: QuickCheckEvidence[]; // always empty — no evidence source exists for audio yet; kept for shape-compatibility with the verifications table
  sources: { title: string; url: string }[]; // always empty, same reason
  caveats: string[];
  engine_version: string;
}

const VERDICTS = ["Clean", "Suspicious", "Inconclusive"];
const AI_LIKELIHOODS = ["likely", "unlikely", "uncertain"];

const AUDIO_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VERDICTS },
    confidence: { type: "integer" },
    contains_speech: { type: "boolean" },
    ai_generated_likelihood: { type: "string", enum: AI_LIKELIHOODS },
    ai_generated_reasoning: { type: "string" },
    summary: { type: "string" },
    signals_found: { type: "array", items: { type: "string" } },
    context_match: { type: "string", enum: ["consistent", "inconsistent", "not_applicable"] },
  },
  required: [
    "verdict",
    "confidence",
    "contains_speech",
    "ai_generated_likelihood",
    "ai_generated_reasoning",
    "summary",
    "signals_found",
    "context_match",
  ],
};

interface AudioOutput {
  verdict: string;
  confidence: number;
  contains_speech: boolean;
  ai_generated_likelihood: string;
  ai_generated_reasoning: string;
  summary: string;
  signals_found: string[];
  context_match: string;
}

const HONESTY_RULES = `You are analyzing the audio of this one recording. You have no other access to metadata and no way to confirm when, where, or by whom this was actually recorded.

FIRST: set contains_speech — true if the recording contains any spoken words, false if it's music, ambience, sound effects, or non-speech audio only.

THEN, and separately from everything else: decide ai_generated_likelihood — whether this audio was likely produced by an AI generation model rather than captured from the real world. Judge this independently for whichever kind of content is actually present, and read the SPEECH rule below carefully — it inverts what might seem like the intuitive signal:
- For SPEECH: modern commercial voice-cloning and text-to-speech tools are SPECIFICALLY engineered to reproduce natural prosody, breath sounds, timbre consistency, and a plausible noise floor — those qualities are now table stakes for good synthetic speech and are NOT reliable evidence a voice is real. Do not call "unlikely" just because a voice sounds natural, warm, or well-produced. Only call "unlikely" when you hear evidence of the actual RECORDING ENVIRONMENT, not just the voice: background noise that audibly varies or shifts over time, incidental unrelated sounds (traffic, papers, a door, another person), room echo/reverb consistent with a specific physical space, handling or mic-bump noise, or other capture imperfections a text-to-speech pipeline would not introduce. A clean, studio-quality voice with no such environmental evidence either way should be called "uncertain", not "unlikely" — admitting you can't tell is the honest answer, since a great voice clone and a professionally recorded human can sound identical. Reserve "likely" for actual synthesis tells: unnaturally even pacing/rhythm with no natural hesitation, a voice that subtly drifts in timbre across the clip, or robotic/metallic artifacts.
- For MUSIC, AMBIENCE, SOUNDSCAPES, or SOUND EFFECTS (e.g. output from models like Stable Audio, MusicGen, AudioLDM): unnaturally smooth or seamless transitions between textures; sounds (animal calls, footsteps, wind gusts, etc.) that repeat with implausibly identical pitch, timing, or shape rather than the natural variation a real recording would have; a total absence of a genuine environmental noise floor, microphone self-noise, or incidental unrelated sounds a real field recording would pick up; layered sounds that are unnaturally cleanly separated rather than blending/bleeding into each other as they would in a real space; reverb or spatial characteristics that stay artificially uniform across the whole clip; a subtle "smeared" or "shimmering" quality in transients that is characteristic of diffusion-based audio generation. Here, natural imperfections (varying noise floor, natural randomness in repeated sounds, genuine room tone) ARE still reasonable evidence for "unlikely", since generative audio models struggle more with these than modern TTS struggles with vocal naturalness.
- Call it "uncertain" whenever the clip is too short, too clean-but-ambiguous, or gives genuinely mixed signals either way — this is the correct, honest answer far more often for speech than "unlikely" is.
- ai_generated_reasoning must be a specific, concrete sentence or two naming what you actually heard (or didn't hear) that led to your call — never a vague "it sounds synthetic" or "it sounds natural." Ground this ONLY in acoustic/paralinguistic properties: pacing and rhythm, prosody, pitch/timbre consistency or drift, breath sounds, background noise or room tone (present, absent, or changing), handling/mic-bump noise, splicing or cut points, or generation artifacts. Do NOT assert, quote, or paraphrase specific words or phrases you believe were spoken, even in passing — you are not a transcription tool, a separate pipeline already has the confirmed transcript, and confidently naming a word you misheard (a real failure mode: a past run claimed to hear "quarantine" in a recording that actually said something else entirely) directly contradicts that transcript and misleads the user. If speech content is relevant to your reasoning, describe it only in general terms (e.g. "the speaker's claims about X") rather than quoting specific words. Do NOT name a specific AI voice/TTS tool or brand (e.g., ElevenLabs, Narakeet, Play.ht) from general knowledge — you cannot identify which tool made a recording from its sound alone. The only exception: if the recording itself explicitly says which tool made it (e.g., a spoken self-announcement, or a name given in the context above), quote that name exactly as stated rather than substituting a different well-known brand.

SEPARATELY, decide the overall verdict:
- Use "Suspicious" when you found specific, describable audible evidence in signals_found (any of the signals above, or audible splicing/cut points, or background noise/room acoustics that inconsistently change mid-recording), OR whenever ai_generated_likelihood is "likely" — a recording you believe is AI-generated is never "Clean". Never choose "Suspicious" from a vague sense that something "sounds off" with nothing specific to point to.
- Use "Clean" only when no such signals were found AND ai_generated_likelihood is "unlikely". This means nothing suspicious was audibly detected — it does NOT mean the recording is confirmed authentic; a well-made synthetic recording can sound identical to a real one on a listen-through.
- Use "Inconclusive" when audio quality is too poor/noisy to assess meaningfully, when signals point in genuinely different directions, OR whenever ai_generated_likelihood is "uncertain" — "uncertain" means you could not reach a confident read on the exact question this check exists to answer, so the headline verdict must say so too rather than reading as a clean bill of health next to an admission of uncertainty.
- confidence (0-100) reflects how confident you are in the signals/evidence you found (or didn't find), covering both the verdict and the AI-generation call — never let it imply certainty about whether the recording is "real."
- If context describing what the recording is supposed to be is given below, separately judge context_match: "consistent" if what's audible is plausible with that description, "inconsistent" if there is a clear, describable mismatch you can name, "not_applicable" if no context was given or the recording gives no basis to judge it either way.
Respond with only the requested JSON — no extra commentary, no markdown.`;

const QUICK_SYSTEM_PROMPT = `You are Vuryfy's audio Quick Check engine, giving a fast first-pass listen to a recording. ${HONESTY_RULES}`;

const DEEP_SYSTEM_PROMPT = `You are Vuryfy's audio Deep Investigation engine, giving a slower, more thorough listen than a Quick Check. Listen carefully across the whole clip — consistency of voice timbre and pacing throughout (if speech is present), naturalness and variation of any repeated sounds, background noise/room tone continuity, any abrupt transitions or cut points, and any artifacts typical of AI-generated speech, music, or soundscapes. ${HONESTY_RULES}`;

// Output localization (Sept 16, 2026) — mirrors quick-check.ts's
// languageInstruction() exactly, just naming this file's own free-text
// fields.
function languageInstruction(language: Language): string {
  if (language === "en") return "";
  return `\n\nWrite the "summary" and "ai_generated_reasoning" fields, and each item in "signals_found", in natural, fluent ${LANGUAGE_NAMES[language]}.`;
}

function buildUserPrompt(context: string | null): string {
  const contextLine = context && context.trim().length > 0
    ? `Context the user provided about what this recording is supposed to be:\n"${context.trim()}"\n\n`
    : `No context was provided about what this recording is supposed to be.\n\n`;
  return `${contextLine}Analyze the attached audio.`;
}

const AI_LABEL_KEYS: Record<string, string> = {
  likely: "pipeline.audio.aiLikely",
  unlikely: "pipeline.audio.aiUnlikely",
  uncertain: "pipeline.audio.aiUncertain",
};

function toResult(data: AudioOutput, engineVersion: string, language: Language): AudioAnalysisResult {
  let verdict = VERDICTS.includes(data.verdict) ? data.verdict : "Inconclusive";
  const confidence = Number.isFinite(data.confidence) ? Math.max(0, Math.min(100, Math.round(data.confidence))) : 0;
  const aiLikelihood = AI_LIKELIHOODS.includes(data.ai_generated_likelihood)
    ? data.ai_generated_likelihood
    : "uncertain";
  const aiReasoning =
    typeof data.ai_generated_reasoning === "string" && data.ai_generated_reasoning.trim()
      ? data.ai_generated_reasoning.trim()
      : translate(language, "pipeline.common.noSignalsDescribed");
  const generalSummary =
    typeof data.summary === "string" && data.summary.trim()
      ? data.summary.trim()
      : translate(language, "pipeline.common.noExplanation");
  const signals = Array.isArray(data.signals_found)
    ? data.signals_found.filter((s) => typeof s === "string" && s.trim().length > 0)
    : [];

  // Defensive downgrades (mirrors image-analysis.ts / video-analysis.ts) —
  // code-enforced backstops in case the model doesn't follow the
  // instructions above:
  // 1. A "likely AI-generated" call can never be paired with verdict
  //    "Clean" — that would flatly contradict itself.
  // 2. An "uncertain" call can never be paired with verdict "Clean"
  //    either — a headline "Clean" next to "we can't tell if this is
  //    AI-generated" reads as a contradiction to anyone glancing at the
  //    result screen (this is exactly the confusion a real user hit on
  //    Sept 14, 2026, prompting this fix). "Uncertain" downgrades to
  //    "Inconclusive" instead, so the headline never overstates
  //    confidence beyond what the AI-generation call itself expresses.
  if (aiLikelihood === "likely" && verdict === "Clean") {
    verdict = "Suspicious";
  } else if (aiLikelihood === "uncertain" && verdict === "Clean") {
    verdict = "Inconclusive";
  }

  // The AI-generation call is the question users actually came here to ask,
  // so it leads the summary (the "WHY" section — the most prominent text on
  // the result screen) rather than being left implicit in signals_found or
  // buried in the caveats list below.
  const summary = `${translate(language, "pipeline.audio.summaryPrefix")} ${translate(language, AI_LABEL_KEYS[aiLikelihood])}. ${aiReasoning} ${generalSummary}`.trim();

  const caveats: string[] = [translate(language, "pipeline.audio.disclaimer")];
  if (data.contains_speech && aiLikelihood !== "likely") {
    caveats.push(translate(language, "pipeline.audio.caveatSpeech"));
  }
  for (const s of signals) caveats.push(`${translate(language, "pipeline.common.observedPrefix")}${s.trim()}`);
  if (data.context_match === "inconsistent") {
    caveats.push(translate(language, "pipeline.audio.contextInconsistent"));
  } else if (data.context_match === "consistent") {
    caveats.push(translate(language, "pipeline.audio.contextConsistent"));
  }

  return {
    verdict,
    confidence,
    summary,
    key_evidence: [],
    sources: [],
    caveats,
    engine_version: engineVersion,
  };
}

export async function runAudioQuickCheck(
  audioBase64: string,
  mimeType: string,
  context: string | null,
  language: Language = "en"
): Promise<AudioAnalysisResult> {
  const { data } = await callStructured<AudioOutput>({
    // Sept 17, 2026: was "cheap" (gemini-3.1-flash-lite) — see
    // AUDIO_QUICK_ENGINE_VERSION's header comment for why this moved to
    // the same reasoning-tier model Deep Investigation uses. Quick Check
    // is no longer cheaper than Deep Investigation for audio specifically;
    // it still returns faster (shorter/no multi-pass prompt) but the cost
    // difference between Quick and Deep for audio is now real but small.
    tier: "reasoning",
    systemPrompt: QUICK_SYSTEM_PROMPT + languageInstruction(language),
    userPrompt: buildUserPrompt(context),
    responseSchema: AUDIO_SCHEMA,
    audioParts: [{ mimeType, data: audioBase64 }],
    timeoutMs: 30_000,
    fallbackModels: AUDIO_REASONING_FALLBACK_MODELS,
    callSite: "audio-analysis.quick",
  });
  return toResult(data, AUDIO_QUICK_ENGINE_VERSION, language);
}

export async function runAudioDeepInvestigation(
  audioBase64: string,
  mimeType: string,
  context: string | null,
  language: Language = "en"
): Promise<AudioAnalysisResult> {
  const { data } = await callStructured<AudioOutput>({
    tier: "reasoning",
    systemPrompt: DEEP_SYSTEM_PROMPT + languageInstruction(language),
    userPrompt: buildUserPrompt(context),
    responseSchema: AUDIO_SCHEMA,
    audioParts: [{ mimeType, data: audioBase64 }],
    timeoutMs: 30_000,
    fallbackModels: AUDIO_REASONING_FALLBACK_MODELS,
    callSite: "audio-analysis.deep",
  });
  return toResult(data, AUDIO_DEEP_ENGINE_VERSION, language);
}
