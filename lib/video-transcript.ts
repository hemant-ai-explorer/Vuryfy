import { callStructured } from "@/lib/ai-gateway";

// Video transcription — the first half of video input (the second half,
// authenticity/deepfake-style analysis of the video itself, is
// lib/video-analysis.ts). Mirrors lib/audio-transcript.ts exactly, one
// level down: Gemini natively processes a video's own audio track from the
// same video content used for the authenticity pass, so this needs no
// separate audio-extraction step. Once transcribed, the text is run
// through the EXACT SAME evidence-grounded text pipeline as a typed claim,
// QR-decoded link, OCR-extracted text, or audio transcript — via
// /api/verify and /api/deep with input_type "video_transcript".
//
// Kept free for the same reason audio transcription is free (see
// audio-transcript.ts's header): UX consistency with every other input
// type's "extract first, see what you're checking, THEN spend a credit"
// pattern, and because it's a preprocessing step, not a completed Quick
// Check/Deep Investigation. Same "cheap" tier regardless of which mode the
// user picks afterward.
//
// Sept 15, 2026: takes a Gemini File API reference (fileUri) instead of
// inline base64 data — video now uploads to Gemini's File API rather than
// embedding raw bytes in the request, since the size cap needed to raise
// (per the direct-to-storage rework, see lib/gemini-file-upload.ts and
// supabase/migrations/0009_temp_video_storage.sql) no longer fits Gemini's
// own inline-request limit either. The caller (the route handler) owns
// the upload and the cleanup — this function only runs the transcription
// call itself.

interface TranscriptOutput {
  transcript: string;
}

const TRANSCRIPT_SCHEMA = {
  type: "object",
  properties: {
    transcript: { type: "string" },
  },
  required: ["transcript"],
};

const SYSTEM_PROMPT = `You transcribe spoken audio from this video verbatim, in the language it was spoken in. Output only the transcript text — no speaker labels, no timestamps, no commentary, no translation, no description of the visuals. If the video has no discernible speech (music only, silence, noise, or you genuinely cannot make out any words), return an empty string for transcript. Respond with only the requested JSON.`;

const MIN_USABLE_LENGTH = 3; // trimmed length below which we treat it as "no speech found" rather than a real transcript

// Sept 15, 2026: widened retry backoff, same reasoning as
// lib/video-analysis.ts's VIDEO_DEEP_RETRY_DELAYS_MS — a real live test hit
// a Gemini 503 on this exact call that survived the shared default's 2
// retries. Unlike video Deep Investigation this is a "cheap" tier call and
// this route's own Storage object already survives a failed attempt
// (app/api/transcribe-video/route.ts always passes deleteStorage=false), so
// a shorter widening than Deep Investigation's is enough here — mainly
// aimed at absorbing one extra transient overload spike without making the
// user click "Try Again" themselves. Still comfortably inside this route's
// 300s maxDuration budget alongside the download/upload steps.
const VIDEO_TRANSCRIPT_RETRY_DELAYS_MS = [1000, 2000, 4000];

// Sept 15, 2026: a same-day Deepgram pilot for this exact call was tried
// and reverted — Deepgram's nova-3 model produced a genuinely wrong
// transcript on real Hinglish content (word-salad, not just imperfect),
// which is worse for a trust/verification product than an occasional
// retry-able error. Gemini's own transcription quality was clearly better
// on the same content, so this stays on Gemini — paired instead with a
// fallback-model list (see ai-gateway.ts's StructuredCallParams header for
// why that's the better lever than a vendor swap or Vertex AI).
const VIDEO_TRANSCRIPT_FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];

export async function transcribeVideoSpeech(fileUri: string, mimeType: string): Promise<string> {
  const { data } = await callStructured<TranscriptOutput>({
    tier: "cheap",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: "Transcribe the speech in the attached video.",
    responseSchema: TRANSCRIPT_SCHEMA,
    videoFileRef: { fileUri, mimeType },
    timeoutMs: 90_000, // longer clips (now up to several minutes) take longer to process than the old short-clip cap ever needed; still bounded
    retryDelaysMs: VIDEO_TRANSCRIPT_RETRY_DELAYS_MS,
    fallbackModels: VIDEO_TRANSCRIPT_FALLBACK_MODELS,
    callSite: "video-transcript.transcribe",
  });

  const transcript = typeof data.transcript === "string" ? data.transcript.trim() : "";
  return transcript.length >= MIN_USABLE_LENGTH ? transcript : "";
}
