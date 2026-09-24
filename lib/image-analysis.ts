import { callStructured } from "@/lib/ai-gateway";
import { detectWeb, type MatchingPage } from "@/lib/web-detection";
import type { QuickCheckEvidence } from "@/lib/quick-check";
import { translate, LANGUAGE_NAMES, type Language } from "@/lib/translations";

// Photo-as-claim vision pipeline — the second half of image input (the
// first half, OCR text-in-image, just reuses quick-check.ts/
// deep-investigation.ts unchanged via input_type "ocr"; see
// decode-image-text.ts). This file exists for a genuinely different
// question: not "is the text in this image true", but "does this image
// itself look real / doctored / AI-generated, and if the user told us what
// it's supposed to show, is that plausible — and (Deep Investigation only,
// added Sept 2026) does this exact image actually appear anywhere else on
// the web, in what context, since when".
//
// Why Quick Check and Deep Investigation genuinely differ here, not just
// in "how hard the model tries" the way text Quick/Deep do: Quick Check
// still has NO real evidence to work from — Vuryfy's stack has no
// reverse-image-search for the fast/cheap path, so it can only look at
// pixels, same limitation this file originally shipped with. Deep
// Investigation now calls lib/web-detection.ts (Google Cloud Vision Web
// Detection) first, and when that finds pages featuring this exact image,
// THAT is real, citable, source-grounded evidence — the same kind of
// thing quick-check.ts/deep-investigation.ts get from Tavily search for
// text claims. So Deep Investigation on a photo can now genuinely say "an
// article from 2019 shows this same photo in a different context" with
// real cited URLs, not just "the pixels don't show obvious editing".
// Quick Check deliberately does NOT call Web Detection (cost/latency —
// same Quick-stays-cheap-and-fast principle applied everywhere else in
// this app) and so still can't make that kind of claim; its schema
// doesn't even offer the verdict that would require it (see
// buildVisionSchema below) — code-enforced, not just prompt-instructed,
// so a model that ignores instructions still can't produce it.
//
// Verdict vocabulary, still deliberately NOT the True/False/Misleading/
// Unverified/Scam set text claims get (Part 19's evidence-grounding
// principle + the Sept 14 Scam-verdict false-positive lesson both apply
// directly — see the original version of this file's rationale, still
// true for the vision-only Quick Check path):
//   - "Clean"          — no visual signs of manipulation/AI-generation
//                         found. Does NOT mean "confirmed authentic" — a
//                         well-made fake can look Clean to visual
//                         inspection alone; the caveats below say so on
//                         every result, not just when the model mentions
//                         it.
//   - "Suspicious"      — specific, describable visual indicators found
//                         (listed in caveats).
//   - "Inconclusive"    — image quality too low, or signals point
//                         different directions.
//   - "Out of Context"  — Deep Investigation ONLY, and only reachable when
//                         Web Detection actually returned matching pages:
//                         the image itself may be unedited, but it
//                         genuinely appears elsewhere online in a way that
//                         contradicts or doesn't support the context
//                         claimed for it here. This is the single most
//                         valuable thing Web Detection unlocks — recycled/
//                         mislabeled real photos are a bigger real-world
//                         misinformation pattern than crude edits.
// confidence always reflects confidence in the SIGNALS/EVIDENCE found,
// never a claim about "is this photo real" beyond what was actually
// observed — the code-enforced disclaimer caveat exists so this
// distinction survives even if a given model response phrases things
// loosely.
//
// Media retention (Part 15): the image reaches the server and the AI/
// Vision providers as inline base64 data and is NEVER written to Supabase
// storage or any other persistence layer by this file or its callers
// (app/api/verify-image/route.ts, app/api/deep-image/route.ts) — it exists
// only in server memory for the duration of the request, same
// "process, don't retain" principle Part 15 calls for, just enacted by
// never storing it in the first place rather than upload-then-auto-delete.
//
// Caching: deliberately NOT integrated with verification-cache.ts — see
// the original rationale (real photos are essentially never byte-
// identical on resubmission, so an exact-match cache would almost never
// hit). Web Detection results aren't cached either for the same reason.
//
// Output localization (Sept 16, 2026 fast-follow) — see
// lib/video-analysis.ts's identical comment for the full rationale; same
// mechanism applied here. Image has no ai_generated_* fields, so only
// "summary" and each "signals_found" item get the prompt instruction.

export const IMAGE_QUICK_ENGINE_VERSION = "v1-gemini-vision-quick";
export const IMAGE_DEEP_ENGINE_VERSION = "v2-gemini-vision-webdetect-deep";

// Sept 15, 2026: added after a live 503 surfaced this gap on text Deep
// Investigation's identical call (see deep-investigation.ts's
// SYNTHESIS_FALLBACK_MODELS for the full story) — modelForTier's
// "reasoning" tier now points every Deep Investigation pipeline at
// gemini-3.8-flash, but the fallback safety net had only ever been wired
// into video Deep Investigation. Image shares the same exposure. (Not an
// engine_version bump — this file's Deep Investigation is never cached in
// the first place, see the comment above, so there's no stale-cache risk
// to invalidate here, just the same missing resilience to add.)
const IMAGE_DEEP_FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

// Sept 17, 2026: added after a live, reproducing 503 on audio-transcript.ts's
// identical cheap-tier call (see that file's header) showed this project is
// currently exposed to real Gemini transient errors on the "cheap" tier too,
// not just "reasoning" — and a sweep of every callStructured() call in the
// codebase found image-analysis.quick was one of three cheap-tier calls
// still missing a fallback net entirely (the others: quick-check.verdict,
// video-analysis.quick — see those files' identical comments). Falls UP to
// a stronger model rather than down, same reasoning as every other
// cheap-tier fallback added today: a fully failed image Quick Check is
// worse than occasionally spending more on the rare fallback case.
const IMAGE_QUICK_FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.8-flash"];

export interface ImageAnalysisResult {
  verdict: string;
  confidence: number;
  summary: string;
  key_evidence: QuickCheckEvidence[]; // only ever populated by Deep Investigation, from real Web Detection matches
  sources: { title: string; url: string }[];
  caveats: string[];
  engine_version: string;
}

const BASE_VERDICTS = ["Clean", "Suspicious", "Inconclusive"];
const DEEP_VERDICTS = [...BASE_VERDICTS, "Out of Context"];

function buildVisionSchema(verdicts: string[]) {
  return {
    type: "object",
    properties: {
      verdict: { type: "string", enum: verdicts },
      confidence: { type: "integer" },
      summary: { type: "string" },
      signals_found: { type: "array", items: { type: "string" } },
      context_match: { type: "string", enum: ["consistent", "inconsistent", "not_applicable"] },
      cited_page_ids: { type: "array", items: { type: "integer" } },
    },
    required: ["verdict", "confidence", "summary", "signals_found", "context_match", "cited_page_ids"],
  };
}

interface VisionOutput {
  verdict: string;
  confidence: number;
  summary: string;
  signals_found: string[];
  context_match: string;
  cited_page_ids: number[];
}

// Shared instruction core for both tiers — the honesty/grounding rules are
// non-negotiable regardless of how thorough the pass is, so they're
// written once and reused rather than risking drift between two prompts.
const HONESTY_RULES = `You are analyzing the pixels of this one image, plus (if provided below) a list of web pages where this same image was found elsewhere. You have no other access to metadata or any external database, and no way to confirm when, where, or by whom this photo was actually taken beyond what the provided web pages, if any, actually say.
- Use "Suspicious" only when you can point to specific, describable visual evidence in signals_found (inconsistent lighting, shadows, or reflections; blending or edge artifacts; warped, repeated, or unnaturally smooth textures typical of AI generation; anatomical errors; garbled or nonsensical text rendered inside the image; compression-artifact inconsistencies suggesting a composite). Never choose "Suspicious" from a vague sense that something "looks off" with nothing specific to point to.
- Use "Clean" when no such signals were found. This means nothing suspicious was visually detected — it does NOT mean the image is confirmed authentic; a well-made fake or an untouched real photo can look identical to visual inspection.
- Use "Inconclusive" when image quality/resolution is too low to assess meaningfully, or when signals point in genuinely different directions.
- confidence (0-100) reflects how confident you are in the signals/evidence you found (or didn't find) — never let it imply certainty about whether the photo is "real."
- If context describing what the image is supposed to show is given below, separately judge context_match: "consistent" if the visible content is plausible with that description, "inconsistent" if there is a clear, describable visual mismatch you can name, "not_applicable" if no context was given or the image gives no basis to judge it either way.
- cited_page_ids must contain ONLY the bracketed numbers of any web pages listed below that you actually relied on. Leave it empty if no pages were listed or none were relevant. Never invent a page or a number that wasn't given to you.
Respond with only the requested JSON — no extra commentary, no markdown.`;

const QUICK_SYSTEM_PROMPT = `You are Vuryfy's image Quick Check engine, giving a fast first-pass visual read of a photo. No web pages will ever be listed for you — you are working from pixels alone. ${HONESTY_RULES}`;

const DEEP_SYSTEM_PROMPT = `You are Vuryfy's image Deep Investigation engine, giving a slower, more thorough read of a photo than a Quick Check. Look carefully across the whole frame — foreground and background, edges between distinct objects/people, lighting direction and shadow consistency across every element, reflections, hands/faces for anatomical errors, and any text visible inside the image for garbling.
If web pages featuring this same image are listed below, weigh them as real evidence: use verdict "Out of Context" ONLY when those pages show this exact image was already circulating in a different context than what's claimed here (e.g. from an earlier event, a different location, a different story entirely) — cite the specific page ids in cited_page_ids. Do not use "Out of Context" just because pages were listed; only when they actually establish a mismatch. ${HONESTY_RULES}`;

// Output localization (Sept 16, 2026) — mirrors quick-check.ts's
// languageInstruction() exactly, just naming this file's own free-text
// fields.
function languageInstruction(language: Language): string {
  if (language === "en") return "";
  return `\n\nWrite the "summary" field and each item in "signals_found" in natural, fluent ${LANGUAGE_NAMES[language]}.`;
}

function buildUserPrompt(context: string | null, webPages: MatchingPage[]): string {
  const contextLine = context && context.trim().length > 0
    ? `Context the user provided about what this image is supposed to show:\n"${context.trim()}"\n\n`
    : `No context was provided about what this image is supposed to show.\n\n`;

  const webBlock = webPages.length > 0
    ? `Web pages found featuring this same image:\n${webPages.map((p, i) => `[${i + 1}] ${p.pageTitle}\nURL: ${p.url}`).join("\n\n")}\n\n`
    : `No web pages featuring this image were found.\n\n`;

  return `${contextLine}${webBlock}Analyze the attached image.`;
}

function toResult(
  data: VisionOutput,
  engineVersion: string,
  allowedVerdicts: string[],
  webPages: MatchingPage[],
  language: Language
): ImageAnalysisResult {
  const verdict = allowedVerdicts.includes(data.verdict) ? data.verdict : "Inconclusive";
  const confidence = Number.isFinite(data.confidence) ? Math.max(0, Math.min(100, Math.round(data.confidence))) : 0;
  const summary =
    typeof data.summary === "string" && data.summary.trim()
      ? data.summary.trim()
      : translate(language, "pipeline.common.noExplanation");
  const signals = Array.isArray(data.signals_found)
    ? data.signals_found.filter((s) => typeof s === "string" && s.trim().length > 0)
    : [];

  // Code-enforced grounding (Part 19, same pattern as quick-check.ts/
  // deep-investigation.ts): only trust cited ids that actually point into
  // the web pages we actually retrieved.
  const citedIds = Array.isArray(data.cited_page_ids) ? data.cited_page_ids : [];
  const keyEvidence: QuickCheckEvidence[] = citedIds
    .filter((id) => Number.isInteger(id) && id >= 1 && id <= webPages.length)
    .map((id) => {
      const p = webPages[id - 1];
      return { title: p.pageTitle, url: p.url };
    });
  const sources = keyEvidence.map((e) => ({ title: e.title, url: e.url }));

  const caveats: string[] = [translate(language, "pipeline.image.disclaimer")];
  for (const s of signals) caveats.push(`${translate(language, "pipeline.common.observedPrefix")}${s.trim()}`);
  if (data.context_match === "inconsistent") {
    caveats.push(translate(language, "pipeline.image.contextInconsistent"));
  } else if (data.context_match === "consistent") {
    caveats.push(translate(language, "pipeline.image.contextConsistent"));
  }
  if (verdict === "Out of Context" && keyEvidence.length === 0) {
    // Should be unreachable given the prompt instruction, but never let an
    // "Out of Context" verdict stand with zero cited evidence behind it —
    // downgrade defensively rather than surface an ungrounded claim.
    return toResult({ ...data, verdict: "Inconclusive" }, engineVersion, allowedVerdicts, webPages, language);
  }

  return {
    verdict,
    confidence,
    summary,
    key_evidence: keyEvidence,
    sources,
    caveats,
    engine_version: engineVersion,
  };
}

export async function runImageQuickCheck(
  imageBase64: string,
  mimeType: string,
  context: string | null,
  language: Language = "en"
): Promise<ImageAnalysisResult> {
  const { data } = await callStructured<VisionOutput>({
    tier: "cheap",
    systemPrompt: QUICK_SYSTEM_PROMPT + languageInstruction(language),
    userPrompt: buildUserPrompt(context, []),
    responseSchema: buildVisionSchema(BASE_VERDICTS),
    imageParts: [{ mimeType, data: imageBase64 }],
    timeoutMs: 20_000,
    fallbackModels: IMAGE_QUICK_FALLBACK_MODELS,
    callSite: "image-analysis.quick",
  });
  return toResult(data, IMAGE_QUICK_ENGINE_VERSION, BASE_VERDICTS, [], language);
}

export async function runImageDeepInvestigation(
  imageBase64: string,
  mimeType: string,
  context: string | null,
  language: Language = "en"
): Promise<ImageAnalysisResult> {
  // Fails open — a missing key or a Vision API error just means no web
  // evidence for this run, not a failed investigation (see
  // lib/web-detection.ts).
  const webResult = await detectWeb(imageBase64, "image-analysis.deep.web-detection").catch(() => null);
  const webPages = webResult?.matchingPages ?? [];

  const { data } = await callStructured<VisionOutput>({
    tier: "reasoning",
    systemPrompt: DEEP_SYSTEM_PROMPT + languageInstruction(language),
    userPrompt: buildUserPrompt(context, webPages),
    responseSchema: buildVisionSchema(DEEP_VERDICTS),
    imageParts: [{ mimeType, data: imageBase64 }],
    timeoutMs: 25_000,
    fallbackModels: IMAGE_DEEP_FALLBACK_MODELS,
    callSite: "image-analysis.deep",
  });
  return toResult(data, IMAGE_DEEP_ENGINE_VERSION, DEEP_VERDICTS, webPages, language);
}
