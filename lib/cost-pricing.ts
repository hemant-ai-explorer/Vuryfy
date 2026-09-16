// Cost pricing constants — the "small file with the current $/token and
// $/search-credit prices" piece of the real cost-tracking build (Part 19,
// LOCKED: "cost per verification must be logged from day one" — never
// actually wired up until Sept 16, 2026; see architecture-decisions.md's
// cost-tracking entry for the full story). Paired with the api_cost_logs
// table (supabase/migrations/0012_api_cost_logs.sql) and the logging calls
// in lib/ai-gateway.ts, lib/search-gateway.ts, and lib/embeddings.ts — the
// three files that between them make every metered external call this app
// makes (Part 11's "AI/Search Gateway" lock is exactly what makes this a
// 3-file change instead of touching every route).
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
  "gemini-3.8-flash": { inputPerMillion: 0.75, outputPerMillion: 3.75 },
  // Embeddings are input-only — Google charges nothing for the returned
  // vector (confirmed via provider pricing pages, Sept 16, 2026).
  "gemini-embedding-2": { inputPerMillion: 0.2, outputPerMillion: 0 },
};

export const TAVILY_COST_PER_CREDIT_USD = 0.008; // pay-as-you-go rate; volume discounts (~$0.005/credit at high volume) not modeled here
export const TAVILY_CREDITS_PER_BASIC_SEARCH = 1; // search-gateway.ts always calls Tavily with search_depth: "basic", which is deterministically 1 credit — no need to parse credit usage from the response

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
