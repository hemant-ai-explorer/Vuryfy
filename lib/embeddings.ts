import { createAdminClient } from "@/lib/supabase/admin";
import { estimateGeminiCostUsd } from "@/lib/cost-pricing";

// Embeddings — the sole embedding-provider call site (Part 11 lock: never
// call an AI/embedding provider directly from application code). Backs the
// Semantic cache layer (see verification-cache.ts's getSemanticCacheMatch/
// writeSemanticCache) — Part 11's three-layer cache design named this layer
// from day one but deferred building it until real usage data existed to
// tune a safe similarity threshold (see architecture-decisions.md "Caching,
// Phase 1" and Part 26.4 addition #2). Built Sept 16, 2026.
//
// Model: gemini-embedding-2 via the same generativelanguage.googleapis.com
// host ai-gateway.ts already calls, same x-goog-api-key auth, no SDK — kept
// consistent with the rest of this codebase's raw-fetch convention rather
// than adding a provider SDK for one call site.
//
// Output dimensionality is fixed at 768 (Google's own middle recommendation
// of 768/1536/3072) — the value is threaded through to the Postgres
// `vector(768)` column type in the semantic-cache migration, so changing
// this constant requires a matching schema migration, not just a code
// change. Chose 768 over 1536/3072 as the cheapest option that Google's own
// docs still call a "recommended" size, not a degraded one.
//
// Per-call cost logging (Part 19, wired up Sept 16, 2026 alongside the
// identical addition to lib/ai-gateway.ts and lib/search-gateway.ts — see
// architecture-decisions.md's cost-tracking entry): unlike generateContent,
// Gemini's embedContent response carries no usageMetadata/token count, so
// there's no exact figure to log here the way ai-gateway.ts logs Gemini's
// own reported token counts. logEmbedCost() below estimates tokens as
// truncated.length / 4 (a standard, rough chars-per-token approximation for
// English-ish text) purely for cost-*estimation* purposes — not a
// billing-accurate count, consistent with this whole feature being
// estimated unit economics, not invoice reconciliation. Callers now pass a
// required `callSite` label, same convention as ai-gateway.ts's
// callStructured() and search-gateway.ts's search().
const EMBEDDING_MODEL = "gemini-embedding-2";
const OUTPUT_DIMENSIONALITY = 768;
export const EMBEDDING_DIMENSIONS = OUTPUT_DIMENSIONALITY;

interface EmbedContentResponse {
  embedding?: { values?: number[] };
}

// Fire-and-forget, same convention as ai-gateway.ts's logCost() — never
// awaited by embedText, never allowed to affect its latency or its
// fail-open behavior.
function logEmbedCost(callSite: string, estimatedTokens: number, status: "success" | "error", errorMessage?: string): void {
  const estimatedCostUsd = status === "success" ? estimateGeminiCostUsd(EMBEDDING_MODEL, estimatedTokens, 0) : 0;

  createAdminClient()
    .from("api_cost_logs")
    .insert({
      provider: "gemini",
      model: EMBEDDING_MODEL,
      tier: null,
      call_site: callSite,
      prompt_tokens: estimatedTokens,
      output_tokens: 0,
      total_tokens: estimatedTokens,
      estimated_cost_usd: estimatedCostUsd,
      used_fallback: false,
      status,
      error_message: errorMessage ?? null,
    })
    .then(({ error }) => {
      if (error) console.error("[embeddings] cost log insert failed:", error.message);
    });
}

// Fails OPEN (returns null on any error), matching the convention already
// established by verification-cache.ts's getCachedVerification and
// web-detection.ts's lookupWebDetection: a semantic-cache bug or a Gemini
// embeddings outage must never be able to break the core verification flow
// — it just means this request falls through to the real pipeline instead
// of a cache hit, which is always correct, just not free.
export async function embedText(text: string, callSite: string): Promise<number[] | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[embeddings] GEMINI_API_KEY not set");
    return null;
  }

  // embedContent's input cap is 8,192 tokens across all Gemini embedding
  // models as of this writing — normalized claims are short, but truncate
  // defensively rather than let an unusually long claim 400 the request.
  const truncated = text.slice(0, 8000);
  const estimatedTokens = Math.ceil(truncated.length / 4);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text: truncated }] },
          output_dimensionality: OUTPUT_DIMENSIONALITY,
        }),
        signal: AbortSignal.timeout(10_000),
      }
    );

    if (!res.ok) {
      console.error(`[embeddings] API error ${res.status}:`, await res.text().catch(() => "<no body>"));
      logEmbedCost(callSite, estimatedTokens, "error", `API error ${res.status}`);
      return null;
    }

    const data = (await res.json()) as EmbedContentResponse;
    const values = data.embedding?.values;
    if (!values || values.length !== OUTPUT_DIMENSIONALITY) {
      console.error("[embeddings] unexpected response shape:", data);
      logEmbedCost(callSite, estimatedTokens, "error", "unexpected response shape");
      return null;
    }
    logEmbedCost(callSite, estimatedTokens, "success");
    return values;
  } catch (err) {
    console.error("[embeddings] request failed:", err);
    logEmbedCost(callSite, estimatedTokens, "error", err instanceof Error ? err.message : String(err));
    return null;
  }
}
