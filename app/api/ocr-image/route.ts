import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { detectText } from "@/lib/detect-text";
import { checkContentSafety, ContentFlaggedError, hashBase64 } from "@/lib/content-safety";

// Server-side OCR extraction — Sept 24, 2026, replacing client-side
// Tesseract.js (see lib/detect-text.ts's header for the full "why", and
// lib/decode-image-text.ts's now-superseded header for what this replaced).
// Called by decode-image-text.ts the moment a photo is chosen in
// app/verify/image/page.tsx, BEFORE the user picks Quick Check or Deep
// Investigation — same "runs automatically on photo selection, no charge"
// timing the old client-side extraction had.
//
// Deliberately NOT a credit-charging route: extracting text isn't itself a
// verification — it's the same free, no-op-cost step client-side Tesseract
// used to be, just now it happens on the server instead of in the browser.
// The actual fact-check of whatever text this finds still goes through
// /api/verify or /api/deep (input_type: "ocr") or the *-combined routes,
// exactly as before — this route's only job is "what does this photo say".
//
// Content safety (Part 15) still applies here even though no credit is
// charged and no AI provider (Gemini) is involved: the image bytes ARE
// sent to an external provider (Google Vision), so the same
// scan-before-any-provider-sees-it rule from every other image route
// applies unchanged.
export const maxDuration = 30;

const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BASE64_LENGTH = 8_000_000; // matches every other image route's limit

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const imageBase64: string = body?.image_base64 ?? "";
  const mimeType: string = body?.mime_type ?? "";

  if (!imageBase64) {
    return NextResponse.json({ error: "No image was provided." }, { status: 400 });
  }
  if (imageBase64.length > MAX_BASE64_LENGTH) {
    return NextResponse.json({ error: "That image is too large." }, { status: 400 });
  }
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return NextResponse.json({ error: "Unsupported image type." }, { status: 400 });
  }

  const admin = createAdminClient();

  try {
    await checkContentSafety({
      admin,
      userId: user.id,
      contentType: "image",
      contentHash: hashBase64(imageBase64),
      sourceRoute: "ocr-image",
      imageBase64,
    });
  } catch (err) {
    if (err instanceof ContentFlaggedError) {
      return NextResponse.json({ error: "This content can't be processed." }, { status: 422 });
    }
    throw err;
  }

  // No try/catch needed around this call the way every AI-pipeline route
  // has one — detectText() already fails open internally (missing key,
  // API error, network failure, or no text found all just return ""), so
  // there's no credit to refund and no partial-failure state to handle.
  const text = await detectText(imageBase64, "ocr-image.text-detection");

  // No analytics event here deliberately — lib/analytics.ts's
  // AnalyticsEvent taxonomy (Part 23, LOCKED) is scoped to the verification
  // funnel and revenue events; this route doesn't fit either, and OCR
  // extraction's downstream fact-check (through /api/verify, /api/deep, or
  // the *-combined routes) already fires verification_submitted itself.

  return NextResponse.json({ text });
}
