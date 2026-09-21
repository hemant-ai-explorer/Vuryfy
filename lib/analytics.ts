import { PostHog } from "posthog-node";

// Server-side product analytics (Part 23, LOCKED spec — see
// architecture-decisions.md's "Part 23 — Analytics, Metrics & Business
// Intelligence" entry, and architecture-decisions-addendum-2026-09-21.md
// for the PostHog build itself). Sept 21, 2026.
//
// ARCHITECTURAL SEPARATION (Claude's addition #1 to the lock, carried over
// as a real constraint on this file, not just a comment): this module has
// NO read path back into the verification/reasoning pipeline. It is called
// fire-and-forget, strictly AFTER a route has already decided its response
// — never consulted to decide what a route does, what a verdict is, or
// what a user sees. Nothing in lib/quick-check.ts, lib/deep-investigation.ts,
// or any *-analysis.ts file imports from here, and this file imports
// nothing from them either. Extending this file to read analytics data back
// into a verification decision would break that guarantee and needs to be
// a separate, deliberately reviewed change — never a side effect of adding
// an event.
//
// PRIVACY (per the lock): every call site passes the Supabase auth user id
// as the distinct ID — a pseudonymous identifier, never a phone number,
// name, or email. Event properties below are deliberately limited to
// metadata (mode, input_type, verdict, cached, credit_type, plan_code,
// engine_version) — never claim text, media content, or anything else a
// user submitted. This mirrors Part 15's media-retention principle applied
// to analytics instead of storage.
//
// V1 SCOPE (Sept 21, 2026 decision): Part 23's full spec is a 75-item,
// 8-dashboard framework; this file implements a deliberately smaller
// "core funnel + revenue" subset — acquisition/lifecycle, the verification
// funnel (submitted -> credit check -> completed/failed), verdict
// distribution (via verification_completed's `verdict` property), the
// credit/revenue events, and the Part 15 content-safety tie-in. Deferred
// until there's real usage data: WhatsApp/Instagram-specific events,
// challenge/reversal (the feature itself doesn't exist yet), cohort/
// retention dashboards, heavy-user economics. Extending the event list
// below is additive and cheap — that's the whole point of locking a
// taxonomy early per the Part 23 lock's own recommendation.
//
// Fails OPEN, same convention as every other secondary/audit write in this
// codebase (api/cost-logs, cache writes, content_moderation_flags): a
// PostHog outage, a missing API key, or a malformed property must never be
// able to break or slow down a real user-facing request. track() below
// never throws and is never awaited by its callers.
//
// Serverless note: this client is configured with flushAt: 1 and
// flushInterval: 0 (send-immediately, no batching) specifically because
// Vercel serverless functions can freeze between invocations — a client
// that batches events for later would frequently lose them when the
// function suspends before the next flush. This trades a small per-event
// network call for delivery reliability; since track() is never awaited,
// it adds no latency to the response the caller already sent.

let client: PostHog | null = null;
let warnedMissingKey = false;

function getClient(): PostHog | null {
  const key = process.env.POSTHOG_API_KEY;
  if (!key) {
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.warn(
        "[analytics] POSTHOG_API_KEY not set — server-side events are not being sent. " +
          "See .env.local.example."
      );
    }
    return null;
  }
  if (!client) {
    client = new PostHog(key, {
      host: process.env.POSTHOG_HOST || "https://us.i.posthog.com",
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return client;
}

// The full V1 event taxonomy this file emits. Adding a new event: add it
// here, call track() from the relevant call site, done — no schema
// migration, no separate registration step (PostHog auto-creates event
// definitions on first ingest).
export type AnalyticsEvent =
  // Acquisition / account lifecycle
  | "user_signed_up"
  | "user_signed_in"
  | "user_account_deleted"
  // Verification funnel (Part 23's "submission -> credit reserved ->
  // processing -> completed" — result-viewed/evidence-viewed are covered
  // for free by the client-side pageview capture on /result, see
  // app/providers/posthog-provider.tsx, so there's no separate server event
  // for those two funnel steps)
  | "verification_submitted"
  | "verification_completed"
  | "verification_failed"
  | "credits_exhausted"
  // Revenue
  | "plan_subscribed"
  // Part 15 tie-in — fired from inside lib/content-safety.ts's
  // checkContentSafety(), which every image/audio/video route already
  // calls, so this one call site covers all of them for free.
  | "content_flagged";

interface EventProperties {
  [key: string]: string | number | boolean | null | undefined;
}

export function track(userId: string, event: AnalyticsEvent, properties?: EventProperties): void {
  try {
    const ph = getClient();
    if (!ph) return;
    ph.capture({ distinctId: userId, event, properties });
  } catch (err) {
    // Never let an analytics failure surface to the caller or affect the
    // response already being built — see file header.
    console.error(`[analytics] capture failed for event "${event}":`, err);
  }
}
