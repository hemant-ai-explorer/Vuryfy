// Google Cloud Vision — Document Text Detection (added Sept 24, 2026,
// replacing client-side Tesseract.js OCR). This is the server-side half of
// image OCR: given an image, it returns whatever text Vision found in it.
//
// Why this replaced Tesseract.js: lib/decode-image-text.ts originally ran
// Tesseract.js entirely in the browser, recognizing all 9 launch languages
// at once (see that file's now-superseded header for the full history of
// why 9 languages). That worked, but combined multi-language WASM OCR in
// the browser is genuinely slow — 40-50s on a real phone photo, on every
// single photo, before the user even chose Quick Check or Deep
// Investigation. A real user complaint ("everything should be under 30
// seconds") traced directly to this step. Moving OCR here cuts that to
// roughly the time of one network round trip (typically 1-3s), and Vision's
// OCR is generally more accurate than Tesseract on real-world photos
// besides. It also quietly fixes a stale rationale: the original
// client-side design was justified partly as "the photo never leaves the
// device" for OCR specifically — but every submit path in
// app/verify/image/page.tsx already uploads the full image to the server
// regardless (lib/image-analysis.ts's vision call needs the actual pixels),
// so that privacy benefit had stopped actually applying in practice.
//
// DOCUMENT_TEXT_DETECTION (not plain TEXT_DETECTION) — Google's own
// guidance is DOCUMENT_TEXT_DETECTION for dense text/paragraphs (a print-
// media clipping, a forwarded message screenshot — exactly this app's real
// usage), TEXT_DETECTION for sparse text (signs, labels). Returns
// `fullTextAnnotation.text` as one already-assembled string, no manual
// reconstruction from individual word/line annotations needed.
//
// No languageHints passed — Vision auto-detects script/language well
// without them, and hardcoding a hint list would reintroduce the same
// "only the languages someone thought to list" gap that made the old
// English-only Tesseract config miss a real Hindi claim (see
// decode-image-text.ts's superseded header). Vision's own multi-language
// support isn't limited to a fixed set the way Tesseract's per-language
// data packs were.
//
// Fails open: a missing key, a request error, or no text found all return
// "" (not null — callers treat empty string as "no text", matching the old
// extractTextFromImage() contract exactly so nothing downstream needed to
// change its own null-handling).
//
// Per-call cost logging, same fire-and-forget convention as
// lib/web-detection.ts's logVisionCost() — see lib/cost-pricing.ts's
// estimateGoogleVisionTextDetectionCostUsd() for the rate (a different,
// cheaper tier than Web Detection's).

import { createAdminClient } from "@/lib/supabase/admin";
import { estimateGoogleVisionTextDetectionCostUsd } from "@/lib/cost-pricing";

const VISION_ENDPOINT = "https://vision.googleapis.com/v1/images:annotate";

// Fire-and-forget, same convention as web-detection.ts's logVisionCost() —
// never awaited by callers, never allowed to affect the actual Vision
// request's latency or success/failure. Only called after a real request
// was actually sent (a missing API key returns early below without
// logging, same as web-detection.ts's missing-key path never logging).
function logTextDetectionCost(callSite: string, status: "success" | "error", errorMessage?: string): void {
  createAdminClient()
    .from("api_cost_logs")
    .insert({
      provider: "google_vision",
      model: null,
      tier: null,
      call_site: callSite,
      estimated_cost_usd: status === "success" ? estimateGoogleVisionTextDetectionCostUsd(1) : 0,
      status,
      error_message: errorMessage ?? null,
    })
    .then(({ error }) => {
      if (error) console.error("[detect-text] cost log insert failed:", error.message);
    });
}

export async function detectText(imageBase64: string, callSite: string): Promise<string> {
  const apiKey = process.env.GOOGLE_VISION_API_KEY;
  if (!apiKey) return ""; // not configured — treated as "no text found", not an error

  try {
    const response = await fetch(`${VISION_ENDPOINT}?key=${apiKey}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        requests: [
          {
            image: { content: imageBase64 },
            features: [{ type: "DOCUMENT_TEXT_DETECTION" }],
          },
        ],
      }),
      // OCR is now on the critical path of every photo submission (it runs
      // the moment a photo is chosen, before either Quick Check or Deep
      // Investigation), so this is bounded tightly — a slow/hung Vision
      // call should surface as "no text found" quickly, not stall the
      // whole upload flow.
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => "");
      console.error("[detect-text] Vision API error", response.status, bodyText.slice(0, 500));
      logTextDetectionCost(callSite, "error", `API error ${response.status}`);
      return "";
    }

    // Billed the moment Google returns 200, regardless of whether text was
    // actually found — same principle web-detection.ts's logVisionCost()
    // applies.
    logTextDetectionCost(callSite, "success");

    const json = await response.json().catch(() => null);
    const text: string | undefined = json?.responses?.[0]?.fullTextAnnotation?.text;
    if (typeof text !== "string") return "";

    const trimmed = text.trim();
    // A handful of stray characters isn't a usable claim to fact-check —
    // same spirit as the old Tesseract path's MIN_CONFIDENCE filter, just
    // a length floor instead of a confidence score (Vision doesn't expose
    // a single page-level confidence the same way).
    if (trimmed.length < 3) return "";
    return trimmed;
  } catch (err) {
    console.error("[detect-text] request failed:", err);
    logTextDetectionCost(callSite, "error", err instanceof Error ? err.message : String(err));
    return "";
  }
}
