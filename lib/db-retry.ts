import type { PostgrestSingleResponse, SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/admin";

// Sept 16, 2026 — added after a real, reproduced bug: a Quick Check on
// app/api/verify-video-combined/route.ts's `verifications` insert failed
// with Postgres/PostgREST error PGRST102 ("Empty or invalid json") even
// though the exact same insert shape (same columns, same types, values
// confirmed clean — no undefined/NaN/circular values) works correctly on
// every non-video pipeline. PGRST102 specifically means PostgREST's own
// JSON parser rejected the raw HTTP request body BEFORE it ever reached
// Postgres — i.e. the bytes that arrived were genuinely empty or
// truncated, not a data-content problem (a NUL byte or bad Unicode in a
// field would surface as a different Postgres-level error, not this one).
//
// The video-combined/video-only routes are the only pipelines that do
// substantial streamed I/O (a Storage download via
// lib/video-file-pipeline.ts, then a resumable upload to Gemini's File API
// via lib/gemini-file-upload.ts) in the same request, immediately before
// this insert — the working theory is that this leaves Node's shared
// fetch/undici connection pool in a state where the very next unrelated
// POST (this small JSON insert, issued through the same global fetch
// supabase-js uses) goes out with a corrupted/empty body.
//
// Sept 16, 2026, same-day hardening: a single same-client retry (the
// original version of this file) was NOT enough — a Deep Investigation
// retry hit the identical PGRST102 error on its retry attempt too. If the
// corrupted state lives on the shared connection pool itself rather than
// clearing on its own within ~300ms, reusing the SAME SupabaseClient
// instance (and therefore very possibly the same pooled/keep-alive
// socket) for the retry doesn't actually change anything. Fixed by (1)
// building a genuinely NEW SupabaseClient (via createAdminClient()) for
// every retry, so a retry can land on a different underlying connection
// rather than risk reusing the same bad one, and (2) allowing more than
// one retry with increasing backoff, since a single extra attempt clearly
// wasn't reliably enough.
//
// Since PGRST102 fires before Postgres does anything with the request
// body, no row is ever created on a failed attempt — retrying (with any
// number of attempts, on any client) is always safe, never a
// duplicate-insert risk.
//
// Deliberately generic (keyed on the {data, error} shape every
// supabase-js query builder call resolves to) rather than video-specific,
// in case this same connection-corruption pattern is ever seen on another
// route that also does heavy I/O before a DB write (audio's combined
// routes do a similar, smaller download-then-analyze shape and could in
// principle hit the same thing, though it hasn't been reported there).
export async function withRetryOnce<T>(
  attempt: (client: SupabaseClient) => PromiseLike<PostgrestSingleResponse<T>>,
  client: SupabaseClient,
  opts: { retries?: number; baseDelayMs?: number } = {}
): Promise<PostgrestSingleResponse<T>> {
  const retries = opts.retries ?? 2;
  const baseDelayMs = opts.baseDelayMs ?? 400;

  let result = await attempt(client);
  for (let i = 0; i < retries && result.error; i++) {
    console.error(
      `[db-retry] attempt ${i + 1} of ${retries} failed, retrying with a fresh client in ${baseDelayMs * (i + 1)}ms:`,
      result.error
    );
    await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (i + 1)));
    result = await attempt(createAdminClient());
  }
  return result;
}
