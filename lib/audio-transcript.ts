import { callStructured } from "@/lib/ai-gateway";

// Audio transcription — the first half of audio input (the second half,
// authenticity/deepfake-style analysis of the recording itself, is
// lib/audio-analysis.ts). Once transcribed, the text is run through the
// EXACT SAME evidence-grounded text pipeline as a typed claim, QR-decoded
// link, or OCR-extracted text — via /api/verify and /api/deep with
// input_type "audio_transcript" — exactly like OCR does for images. This
// file's only job is producing that transcript.
//
// Architectural note worth flagging (differs from QR decode and image
// OCR): those two run entirely client-side with zero marginal cost, so
// offering them "for free" before any credit is charged costs this app
// nothing. Speech-to-text has no equivalent free, client-side, good-enough
// option (see prepare-audio-upload.ts's header) — this genuinely requires
// a real AI call. The decision here (Sept 2026) is to keep transcription
// free anyway, for UX consistency with every other input type's "extract
// first, see what you're checking, THEN spend a credit" pattern, and
// because it doesn't itself produce a verdict — it's a preprocessing step,
// not a completed Quick Check/Deep Investigation, so Part 26.4 addition
// #1's "charge on completion" rule doesn't apply to it in the first place.
// This does mean a signed-in user can call /api/transcribe-audio
// repeatedly at zero cost to themselves — acceptable at V1's scale (a
// single cheap-tier Gemini call is a fraction of a cent), but worth
// revisiting (e.g. a coarse rate limit) if real usage ever makes that a
// meaningful cost center. Flagged here rather than silently built as if it
// were free the way QR/OCR actually are.
//
// Uses the "cheap" tier regardless of which mode (Quick/Deep) the user
// picks afterward — transcription accuracy doesn't benefit from the
// reasoning tier, and keeping this one call cheap keeps the free-preview
// step actually cheap.
//
// Sept 17, 2026: added fallbackModels — this call had been the one cheap-
// tier call in the whole codebase with NO fallback safety net, despite
// video-transcript.ts's identical call (lib/video-transcript.ts's
// VIDEO_TRANSCRIPT_FALLBACK_MODELS, added Sept 15 after real, repeated
// live 503s on that exact call) already solving this same problem.
// Surfaced by a live 503 on this exact route during testing
// (`[transcribe-audio] transcription failed: ... Gemini API error 503`) —
// with no fallback, that 503 hard-failed the ENTIRE audio flow (Quick
// Check and Deep Investigation both, since neither can proceed without a
// transcript) after only the bare 2-retry default, surfacing as a raw
// "Try Again" instead of quietly recovering. Same fallback chain as
// video-transcript.ts's, for the same reason (see that file's header:
// falls UP to a stronger, hopefully-less-loaded model rather than down,
// since a fully failed transcription blocks the whole downstream flow —
// worth the extra cost on the rare fallback case).
const AUDIO_TRANSCRIPT_FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];

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

const SYSTEM_PROMPT = `You transcribe spoken audio verbatim, in the language it was spoken in. Output only the transcript text — no speaker labels, no timestamps, no commentary, no translation. If the audio has no discernible speech (music only, silence, noise, or you genuinely cannot make out any words), return an empty string for transcript. Respond with only the requested JSON.`;

const MIN_USABLE_LENGTH = 3; // trimmed length below which we treat it as "no speech found" rather than a real transcript

export async function transcribeAudio(audioBase64: string, mimeType: string): Promise<string> {
  const { data } = await callStructured<TranscriptOutput>({
    tier: "cheap",
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: "Transcribe the attached audio.",
    responseSchema: TRANSCRIPT_SCHEMA,
    audioParts: [{ mimeType, data: audioBase64 }],
    timeoutMs: 25_000, // audio can run longer than a still image; still bounded
    fallbackModels: AUDIO_TRANSCRIPT_FALLBACK_MODELS,
    callSite: "audio-transcript.transcribe",
  });

  const transcript = typeof data.transcript === "string" ? data.transcript.trim() : "";
  return transcript.length >= MIN_USABLE_LENGTH ? transcript : "";
}
