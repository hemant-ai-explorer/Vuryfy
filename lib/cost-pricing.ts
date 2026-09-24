// Cost pricing constants — the "small file with the current $/token and
// $/search-credit prices" piece of the real cost-tracking build (Part 19,
// LOCKED: "cost per verification must be logged from day one" — never
// actually wired up until Sept 16, 2026; see architecture-decisions.md's
// cost-tracking entry for the full story). Paired with the api_cost_logs
// table (supabase/migrations/0012_api_cost_logs.sql) and the logging calls
// in lib/ai-gateway.ts, lib/search-gateway.ts, lib/embeddings.ts, and (added
// Sept 24, 2026) lib/web-detection.ts and lib/detect-text.ts — the five
// files that between them make every metered external call this app makes
// (Part 11's "AI/Search Gateway" lock is exactly what makes this a small,
// fixed set of files to touch instead of every route).
//
// PRICES ARE HARDCODED SNAPSHOTS, confirmed current as of Sept 16, 2026 —
// not fetched live from any provider. They WILL drift as providers change
// pricing; there is no alarm that fires when that happens. Revisit this
// file whenever a provider changes pricing, or whenever a new model is
// added to ai-gateway.ts's modelForTier() or any fallbackModels list —
// an unpriced model logs a $0 estimate (see estimateGeminiCostUsd below)
// rather than breaking the call it's attached to, so a stale/missing price
// is silent unless someone is actually looking at the numbers. That's an
// accepted tradeoff for a cost-*visibility* feature, not a billing system.
//
// These are all "estimated" costs by design — the goal is a real, useful
// order-of-magnitude view of where money actually goes (replacing pure
// guesswork), not a cent-accurate reconciliation against provider invoices.

export const USD_TO_INR = 95.93; // xe.com, Sept 16, 2026 — for chat-facing INR figures only; every stored value stays USD.

interface GeminiModelPricing {
  inputPerMillion: number; // $/1M input tokens, text/image/video input
  audioInputPerMillion?: number; // $/1M input tokens, raw audio input — only set for models where Google actually prices this input type separately
  outputPerMillion: number; // $/1M output tokens
}

// Only models actually reachable via ai-gateway.ts's modelForTier() or any
// caller's fallbackModels list need an entry here.
export const GEMINI_PRICING: Record<string, GeminiModelPricing> = {
  // Through Dec 31, 2026 per Google's current published rate; confirm again
  // if that promo window has lapsed.
  "gemini-3.1-flash-lite": { inputPerMillion: 0.25, audioInputPerMillion: 0.5, outputPerMillion: 1.5 },
  "gemini-3.5-flash-lite": { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  // Promo rate through Dec 31, 2026 — becomes $1.50/$7.50 after. Revisit
  // this entry once that date passes.
  // Sept 17, 2026: no audioInputPerMillion here is CONFIRMED CORRECT, not a
  // gap — checked Google's own pricing page (ai.google.dev/gemini-api/docs/
  // pricing) directly. Unlike gemini-3.1-flash-lite above (which Google
  // prices at 2x for audio input), gemini-3.8-flash has no separate audio
  // rate at all: $0.75/1M applies uniformly to text/image/video/audio
  // input alike. So every audio-analysis.quick/audio-analysis.deep call
  // using this model (audio-analysis.ts) has been costed correctly in
  // api_cost_logs all along — this was flagged as an open question in an
  // earlier addendum entry and is now resolved, no code change needed
  // beyond this comment.
  "gemini-3.8-flash": { inputPerMillion: 0.75, outputPerMillion: 3.75 },
  // Embeddings are input-only — Google charges nothing for the returned
  // vector (confirmed via provider pricing pages, Sept 16, 2026).
  "gemini-embedding-2": { inputPerMillion: 0.2, outputPerMillion: 0 },
};

export const TAVILY_COST_PER_CREDIT_USD = 0.008; // pay-as-you-go rate; volume discounts (~$0.005/credit at high volume) not modeled here
export const TAVILY_CREDITS_PER_BASIC_SEARCH = 1; // search-gateway.ts always calls Tavily with search_depth: "basic", which is deterministically 1 credit — no need to parse credit usage from the response

// Google Cloud Vision — Web Detection (lib/web-detection.ts, called only
// from image Deep Investigation). Sept 24, 2026 addition, closing the gap
// flagged in an earlier cost-instrumentation pull: this provider was never
// priced or logged at all. Flat per-call rate, not token-based like Gemini
// or credit-based like Tavily — Google's published standard rate is
// $3.50 per 1,000 units after the first 1,000 free calls/month (per
// cloud.google.com/vision/pricing, confirmed Sept 24, 2026). Same
// simplification the Tavily rate above already makes for its own volume
// discount: the free tier isn't modeled here, so every call is costed at
// the standard per-unit rate — slightly overstates true spend while a
// month's usage is still inside the free tier, exact once past it.
export const GOOGLE_VISION_WEB_DETECTION_COST_PER_CALL_USD = 0.0035;

export function estimateGoogleVisionCostUsd(calls: number = 1): number {
  return calls * GOOGLE_VISION_WEB_DETECTION_COST_PER_CALL_USD;
}

// Google Cloud Vision — Text Detection (lib/detect-text.ts, added Sept 24,
// 2026 replacing client-side Tesseract.js OCR — see that file's header for
// why: 40-50s of in-browser multi-language WASM recognition on every photo
// versus a ~1-2s server call). DOCUMENT_TEXT_DETECTION is priced separately
// from WEB_DETECTION above (cheaper: $1.50/1,000 units vs $3.50/1,000,
// same first-1,000-free-per-month structure, per cloud.google.com/vision/
// pricing, confirmed Sept 24, 2026). Same free-tier simplification as
// GOOGLE_VISION_WEB_DETECTION_COST_PER_CALL_USD above: every call is costed
// at the standard per-unit rate, not modeling the free tier.
export const GOOGLE_VISION_TEXT_DETECTION_COST_PER_CALL_USD = 0.0015;

export function estimateGoogleVisionTextDetectionCostUsd(calls: number = 1): number {
  return calls * GOOGLE_VISION_TEXT_DETECTION_COST_PER_CALL_USD;
}

// inputModality distinguishes Gemini's separate (higher) per-token rate for
// raw audio input on models that price it that way — see audioInputPerMillion
// above. Callers with audioParts set (audio-transcript.ts, audio-analysis.ts)
// pass "audio"; every other caller (text, image, video) omits this and gets
// the default text/image/video rate.
export function estimateGeminiCostUsd(
  model: string,
  promptTokens: number,
  outputTokens: number,
  inputModality: "text" | "audio" = "text"
): number {
  const pricing = GEMINI_PRICING[model];
  if (!pricing) {
    console.error(`[cost-pricing] no pricing entry for Gemini model "${model}" — logging $0 estimated cost; add it to GEMINI_PRICING`);
    return 0;
  }
  const inputRate =
    inputModality === "audio" && pricing.audioInputPerMillion !== undefined
      ? pricing.audioInputPerMillion
      : pricing.inputPerMillion;
  return (promptTokens / 1_000_000) * inputRate + (outputTokens / 1_000_000) * pricing.outputPerMillion;
}

export function estimateTavilySearchCostUsd(credits: number = TAVILY_CREDITS_PER_BASIC_SEARCH): number {
  return credits * TAVILY_COST_PER_CREDIT_USD;
}
