import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import type { QuickCheckEvidence } from "@/lib/quick-check";
import { embedText, EMBEDDING_DIMENSIONS } from "@/lib/embeddings";

// Exact-match cache (Part 11, LOCKED — "Exact" layer of the three-layer
// cache). Backed by the verification_cache_exact table from 0001_init.sql,
// which existed in the schema from day one but was never wired up until
// Sept 14, 2026.
//
// Design: cache_key = sha256(normalized_claim + "|" + input_type + "|" +
// engine_version), computed here in application code (per the table's own
// comment in the migration). A cache HIT means we skip the AI Gateway and
// Search Gateway entirely for that request — no Gemini call, no Tavily
// call — and serve the previously-computed verdict/evidence instead. The
// caller (app/api/verify/route.ts) still creates a fresh per-user
// `verifications` row and still charges the normal credit on a hit — see
// that file's comments for why.
//
// Shared with Deep Investigation (app/api/deep/route.ts, Sept 14, 2026):
// these functions are generic over the caller, not Quick-Check-specific.
// Cache keys never collide between the two modes because engine_version
// differs ("v2-gemini-tavily" vs "v2-gemini-tavily-deep"), which is one of
// the three inputs computeCacheKey() hashes over.
//
// Semantic cache (Part 11's "Semantic" layer, Part 26.4 addition #2 —
// deferred at Phase 1, built Sept 16, 2026) added below the Exact-cache
// section. IMPORTANT lesson learned the hard way (see architecture-
// decisions.md "Model-tier differentiation fix"): engine_version must be
// bumped whenever a cached pipeline's underlying model/prompt/schema
// changes, in EITHER cache layer — a stale semantic-cache entry is exactly
// as invisible and exactly as wrong as a stale exact-cache entry.

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// Shared TTL for audio/video-authenticity caching (see writeCache's
// explicitFreshness note below) — "medium" tier, same 14-day window
// classifyFreshness() already uses as its default for non-time-sensitive
// text claims.
export const AUDIO_CACHE_FRESHNESS: FreshnessResult = { freshnessClass: "medium", ttlMs: 14 * DAY_MS };

// Sept 16, 2026 addition: a 4th, much longer tier for claims about facts
// that are, for all practical purposes, permanently fixed — not "unlikely
// to change soon" (that's what "medium" already covers) but genuinely
// evergreen. Deliberately narrow and keyword-whitelist-only rather than
// inferred: per this file's own long-standing caution (see the V1 scope
// note originally left on this classifier), guessing wrong in the "long"
// direction is the expensive mistake for a trust product — a stale WRONG
// verdict, served confidently for months. So this only matches a short,
// hand-picked list of named physical/mathematical constants and laws that
// are about as close to "will never be revised" as any real-world fact
// gets. This list is intentionally small; expand it only with real
// candidates that are equally uncontroversial, not by loosening the
// pattern to catch more claims. Historical events, geography (mountain
// heights, wall lengths — both have been revised by remeasurement in this
// app's own test history), and biological/medical "facts" are deliberately
// EXCLUDED even though many of them feel stable, because "feels stable" is
// exactly the trap this caution exists to avoid.
const LONG_RE =
  /\b(speed of light|absolute zero|boiling point of water|freezing point of water|value of pi|pythagorean theorem|avogadro'?s number|newton'?s (first|second|third) laws? of motion|law of gravity|speed of sound|periodic table of elements)\b/i;
const LONG_TTL_MS = 180 * DAY_MS;

export type FreshnessClass = "very_short" | "short" | "medium" | "long";

export interface FreshnessResult {
  freshnessClass: FreshnessClass;
  ttlMs: number;
}

export interface CachedVerification {
  verdict: string;
  confidence: number;
  summary: string;
  key_evidence: QuickCheckEvidence[];
  sources: { title: string; url: string }[];
  // Deep Investigation only (Sept 14, 2026 addition) — always present on
  // the underlying verifications row (defaults to '[]'), empty for every
  // Quick Check row since that pipeline doesn't produce caveats.
  caveats: string[];
  engine_version: string;
  cached_at: string;
}

export function computeCacheKey(normalizedClaim: string, inputType: string, engineVersion: string): string {
  return createHash("sha256").update(`${normalizedClaim}|${inputType}|${engineVersion}`).digest("hex");
}

// Cheap, keyword-based freshness classifier — deliberately NOT another AI
// call (that would defeat the point of caching: paying for a model call to
// decide whether to avoid a model call). Per Part 11's freshness_class
// categories (historical/scientific = long, government schemes = medium,
// current events = short, stock prices/breaking news = very short).
//
// Checked in most-time-sensitive-first order so a claim that happens to
// match more than one pattern (unlikely, but possible) errs toward the
// shorter, safer TTL.
const VERY_SHORT_RE = /\b(stock price|share price|exchange rate|live score|breaking news|right now|as of today|weather (today|now))\b/i;
const SHORT_RE = /\b(current|currently|latest|today|tonight|this week|this month|\bnow\b)\b/i;

function mentionsRecentYear(claim: string): boolean {
  const year = new Date().getFullYear();
  const re = new RegExp(`\\b(${year - 1}|${year}|${year + 1})\\b`);
  return re.test(claim);
}

export function classifyFreshness(claim: string): FreshnessResult {
  if (VERY_SHORT_RE.test(claim)) {
    return { freshnessClass: "very_short", ttlMs: 1 * HOUR_MS };
  }
  if (SHORT_RE.test(claim) || mentionsRecentYear(claim)) {
    return { freshnessClass: "short", ttlMs: 24 * HOUR_MS };
  }
  if (LONG_RE.test(claim)) {
    return { freshnessClass: "long", ttlMs: LONG_TTL_MS };
  }
  return { freshnessClass: "medium", ttlMs: 14 * DAY_MS };
}

// Returns the cached verdict if a live (non-expired) entry exists, or null
// on a miss OR on any lookup failure. Deliberately fails OPEN (treats an
// error as a cache miss rather than throwing) — a caching bug should never
// be able to take down the core Quick Check flow.
export async function getCachedVerification(
  admin: SupabaseClient,
  cacheKey: string
): Promise<CachedVerification | null> {
  try {
    const { data: cacheRow, error: cacheError } = await admin
      .from("verification_cache_exact")
      .select("verification_id, expires_at, created_at")
      .eq("cache_key", cacheKey)
      .maybeSingle();

    if (cacheError) {
      console.error("[cache] lookup failed:", cacheError);
      return null;
    }
    if (!cacheRow) return null;
    if (new Date(cacheRow.expires_at).getTime() <= Date.now()) return null; // expired — treat as a miss

    const { data: original, error: verError } = await admin
      .from("verifications")
      .select("verdict, confidence, summary, key_evidence, sources, caveats, engine_version")
      .eq("id", cacheRow.verification_id)
      .maybeSingle();

    if (verError || !original) {
      console.error("[cache] original verification missing or fetch failed:", verError);
      return null;
    }

    return { ...original, cached_at: cacheRow.created_at };
  } catch (err) {
    console.error("[cache] unexpected lookup error:", err);
    return null;
  }
}

// Upserts the cache entry (upsert, not insert, so re-caching an expired
// claim replaces the old row rather than colliding on the cache_key
// primary key). Non-fatal on failure — same pattern as the other
// secondary/audit writes in route.ts: log and move on, never fail the
// user's actual request over a caching write.
//
// explicitFreshness (added Sept 15, 2026 for audio caching — see
// app/api/verify-audio/route.ts and friends): classifyFreshness()'s
// keyword regexes are written for TEXT CLAIMS ("current", "as of today",
// a recent year) and mean nothing run against a raw audio/base64 blob.
// Audio content doesn't go stale the way a claim about current events
// does — an authenticity verdict on a specific recording is a fixed
// property of that file, if anything arguably safe to cache even longer
// than "medium" — so audio/video-authenticity callers pass an explicit
// freshness instead of letting classifyFreshness misread binary data. Text
// callers (Quick Check, Deep Investigation, and the transcript half of
// audio/video combined checks) are unaffected — they still omit this and
// get the keyword-based classification as before.
export async function writeCache(
  admin: SupabaseClient,
  cacheKey: string,
  verificationId: string,
  claim: string,
  explicitFreshness?: FreshnessResult
): Promise<void> {
  const { freshnessClass, ttlMs } = explicitFreshness ?? classifyFreshness(claim);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const { error } = await admin.from("verification_cache_exact").upsert(
    {
      cache_key: cacheKey,
      verification_id: verificationId,
      freshness_class: freshnessClass,
      expires_at: expiresAt,
    },
    { onConflict: "cache_key" }
  );

  if (error) {
    console.error("[cache] write failed:", error);
  }
}

// ---------------------------------------------------------------------
// Semantic cache — Part 11's deferred "Semantic" layer, built Sept 16,
// 2026. Backed by supabase/migrations/0010_semantic_cache.sql
// (verification_cache_semantic table + pgvector + the
// match_verification_cache Postgres function).
//
// Only ever consulted on an EXACT-cache MISS (see checkSemanticCache) —
// exact match is cheaper (no embedding call) and, when it hits, is by
// definition the same claim, so there's no reason to also pay for an
// embedding call first. Semantic matching exists to catch near-duplicate
// phrasings of the same claim (a WhatsApp forward reworded slightly, a
// translated-then-retyped claim, minor punctuation/wording differences)
// that the exact hash would otherwise miss entirely.
//
// Threshold (Part 26.4 addition #2's locked principle: "false matches are
// worse than missed opportunities" — launch with a deliberately HIGH
// threshold, tune down later with real data, never the other direction).
// 0.95 cosine similarity is a conservative starting point for
// gemini-embedding-2 — genuinely paraphrased near-duplicate claims
// typically score well above this, while claims that are merely on the
// same topic (not the same claim) typically score well below it. This is
// a STARTING value, not a tuned one — there is no real hit-rate/accuracy
// data yet to tune against, the same honest caveat Part 26.4's own text
// already applies to this exact design decision. Revisit once there's
// real usage data (false-match reports, or a semantic-hit-rate that's
// suspiciously near zero suggesting the bar is too high).
export const SEMANTIC_MATCH_THRESHOLD = 0.95;

interface SemanticMatchRow {
  verification_id: string;
  similarity: number;
  created_at: string;
}

// Looks up a semantic match for an already-computed embedding. Returns
// null on a miss OR on any failure — same fail-open convention as
// getCachedVerification. Callers should prefer checkSemanticCache() below,
// which also computes the embedding; this lower-level function exists so a
// caller that already has an embedding (there are none yet, but a future
// evidence-layer cache might) doesn't pay for a redundant embed call.
export async function getSemanticCacheMatch(
  admin: SupabaseClient,
  embedding: number[],
  inputType: string,
  engineVersion: string
): Promise<CachedVerification | null> {
  try {
    const { data: matches, error: matchError } = await admin.rpc("match_verification_cache", {
      query_embedding: embedding,
      p_input_type: inputType,
      p_engine_version: engineVersion,
      match_threshold: SEMANTIC_MATCH_THRESHOLD,
      match_count: 1,
    });

    if (matchError) {
      console.error("[semantic-cache] match RPC failed:", matchError);
      return null;
    }
    const top = (matches as SemanticMatchRow[] | null)?.[0];
    if (!top) return null;

    const { data: original, error: verError } = await admin
      .from("verifications")
      .select("verdict, confidence, summary, key_evidence, sources, caveats, engine_version")
      .eq("id", top.verification_id)
      .maybeSingle();

    if (verError || !original) {
      console.error("[semantic-cache] matched verification missing or fetch failed:", verError);
      return null;
    }

    return { ...original, cached_at: top.created_at };
  } catch (err) {
    console.error("[semantic-cache] unexpected lookup error:", err);
    return null;
  }
}

// Computes an embedding for normalizedClaim and checks for a semantic
// match, in one call. Returns the embedding alongside the match (or null
// match on a miss) so a genuine cache-miss caller can reuse the same
// embedding to write a new semantic-cache row after running the real
// pipeline, without embedding the same text twice. Returns
// { match: null, embedding: null } if the embedding call itself fails
// (fails open, same as every other cache/provider call in this file).
export async function checkSemanticCache(
  admin: SupabaseClient,
  normalizedClaim: string,
  inputType: string,
  engineVersion: string
): Promise<{ match: CachedVerification | null; embedding: number[] | null }> {
  // Sept 16, 2026: callSite built from inputType (already passed in by
  // every caller) rather than adding a new param here — cost-log rows land
  // as e.g. "semantic-cache:quick_check" / "semantic-cache:deep_investigation",
  // distinguishing which pipeline paid for the embedding without touching
  // checkSemanticCache's own callers.
  const embedding = await embedText(normalizedClaim, `semantic-cache:${inputType}`);
  if (!embedding) return { match: null, embedding: null };

  const match = await getSemanticCacheMatch(admin, embedding, inputType, engineVersion);
  return { match, embedding };
}

// Writes a new semantic-cache row. Non-fatal on failure, same pattern as
// writeCache. Only called on a genuine full miss (neither exact nor
// semantic matched) — same "only write on a real miss" principle writeCache
// already follows, for the same reason: a hit already has a live row
// somewhere, and writing another one buys nothing.
export async function writeSemanticCache(
  admin: SupabaseClient,
  embedding: number[],
  inputType: string,
  engineVersion: string,
  verificationId: string,
  normalizedClaim: string,
  claim: string,
  explicitFreshness?: FreshnessResult
): Promise<void> {
  if (embedding.length !== EMBEDDING_DIMENSIONS) {
    console.error(
      `[semantic-cache] embedding has ${embedding.length} dims, expected ${EMBEDDING_DIMENSIONS} — skipping write`
    );
    return;
  }
  const { freshnessClass, ttlMs } = explicitFreshness ?? classifyFreshness(claim);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  const { error } = await admin.rpc("upsert_verification_cache_semantic", {
    p_input_type: inputType,
    p_engine_version: engineVersion,
    p_normalized_claim: normalizedClaim,
    p_embedding: embedding,
    p_verification_id: verificationId,
    p_freshness_class: freshnessClass,
    p_expires_at: expiresAt,
  });

  if (error) {
    console.error("[semantic-cache] write failed:", error);
  }
}
