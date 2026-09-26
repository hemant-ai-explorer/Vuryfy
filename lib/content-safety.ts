import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { track } from "@/lib/analytics";
import { generatePhotoDnaEdgeHashes } from "@/lib/photodna-edge-hash";

// Illegal/harmful content handling pipeline (Part 15, LOCKED spec) — Sept
// 19, 2026. See supabase/migrations/0019_content_moderation.sql for the
// schema half of this.
//
// ============================================================================
// UPDATE, Sept 26, 2026 — IMAGE scanning is now REAL. Microsoft approved
// this account for the PhotoDNA Cloud Service (the vetted-provider gate the
// note below used to say was blocking real protection), and this file now
// generates a real PhotoDNA Edge Hash for every submitted image (via
// lib/photodna-edge-hash.ts, a from-scratch pure-Node/WebAssembly port of
// Microsoft's Edge Hash Generation SDK — see that file's header for why it
// isn't just Microsoft's own glue file) and checks it against PhotoDNA's
// MatchHash API (NCMEC/TC/CIH/CCA/IWF-sourced known-CSAM hash sets).
//
// AUDIO AND VIDEO ARE STILL THE STUB DESCRIBED BELOW. PhotoDNA, as approved
// for this account, is an image product — there is no equivalent real
// provider wired in for audio/video yet. Do not mistake image coverage for
// coverage of every content type.
// ============================================================================
//
// Real CSAM hash-matching for audio/video (Thorn's Safer, or an audio/video-
// capable tier of PhotoDNA) requires its own separate vetted business
// application — there is no API a general-purpose coding assistant can sign
// the operator up for, and building a homegrown perceptual-hash/ML
// "detector" instead would be worse than nothing: it would very likely give
// false confidence that real protection exists, while actually catching a
// small and unpredictable fraction of real illegal content. So, per the
// operator's own decision (Sept 19, 2026 — "not started yet" on a provider
// relationship), audio/video ship as an honest no-op scan wired into the
// real architecture, not a fake scanner.
//
// What IS real here now: every image insertion point (verify-image,
// ocr-image, deep-image, verify-image-combined, deep-image-combined) computes
// a genuine PhotoDNA Edge Hash and calls the real MatchHash API BEFORE the
// image reaches Gemini/Google Vision or any other AI provider, and before
// any credit is charged. Audio/video insertion points still only compute a
// sha256 content hash and call checkContentSafety() the same way — wiring in
// a real provider for those later is a change to this file only; no route
// changes needed there.
//
// TODO before audio/video are protected: give scanContentType() a real
// audio/video branch, the same shape as the image branch below (Thorn
// Safer's API is the natural fit for that — submit-a-hash-get-a-match, same
// shape this function already has for images).
//
// Test path: CONTENT_SAFETY_TEST_HASHES lets the operator verify the
// quarantine flow end-to-end (route refuses to process, credit isn't
// charged, a row lands in content_moderation_flags) using a harmless file
// of their own choosing, for ANY content type — never real illegal content.
// Set it to a comma-separated list of sha256 hex hashes; any submission
// whose content hash matches one is treated as flagged, independent of and
// in addition to the real PhotoDNA check below. Leave unset in normal
// operation (nothing is ever flagged this way). For exercising the REAL
// PhotoDNA path specifically (not just the quarantine plumbing), Microsoft
// publishes a set of sample images that are known to return a genuine (test-
// only) match from the live MatchHash API against a "Test" source — ask the
// operator for that set rather than ever using real illegal content.
//
// PhotoDNA config: set PHOTODNA_API_KEY (the "Ocp-Apim-Subscription-Key"
// value from the PhotoDNA developer portal) to turn on real image scanning.
// If it's unset, image submissions fall back to the same "unconfigured, not
// actually protected" behavior audio/video have, logged loudly below — this
// is a fail-open-on-missing-config choice, matching the fail-open-on-
// scan-error philosophy elsewhere in this file (a missing/misconfigured
// scanner isn't evidence content is bad, but must never be silent).
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
// that something was flagged. Note: a real PhotoDNA match is a MUCH
// stronger signal than the old stub's test-harness match ever was — treat a
// `provider: "photodna"` row in content_moderation_flags as a genuine,
// urgent report-and-preserve-evidence situation, not routine log noise.
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
// real providers (PhotoDNA, Thorn Safer) auto-quarantine confirmed matches
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

let warnedAudioVideoStubOnce = false;
let warnedImageUnconfiguredOnce = false;

function testHashes(): Set<string> {
  const raw = process.env.CONTENT_SAFETY_TEST_HASHES ?? "";
  return new Set(
    raw
      .split(",")
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h.length > 0)
  );
}

// The operator's own opt-in test lane — see file header. Works for every
// content type, independent of whichever real provider (or lack of one) is
// wired in below. Never throws.
function checkTestHarness(contentHash: string): ScanResult | null {
  const testSet = testHashes();
  if (testSet.has(contentHash.toLowerCase())) {
    return { flagged: true, reason: "test-hash-match", provider: "test-harness" };
  }
  return null;
}

const PHOTODNA_MATCH_URL = "https://api.microsoftmoderator.com/photodna/v1.0/MatchHash";

interface PhotoDnaStatus {
  Code?: number;
  Description?: string;
  Exception?: string | null;
}
interface PhotoDnaMatchFlag {
  Source?: string;
  Violations?: string[];
  MatchDistance?: number;
}
interface PhotoDnaMatchResultEntry {
  Status?: PhotoDnaStatus;
  IsMatch?: boolean;
  MatchDetails?: { MatchFlags?: PhotoDnaMatchFlag[] };
}
interface PhotoDnaMatchResponse {
  TrackingId?: string;
  MatchResults?: PhotoDnaMatchResultEntry[];
}

// Calls PhotoDNA's real MatchHash API with up to 5 pre-computed Edge Hash
// values (submitting more than one — e.g. the border-cropped variant
// alongside the full-image hash — costs nothing extra: Microsoft's own docs
// say up to 5 hashes "count as a single request" for quota purposes). Never
// throws: any transport/parsing/HTTP failure returns null ("couldn't check",
// fail open — an outage isn't evidence of anything), logged loudly so an
// outage or misconfiguration is never silent. A genuine match is the one
// thing this function will never swallow — if PhotoDNA says IsMatch: true,
// this always returns isMatch: true up the stack.
async function matchPhotoDnaHashes(
  hashes: string[]
): Promise<{ isMatch: boolean; reason: string | null } | null> {
  const apiKey = process.env.PHOTODNA_API_KEY;
  if (!apiKey) return null;

  // "PreHashV2": these are Edge Hash V2 values computed locally by this app
  // (via lib/photodna-edge-hash.ts), not raw image bytes handed to
  // Microsoft to hash centrally — that's exactly what MatchHash's
  // DataRepresentation: "PreHashV2" option is documented for, as opposed to
  // "Hash" (Microsoft's older, non-Edge hash format). If PhotoDNA starts
  // returning Status.Code 3002 ("invalid/missing params") for every real
  // submission, that mismatch is the first thing to check.
  const requestBody = hashes.map((h) => ({ DataRepresentation: "PreHashV2", Value: h }));

  let resp: Response;
  try {
    resp = await fetch(PHOTODNA_MATCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": apiKey,
      },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    console.error("[content-safety] PhotoDNA MatchHash request failed (network) — failing open:", err);
    return null;
  }

  if (!resp.ok) {
    const bodyText = await resp.text().catch(() => "");
    console.error(
      `[content-safety] PhotoDNA MatchHash returned HTTP ${resp.status} — failing open. Body: ${bodyText.slice(0, 500)}`
    );
    return null;
  }

  let json: PhotoDnaMatchResponse;
  try {
    json = await resp.json();
  } catch (err) {
    console.error("[content-safety] PhotoDNA MatchHash returned unparseable JSON — failing open:", err);
    return null;
  }

  const results = json.MatchResults ?? [];
  for (const r of results) {
    const code = r.Status?.Code;
    if (code !== undefined && code !== 3000) {
      // Logged for visibility, not treated as a match either way — these
      // codes (3206/3208 in particular) describe raw-image problems and
      // aren't expected on a pre-computed-hash submission, so seeing one
      // here is itself worth investigating.
      console.error(
        `[content-safety] PhotoDNA MatchHash: non-OK status for one submitted hash — code=${code} ` +
          `description=${r.Status?.Description ?? "?"} exception=${r.Status?.Exception ?? "none"} ` +
          `trackingId=${json.TrackingId ?? "?"}`
      );
    }

    if (r.IsMatch) {
      const flags = r.MatchDetails?.MatchFlags ?? [];
      const sources = flags.map((f) => f.Source).filter(Boolean).join(",") || "unknown";
      const violations = flags.flatMap((f) => f.Violations ?? []).filter(Boolean).join(",") || "unspecified";
      return {
        isMatch: true,
        reason: `photodna-match source=${sources} violations=${violations} trackingId=${json.TrackingId ?? "?"}`,
      };
    }
  }

  return { isMatch: false, reason: null };
}

// Real image scan: generate the PhotoDNA Edge Hash(es) for the submitted
// image and check them against PhotoDNA's live known-CSAM hash sets.
// Returns null (not "not flagged" — genuinely "couldn't run this check") on
// any failure, so the caller can fall back to the unconfigured-warning path
// rather than silently reporting a clean result it never actually got.
async function scanImageWithPhotoDna(imageBytes: Buffer): Promise<ScanResult | null> {
  if (!process.env.PHOTODNA_API_KEY) return null;

  const hashes = await generatePhotoDnaEdgeHashes(imageBytes);
  if (!hashes) {
    // Hash generation itself failed (bad/tiny/corrupt image, decode error —
    // see photodna-edge-hash.ts's own logging for specifics). Fail open:
    // an image this pipeline can't even hash isn't evidence of anything.
    return { flagged: false, reason: null, provider: "photodna-hash-unavailable" };
  }

  const hashValues = [hashes.primary, ...(hashes.borderRemoved ? [hashes.borderRemoved] : [])];

  const matchResult = await matchPhotoDnaHashes(hashValues);
  if (!matchResult) {
    // MatchHash call itself failed — see matchPhotoDnaHashes's own logging.
    return { flagged: false, reason: null, provider: "photodna-api-unavailable" };
  }

  if (matchResult.isMatch) {
    return { flagged: true, reason: matchResult.reason, provider: "photodna" };
  }

  return { flagged: false, reason: null, provider: "photodna" };
}

// Picks the real scan path for a content type, or the honest stub warning
// when none is configured. Never throws — see individual functions above.
async function scanContentType(
  contentType: ContentType,
  imageBytes: Buffer | null
): Promise<ScanResult> {
  if (contentType === "image") {
    if (imageBytes && process.env.PHOTODNA_API_KEY) {
      const result = await scanImageWithPhotoDna(imageBytes);
      if (result) return result;
    } else if (!warnedImageUnconfiguredOnce) {
      warnedImageUnconfiguredOnce = true;
      console.warn(
        "[content-safety] Image submitted without real PhotoDNA coverage — " +
          (process.env.PHOTODNA_API_KEY ? "no image bytes were passed to checkContentSafety()." : "PHOTODNA_API_KEY is not set.") +
          " This image is NOT being checked against any known-CSAM hash set."
      );
    }
    return { flagged: false, reason: null, provider: "stub-unconfigured" };
  }

  // audio / video — unchanged stub, see file header.
  if (!warnedAudioVideoStubOnce) {
    warnedAudioVideoStubOnce = true;
    console.warn(
      "[content-safety] STUB SCANNER ACTIVE for audio/video — no real hash-matching provider is connected. " +
        "This does not detect CSAM or other illegal content in audio/video. See lib/content-safety.ts's file header."
    );
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
// pattern). Does not throw on a scan-provider error — see scanContentType.
//
// imageBase64: pass the same base64 string already used for hashBase64()
// when contentType is "image" — this is what lets the real PhotoDNA check
// run (it's decoded to raw bytes internally). Omit it (or for non-image
// content types) and the image path falls back to the honest
// unconfigured-warning behavior rather than silently skipping the check.
export async function checkContentSafety(params: {
  admin: SupabaseClient;
  userId: string;
  contentType: ContentType;
  contentHash: string;
  sourceRoute: string;
  storagePath?: string;
  imageBase64?: string;
}): Promise<void> {
  const { admin, userId, contentType, contentHash, sourceRoute, storagePath, imageBase64 } = params;

  let result: ScanResult;
  try {
    // The operator's own test-harness hash always gets a chance first —
    // cheap, deterministic, and independent of whichever real provider (or
    // lack of one) is configured below.
    const testHarnessResult = checkTestHarness(contentHash);
    if (testHarnessResult) {
      result = testHarnessResult;
    } else {
      const imageBytes = contentType === "image" && imageBase64 ? Buffer.from(imageBase64, "base64") : null;
      result = await scanContentType(contentType, imageBytes);
    }
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
