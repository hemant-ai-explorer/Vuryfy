import { createAdminClient } from "@/lib/supabase/admin";
import { estimateTavilySearchCostUsd, TAVILY_CREDITS_PER_BASIC_SEARCH } from "@/lib/cost-pricing";

// Search Gateway (Part 11, LOCKED) — the only place in the app that talks
// to a search provider directly. Normalizes results into one SearchResult
// shape (url, title, source, published_at, retrieved_at, snippet, content,
// provider) so callers never depend on a specific provider's response
// format.
//
// V1 "build thin, not full" (Part 11, refinement #3): Tavily only, no
// fallback provider yet. Per Part 11 refinement #1, search itself is a
// deterministic pipeline step decided by application code (see
// lib/quick-check.ts) — never a model-initiated tool call.
//
// Per-call cost logging (Part 19, wired up Sept 16, 2026 alongside the
// identical addition to lib/ai-gateway.ts — see architecture-decisions.md's
// cost-tracking entry): every call here always costs exactly 1 Tavily
// credit (search_depth is always "basic", see the request body below), so
// there's nothing to parse out of the response the way ai-gateway.ts parses
// Gemini's usageMetadata — logCost() below just logs a fixed 1-credit spend
// on success. Callers now pass a required `callSite` label, same convention
// as ai-gateway.ts's callStructured().

export interface SearchResult {
  url: string;
  title: string;
  source: string; // hostname, derived from url
  published_at: string | null;
  retrieved_at: string;
  snippet: string;
  content: string;
  provider: "tavily";
}

export class SearchGatewayError extends Error {
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "SearchGatewayError";
    this.cause = cause;
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Fire-and-forget, same convention as ai-gateway.ts's logCost() — never
// awaited by callers, never allowed to affect the actual search request's
// latency or success/failure.
function logSearchCost(callSite: string, status: "success" | "error", errorMessage?: string): void {
  const credits = TAVILY_CREDITS_PER_BASIC_SEARCH;
  const estimatedCostUsd = status === "success" ? estimateTavilySearchCostUsd(credits) : 0;

  createAdminClient()
    .from("api_cost_logs")
    .insert({
      provider: "tavily",
      model: null,
      tier: null,
      call_site: callSite,
      search_credits: credits,
      estimated_cost_usd: estimatedCostUsd,
      used_fallback: false,
      status,
      error_message: errorMessage ?? null,
    })
    .then(({ error }) => {
      if (error) console.error("[search-gateway] cost log insert failed:", error.message);
    });
}

export async function search(
  query: string,
  callSite: string,
  opts?: { maxResults?: number }
): Promise<SearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    throw new SearchGatewayError("TAVILY_API_KEY is not set");
  }

  let response: Response;
  try {
    response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: opts?.maxResults ?? 6,
        include_answer: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    logSearchCost(callSite, "error", err instanceof Error ? err.message : String(err));
    throw new SearchGatewayError("Tavily request failed (network/timeout)", err);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    logSearchCost(callSite, "error", `API error ${response.status}`);
    throw new SearchGatewayError(`Tavily API error ${response.status}: ${bodyText.slice(0, 500)}`);
  }

  const json = await response.json().catch((err) => {
    logSearchCost(callSite, "error", "response was not valid JSON");
    throw new SearchGatewayError("Tavily response was not valid JSON", err);
  });

  const results: Array<Record<string, unknown>> = Array.isArray(json?.results) ? json.results : [];
  const retrievedAt = new Date().toISOString();

  logSearchCost(callSite, "success");

  return results.map((r) => {
    const url = typeof r.url === "string" ? r.url : "";
    const content = typeof r.content === "string" ? r.content : "";
    return {
      url,
      title: typeof r.title === "string" && r.title ? r.title : url || "Untitled source",
      source: hostnameOf(url),
      published_at: typeof r.published_date === "string" ? r.published_date : null,
      retrieved_at: retrievedAt,
      snippet: content.slice(0, 300),
      content,
      provider: "tavily" as const,
    };
  });
}
