import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { track } from "@/lib/analytics";

// Illegal/harmful content handling pipeline (Part 15, LOCKED spec) — Sept
// 19, 2026. See supabase/migrations/0019_content_moderation.sql for the
// schema half of this.
//
// ============================================================================
// THIS IS A STUB. IT DOES NOT DETECT CSAM, NCII, OR ANY OTHER ILLEGAL
// CONTENT TODAY. Do not remove this notice, and do not let anyone — inside
// or outside this project — mistake this module for working content
// safety protection until the TODO below is actually done.
// ============================================================================
//
// Real CSAM hash-matching (Thorn's Safer, Microsoft's PhotoDNA Cloud
// Service) requires a vetted business application directly with that
// provider — there is no API a general-purpose coding assistant can sign
// the operator up for, and building a homegrown perceptual-hash/ML
// "detector" instead would be worse than nothing: it would very likely
// give false confidence that real protection exists, while actually
// catching a small and unpredictable fraction of real illegal content.
// So, per the operator's own decision (Sept 19, 2026 — "not started yet"
// on a provider relationship), this module ships as an honest no-op scan
// wired into the real architecture, not a fake scanner.
//
// What IS real here: every insertion point below (image, audio, video)
// computes a genuine sha256 content hash and calls checkContentSafety()
// BEFORE the media reaches Gemini or any other AI provider, and before any
// credit is charged — exactly where a real hash-matching call would go.
// Wiring in a real provider later is a change to scanContentHash() below
// only; no route changes needed.
//
// TODO before this protects anyone: replace scanContentHash()'s body with
// a real call to a hash-matching provider (Thorn Safer's API is the
// natural fit — it's built for exactly this, submit-a-hash-get-a-match,
// same shape this function already has).
//
// Test path: CONTENT_SAFETY_TEST_HASHES lets the operator verify the
// quarantine flow end-to-end (route refuses to process, credit isn't
// charged, a row lands in content_moderation_flags) using a harmless file
// of their own choosing — never real illegal content. Set it to a
// comma-separated list of sha256 hex hashes; any submission whose content
// hash matches one is treated as flagged. Leave unset in normal operation
// (nothing is ever flagged).
//
// Reporting (Part 15's second requirement — "a defined reporting
// obligation... rather than deletion"): deliberately NOT automated here.
// Per the operator's own decision, this pipeline flags + quarantines +
// logs only. Submitting an actual report (India's cybercrime portal,
// https://cybercrime.gov.in, and potentially NCMEC if content is ever
// hosted on US infrastructure) is a legal act this app does not take on
// the operator's behalf — that needs the operator's own legal counsel's
// sign-off on process, retention, and jurisdiction, taken outside this
// codebase. This module's job ends at making sure the operator can't miss
// that something was flagged.
//
// "Notify" (per the operator's "flag + notify you only" decision): there
// is no email/SMS/Slack alerting infrastructure in this project today, and
// standing one up (a new third-party account, API key, verified sender
// domain) is exactly the kind of new-external-dependency decision that
// deserves its own explicit ask rather than being silently bundled into
// this change. So for now, "notify" means: a loud, greppable
// console.error on every flag (visible in the Vercel dashboard's Function
// Logs, which the operator already checks) plus the durable row in
// content_moderation_flags. The fastest real upgrade path when this
// matters enough to act on: Supabase's own Database Webhooks (Dashboard ->
// Database -> Webhooks, zero code) pointed at inserts on this table,
// firing into a Slack incoming webhook or an email-sending service of the
// operator's choice.
//
// No review UI: deliberately not building one. A real hash-match against a
// known-CSAM database should never be queued for a human to look at —
// real providers (Thorn Safer) auto-quarantine confirmed matches
// precisely so no one at the operating company has to view the content;
// viewing it is itself legally and psychologically fraught, and isn't
// necessary to act on a confirmed hash match. If a non-CSAM category ever
// needs a human policy judgment (e.g. a suspected-NCII report that isn't a
// hash match), that belongs in the operator's existing Supabase dashboard
// tooling, not a purpose-built viewer in this app.

export type ContentType = "image" | "audio" | "video";

export class ContentFlaggedError extends Error {
  constructor(reason: string) {
    super(`Content flagged by safety scan: ${reason}`);
    this.name = "ContentFlaggedError";
  }
}

interface ScanResult {
  flagged: boolean;
  reason: string | null;
  provider: string;
}

let warnedStubOnce = false;

function testHashes(): Set<string> {
  const raw = process.env.CONTENT_SAFETY_TEST_HASHES ?? "";
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0)
  );
}

// The scan itself. See the file header — this is the ONE function to
// replace with a real provider call. Never let this throw; a scan
// failure should not itself count as a match (fail open on scan errors —
// the provider being down isn't evidence of anything) but SHOULD be
// logged loudly, since a silently-broken scan is worse than an honestly
// disabled one.
async function scanContentHash(contentHash: string): Promise<ScanResult> {
  if (!warnedStubOnce) {
    warnedStubOnce = true;
    console.warn(
      "[content-safety] STUB SCANNER ACTIVE — no real hash-matching provider is connected. " +
        "This does not detect CSAM or other illegal content. See lib/content-safety.ts's file header."
    );
  }

  const testSet = testHashes();
  if (testSet.has(contentHash.toLowerCase())) {
    return { flagged: true, reason: "test-hash-match", provider: "test-harness" };
  }

  return { flagged: false, reason: null, provider: "stub-unconfigured" };
}

export function hashBase64(base64: string): string {
  return createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
}

export function hashBytes(bytes: ArrayBuffer): string {
  return createHash("sha256").update(Buffer.from(bytes)).digest("hex");
}

// Called by every media-input route (image, audio) and by
// lib/video-file-pipeline.ts (video's single shared entry point) BEFORE
// any credit is charged and before the media reaches an AI provider.
// Throws ContentFlaggedError on a match — callers should catch that
// specifically, skip the normal "Try Again"/infra-error response, and
// return a generic refusal instead (see any route's catch block for the
// pattern). Does not throw on a scan-provider error — see scanContentHash.
export async function checkContentSafety(params: {
  admin: SupabaseClient;
  userId: string;
  contentType: ContentType;
  contentHash: string;
  sourceRoute: string;
  storagePath?: string;
}): Promise<void> {
  const { admin, userId, contentType, contentHash, sourceRoute, storagePath } = params;

  let result: ScanResult;
  try {
    result = await scanContentHash(contentHash);
  } catch (err) {
    console.error("[content-safety] scan itself failed (failing open — not treated as a match):", err);
    return;
  }

  if (!result.flagged) return;

  console.error(
    `[content-safety] CONTENT FLAGGED — quarantined. route=${sourceRoute} type=${contentType} user=${userId} ` +
      `hash=${contentHash} provider=${result.provider} reason=${result.reason ?? "unspecified"}`
  );

  const { error: insertError } = await admin.from("content_moderation_flags").insert({
    user_id: userId,
    content_type: contentType,
    source_route: sourceRoute,
    content_hash: contentHash,
    scan_provider: result.provider,
    scan_reason: result.reason,
    storage_path: storagePath ?? null,
  });

  if (insertError) {
    // The console.error above is the notification of record even if this
    // insert fails — never let a logging-table failure be the reason
    // flagged content proceeds.
    console.error("[content-safety] failed to write content_moderation_flags row:", insertError);
  }

  // Analytics (Part 23, Sept 21, 2026) — see lib/analytics.ts's header.
  // This single call site covers every image/audio/video route (direct
  // and combined), since they all funnel through checkContentSafety(). No
  // claim text or media, just the same metadata already written to
  // content_moderation_flags above.
  track(userId, "content_flagged", {
    content_type: contentType,
    source_route: sourceRoute,
    scan_provider: result.provider,
  });

  throw new ContentFlaggedError(result.reason ?? "flagged");
}
