import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { transcribeAudio } from "@/lib/audio-transcript";
import { checkContentSafety, ContentFlaggedError, hashBase64 } from "@/lib/content-safety";

// Route-level execution budget (Sept 2026 fix — see app/api/deep/route.ts's
// comment, and app/api/transcribe-video/route.ts's original discovery of
// this gap, for the full rationale). 60 is Hobby's max; without it
// Vercel's silent 10s default kill can cut off the transcription call
// before it returns.
export const maxDuration = 60;

// Free preview step for audio input's transcript sub-path — see
// lib/audio-transcript.ts's file header for why this is free despite being
// a real AI call (unlike QR decode / image OCR, which are free because
// they're genuinely client-side with zero marginal cost). This route
// charges NO credit and writes NO verifications row — it only produces a
// transcript for the user to review (and edit, since ASR isn't perfect)
// before deciding whether to spend a Quick Check or Deep Investigation
// credit checking it, via /api/verify or /api/deep with
// input_type: "audio_transcript".
//
// Still requires sign-in (not a public/unauthenticated endpoint) — a
// bare minimum guard against anonymous abuse of the AI call, even though
// no credit is at stake here.
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
const MAX_BASE64_LENGTH = 20_000_000; // ~15MB binary — matches prepare-audio-upload.ts's client-side cap, with headroom

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

  // Content safety (Part 15, Sept 19, 2026) — scan before this free
  // preview step reaches an AI provider. See lib/content-safety.ts's file
  // header (currently a stub; no real hash-matching provider is wired in
  // yet).
  try {
    await checkContentSafety({
      admin,
      userId: user.id,
      contentType: "audio",
      contentHash: hashBase64(audioBase64),
      sourceRoute: "transcribe-audio",
    });
  } catch (err) {
    if (err instanceof ContentFlaggedError) {
      return NextResponse.json({ error: "This content can't be processed." }, { status: 422 });
    }
    throw err;
  }

  try {
    const transcript = await transcribeAudio(audioBase64, mimeType);
    return NextResponse.json({ transcript });
  } catch (err) {
    console.error("[transcribe-audio] transcription failed:", err);
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
