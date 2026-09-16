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
const EMBEDDING_MODEL = "gemini-embedding-2";
const OUTPUT_DIMENSIONALITY = 768;
export const EMBEDDING_DIMENSIONS = OUTPUT_DIMENSIONALITY;

interface EmbedContentResponse {
  embedding?: { values?: number[] };
}

// Fails OPEN (returns null on any error), matching the convention already
// established by verification-cache.ts's getCachedVerification and
// web-detection.ts's lookupWebDetection: a semantic-cache bug or a Gemini
// embeddings outage must never be able to break the core verification flow
// — it just means this request falls through to the real pipeline instead
// of a cache hit, which is always correct, just not free.
export async function embedText(text: string): Promise<number[] | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[embeddings] GEMINI_API_KEY not set");
    return null;
  }

  // embedContent's input cap is 8,192 tokens across all Gemini embedding
  // models as of this writing — normalized claims are short, but truncate
  // defensively rather than let an unusually long claim 400 the request.
  const truncated = text.slice(0, 8000);

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
      return null;
    }

    const data = (await res.json()) as EmbedContentResponse;
    const values = data.embedding?.values;
    if (!values || values.length !== OUTPUT_DIMENSIONALITY) {
      console.error("[embeddings] unexpected response shape:", data);
      return null;
    }
    return values;
  } catch (err) {
    console.error("[embeddings] request failed:", err);
    return null;
  }
}
