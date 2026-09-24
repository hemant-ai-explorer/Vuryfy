// OCR text-in-image extraction — thin client wrapper around the server-side
// Vision call (lib/detect-text.ts, via app/api/ocr-image/route.ts).
//
// SUPERSEDED Sept 24, 2026 — this used to run Tesseract.js entirely in the
// browser (multi-language WASM OCR across all 9 launch languages, on every
// photo, before the user even chose Quick Check or Deep Investigation).
// That worked, but was genuinely slow: 40-50s on a real phone photo, which
// a real user flagged directly ("everything should be under 30 seconds").
// Moved OCR server-side instead — see lib/detect-text.ts's header for the
// full rationale, including why the original "photo never leaves the
// device for OCR" privacy argument had quietly stopped being true in
// practice (every submit path already uploads the full image regardless,
// for the vision-analysis half of this same screen).
//
// Signature change that comes with the move: this now takes the ALREADY
// client-downscaled base64 image (lib/prepare-image-upload.ts's output)
// instead of a raw File. The old version did its own separate canvas
// resize to a 1600px max dimension specifically for OCR legibility — but
// prepare-image-upload.ts already downscales to that exact same 1600px
// target for the vision-analysis path, so reusing its output here removes
// a second, redundant client-side resize rather than duplicating one.
//
// Still fails open exactly like before: any failure (network, server
// error, no text found) returns "" — callers treat empty string as "no
// text", the same contract this function has always had.
export async function extractTextFromImage(imageBase64: string, mimeType: string): Promise<string> {
  try {
    const res = await fetch("/api/ocr-image", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: imageBase64, mime_type: mimeType }),
    });
    if (!res.ok) return "";
    const data = await res.json().catch(() => null);
    return typeof data?.text === "string" ? data.text : "";
  } catch {
    return "";
  }
}
