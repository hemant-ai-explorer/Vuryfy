import { createAdminClient } from "@/lib/supabase/admin";
import { estimateGeminiCostUsd } from "@/lib/cost-pricing";

// AI Gateway (Part 11, LOCKED) — the only place in the app that talks to an
// AI model provider directly. App code requests a MODEL_TIER ('cheap' |
// 'reasoning'), never a specific model ID, so swapping/upgrading the
// underlying model later never touches call sites.
//
// V1 "build thin, not full" (Part 11, refinement #3): only one model wired
// up for both tiers by default — no health-check/auto-downgrade logic, no
// fallback PROVIDER (still just Gemini).
//
// Per-call cost logging (Part 19, LOCKED — wired up Sept 16, 2026, see
// architecture-decisions.md's cost-tracking entry): every call this
// function makes now writes a fire-and-forget row to api_cost_logs (see
// supabase/migrations/0012_api_cost_logs.sql) via logCost() below, using
// the same `usage` field this file already parsed out of Gemini's
// usageMetadata and the pricing constants in lib/cost-pricing.ts. Callers
// now pass a required `callSite` label (e.g. "quick-check.verdict") so
// cost can be grouped by pipeline stage. This is the one new architectural
// coupling this file takes on — previously a stateless gateway with no DB
// dependency, it now also writes its own telemetry via
// lib/supabase/admin.ts's service-role client. That write is best-effort
// and never allowed to affect the actual call's success/failure or
// latency in any meaningful way (see logCost's own comment) — same
// fail-open principle as every other non-critical side effect in this
// codebase (lib/embeddings.ts, lib/web-detection.ts).
//
// Multi-model fallback within Gemini (added Sept 15, 2026): see
// fallbackModels below — an opt-in per-call list of alternate Gemini model
// IDs to try, in order, if the primary model exhausts its own retries with
// a transient error. This is NOT a fallback provider (still one vendor,
// one API) — it's addressing a specific finding: a real Google AI
// Developer Forum thread on this exact problem had a Vertex AI user report
// "we're using Vertex and the errors are the same, no changes at all" —
// switching to Google's enterprise-tier endpoint doesn't reliably fix
// 503s, so that's not the lever. Different MODELS run on separate serving
// pools, though, so one model being overloaded doesn't mean another is at
// the same moment — see architecture-decisions.md for the full writeup.
//
// Transient-failure retry (added Sept 14, 2026): Gemini's `503 The model is
// currently experiencing high demand` (UNAVAILABLE) is a well-documented,
// recurring condition — not a rare fluke — especially on preview-tier
// models like gemini-3.1-flash-lite. Confirmed in production the same day
// this was added (see architecture-decisions.md). callStructured() now
// retries a SHORT, bounded number of times with backoff specifically for
// transient provider failures (503/429/5xx/network-timeout) before giving
// up, so most overload spikes recover silently without the user ever
// seeing an error or needing to click Verify again. This is layered
// underneath (wraps) the existing malformed-JSON retry, which is a
// separate concern (bad output, not a failed request).
//
// Image input (added for image Quick Check/Deep Investigation, Sept 2026):
// Gemini's generateContent endpoint accepts inline image data as an
// additional `parts` entry alongside the text prompt in the same request —
// no separate vision endpoint or model. callStructured() now accepts an
// optional imageParts array for exactly this, used only by
// lib/image-analysis.ts's photo-as-claim pipeline; every other caller
// (quick-check.ts, deep-investigation.ts) is unaffected and keeps sending
// text-only requests. Also accepts an optional timeoutMs override, since a
// vision call over a real photo can reasonably take a little longer than a
// short text-evaluation call — still bounded, never unbounded.
//
// Audio input (added for audio Quick Check/Deep Investigation, Sept 2026):
// same mechanism, same inlineData part shape — Gemini accepts inline audio
// data (mp3/wav/ogg/m4a/webm/etc.) exactly like inline image data, so this
// needed a second optional array (audioParts) rather than a new endpoint or
// call shape. Used by lib/audio-transcript.ts (transcription) and
// lib/audio-analysis.ts (authenticity analysis); every other caller is
// unaffected. imageParts and audioParts can in principle both be set on one
// call, though no current caller does that.
//
// Video input (added for video Quick Check/Deep Investigation, Sept 2026 —
// last step in the locked media-type build order): same mechanism again.
// Gemini's generateContent accepts inline video data (mp4/webm/mov/etc.)
// the identical way — it natively processes both the visual frames AND the
// video's own audio track from one inlineData part, which is exactly why
// lib/video-transcript.ts can transcribe speech straight from a video file
// without any separate audio-extraction step. Kept as its own named
// videoParts array (rather than reusing audioParts, even though the
// runtime shape is identical) for the same call-site-clarity reason
// audioParts was kept separate from imageParts. Used by
// lib/video-transcript.ts (transcription) and lib/video-analysis.ts
// (authenticity/deepfake analysis); every other caller is unaffected.
//
// Gemini File API support (added Sept 15, 2026, superseding the "revisit
// only if real usage shows..." note above — the user explicitly asked for
// 3-5+ minute video support): videoParts (inlineData) stays in place for
// any future small-payload caller, but video's own callers
// (lib/video-transcript.ts, lib/video-analysis.ts) now exclusively use the
// new videoFileRef param below instead. A video that size can't fit
// Gemini's inline-request limit (100MB total, less once base64-inflated)
// the way a short clip could — see lib/gemini-file-upload.ts for the
// upload/cleanup mechanics. videoFileRef sends Gemini a `fileData` part
// (fileUri + mimeType) instead of an `inlineData` part — a different shape
// Gemini's generateContent accepts for content already uploaded via its
// File API.

const GEMINI_MODEL = "gemini-3.1-flash-lite";
const GEMINI_REASONING_MODEL = "gemini-3.8-flash";

// Sept 24, 2026 — shared time budget for Deep Investigation pipelines
// (deep-investigation.ts, image-analysis.ts's runImageDeepInvestigation).
// Root cause of a real user-reported incident: on a Gemini 503 spike, the
// retry-with-backoff + multi-model-fallback machinery below has no idea how
// much of the request's maxDuration=60 window is left, so worst case it can
// legitimately chain retries + fallbacks past Vercel's hard 60s cutoff. When
// that happens, Vercel force-kills the function mid-flight — which is worse
// than a normal error, because the route's own catch block (which refunds
// the just-charged credit) never gets to run either. 45s leaves ~15s for
// everything a Deep Investigation route does outside this budget (auth,
// content-safety check, the credit RPC, cache read, and — after this budget
// is spent — the verifications/credit_transactions inserts), which is
// generous headroom against a typical <2s of that overhead plus Vercel cold
// start. Deliberately NOT applied globally: every OTHER callStructured()
// caller (Quick Check, audio/video Deep Investigation, etc.) still gets
// today's unbounded-by-wall-clock behavior — deadlineAt is opt-in per call,
// see below.
export const DEEP_INVESTIGATION_BUDGET_MS = 45_000;

// Sept 15, 2026: was a fixed const built once from GEMINI_MODEL — now a
// function, since callStructured() needs to hit a DIFFERENT model's
// endpoint when falling back (see fallbackModels on StructuredCallParams).
function endpointForModel(model: string): string {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

export type ModelTier = "cheap" | "reasoning";

export interface ImagePart {
  mimeType: string;
  data: string; // base64, no "data:...;base64," prefix
}

// Same shape as ImagePart — Gemini's inlineData part doesn't distinguish by
// type beyond the mimeType field itself. Kept as a separate named type
// rather than reusing ImagePart directly so call sites read clearly (an
// audioParts array of ImagePart would be a confusing thing to read at the
// call site even though the runtime shape is identical).
export type AudioPart = ImagePart;

// Same shape again, same reasoning — see AudioPart above.
export type VideoPart = ImagePart;

// A reference to a file already uploaded via Gemini's File API (see
// lib/gemini-file-upload.ts), rather than raw inline bytes — the shape
// Gemini's generateContent expects is a `fileData` part (fileUri +
// mimeType) instead of `inlineData` (mimeType + base64 data). Video's own
// callers use this exclusively now; kept distinct from VideoPart since the
// two are not interchangeable at the request level.
export interface VideoFileRef {
  fileUri: string;
  mimeType: string;
}

export interface StructuredCallParams {
  tier: ModelTier;
  systemPrompt: string;
  userPrompt: string;
  responseSchema: Record<string, unknown>;
  temperature?: number;
  imageParts?: ImagePart[];
  audioParts?: AudioPart[];
  videoParts?: VideoPart[];
  videoFileRef?: VideoFileRef;
  timeoutMs?: number;
  // Sept 15, 2026 addition: per-call override for the transient-retry
  // backoff schedule (see TRANSIENT_RETRY_DELAYS_MS below). Added after a
  // real video Deep Investigation call hit Gemini 503s twice in a row even
  // after the existing 2-retry/short-backoff default — a heavier
  // reasoning-tier call over a multi-minute video is more exposed to
  // transient overload than a fast text call, and (unlike a text Quick
  // Check, which must stay inside Part 26.4's ~5-15s target) video Deep
  // Investigation already has a generous maxDuration budget (450s) and a
  // "takes longer" user expectation to spend it against. Left undefined for
  // every other caller, which keeps today's default (2 retries, short
  // backoff) unchanged.
  retryDelaysMs?: number[];
  // Sept 24, 2026 addition: an absolute deadline (epoch ms, Date.now()-
  // comparable) this call must respect — see DEEP_INVESTIGATION_BUDGET_MS
  // above for why. When set: (1) each attempt's own AbortSignal.timeout is
  // capped to whatever time is actually left, never the full timeoutMs; (2)
  // a retry or fallback-model attempt is skipped (failing fast with the
  // last real error) once there isn't enough time left for it to plausibly
  // finish. Left undefined by every caller that doesn't opt in — those keep
  // exactly today's unbounded-by-wall-clock behavior.
  deadlineAt?: number;
  // Sept 15, 2026 addition: ordered list of alternate Gemini model IDs to
  // try, one attempt each (no extra backoff sleep — the primary model's own
  // retryDelaysMs already spent that time), if the primary model's retries
  // are exhausted and still failing with a transient error. See the file
  // header for why this exists instead of switching to Vertex AI or adding
  // a second provider. Left empty for every caller except the ones that
  // opt in (video transcription, video Deep Investigation — the two calls
  // with real, repeated live 503s).
  fallbackModels?: string[];
  // Sept 24, 2026 addition: per-call override for each fallback model's own
  // retry-with-backoff schedule (default: empty — one immediate attempt per
  // fallback, no backoff, per fallbackModels's original comment above).
  // Added after a real incident where deep-investigation.ts's decompose
  // call burned through its primary model's retries AND both fallback
  // models' single attempts, all within a couple of seconds, without ever
  // giving a genuinely short-lived Gemini overload spike a chance to clear
  // — "failing fast" through every option so quickly that none of them got
  // a real chance. Left undefined (today's zero-backoff behavior) for every
  // caller that doesn't opt in.
  fallbackRetryDelaysMs?: number[];
  // Sept 16, 2026 addition (cost logging, Part 19): a short, hand-written
  // label identifying which pipeline stage this call belongs to (e.g.
  // "quick-check.verdict", "video-analysis.deep") — the aggregation key
  // for the api_cost_logs rows logCost() below writes. Required on every
  // call site rather than optional, so a new caller can't silently ship
  // without cost visibility.
  callSite: string;
}

export interface StructuredCallResult<T> {
  data: T;
  usage: { promptTokens: number; outputTokens: number; totalTokens: number };
}

export class AiGatewayError extends Error {
  cause?: unknown;
  // HTTP status from the provider, when the failure came back as a non-ok
  // response (as opposed to a network/timeout failure, which has none).
  // Used by isRetryableTransientError() to decide whether to retry.
  status?: number;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "AiGatewayError";
    this.cause = cause;
  }
}

// Statuses worth a short retry: 429 (rate limited), 503 (overloaded — the
// common Gemini case), and the other classic transient 5xx codes. NOT
// retried: 4xx auth/validation errors (400/401/403/404) — those will never
// succeed on retry and should fail fast.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

function isRetryableTransientError(err: unknown): boolean {
  if (!(err instanceof AiGatewayError)) return false;
  if (err.message.includes("network/timeout")) return true;
  if (err.status !== undefined && RETRYABLE_STATUSES.has(err.status)) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sept 15, 2026: was one model wired for both tiers in V1 (see file
// header) — Quick Check and Deep Investigation were hitting the literal
// same model, so a Deep Investigation's only real difference was a longer
// timeout and one extra sentence in its prompt, not a deeper pass. Kept as
// a lookup (rather than using GEMINI_MODEL directly at call sites) so this
// stayed a one-line change once it was time to make it, as anticipated.
// "reasoning" tier now gets a genuinely stronger model.
function modelForTier(tier: ModelTier): string {
  return tier === "reasoning" ? GEMINI_REASONING_MODEL : GEMINI_MODEL;
}

async function attemptCall<T>(params: StructuredCallParams, apiKey: string, model: string): Promise<StructuredCallResult<T>> {
  // Image/audio parts, when present, go first in the parts array (Gemini's
  // own examples do this consistently) followed by the text prompt — this
  // is a convention, not a hard requirement, but keeping it consistent
  // avoids a class of "does part order matter" debugging later.
  const parts: Record<string, unknown>[] = [
    ...(params.imageParts ?? []).map((p) => ({ inlineData: { mimeType: p.mimeType, data: p.data } })),
    ...(params.audioParts ?? []).map((p) => ({ inlineData: { mimeType: p.mimeType, data: p.data } })),
    ...(params.videoParts ?? []).map((p) => ({ inlineData: { mimeType: p.mimeType, data: p.data } })),
    ...(params.videoFileRef
      ? [{ fileData: { fileUri: params.videoFileRef.fileUri, mimeType: params.videoFileRef.mimeType } }]
      : []),
    { text: params.userPrompt },
  ];

  // Sept 24, 2026: when the caller passed a deadlineAt (see StructuredCallParams),
  // this single attempt can't be allowed the full timeoutMs if less time than
  // that is actually left — it would just get killed by Vercel instead of by
  // this AbortSignal, with no chance for tryModelWithRetries/callStructured's
  // own deadline checks (below) to fail fast and let the route's catch block
  // (credit refund) run. Floors at 0 rather than going negative; a
  // deadlineAt already in the past reaching here (shouldn't normally happen —
  // tryModelWithRetries checks first) still aborts near-instantly rather than
  // throwing a confusing "negative timeout" error from AbortSignal.timeout.
  const timeoutMs =
    params.deadlineAt !== undefined
      ? Math.max(0, Math.min(params.timeoutMs ?? 20_000, params.deadlineAt - Date.now()))
      : params.timeoutMs ?? 20_000;

  let response: Response;
  try {
    response = await fetch(endpointForModel(model), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        systemInstruction: { role: "system", parts: [{ text: params.systemPrompt }] },
        generationConfig: {
          temperature: params.temperature ?? 0.2,
          responseMimeType: "application/json",
          responseSchema: params.responseSchema,
        },
      }),
      // Quick Check targets ~5-15s total (Part 26.4) — bound the AI call so
      // a hung request can't block the whole request indefinitely. Callers
      // doing heavier work (e.g. a reasoning-tier vision call) can pass a
      // longer timeoutMs; still always bounded, never unbounded. Further
      // capped to the caller's remaining deadlineAt budget, if any — see above.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new AiGatewayError("Gemini request failed (network/timeout)", err);
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    const err = new AiGatewayError(`Gemini API error ${response.status}: ${bodyText.slice(0, 500)}`);
    err.status = response.status;
    throw err;
  }

  const json = await response.json().catch((err) => {
    throw new AiGatewayError("Gemini response was not a valid JSON envelope", err);
  });

  const text: string | undefined = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new AiGatewayError("Gemini response had no text content", json);
  }

  const parsed = JSON.parse(text) as T; // caller (attemptCall's caller) retries once on parse failure

  const usageMeta = json?.usageMetadata ?? {};
  return {
    data: parsed,
    usage: {
      promptTokens: usageMeta.promptTokenCount ?? 0,
      outputTokens: usageMeta.candidatesTokenCount ?? 0,
      totalTokens: usageMeta.totalTokenCount ?? 0,
    },
  };
}

// Structured, schema-validated call to the "cheap" or "reasoning" model
// tier, with one retry on malformed JSON output (Part 19: "schema-validate
// before use, retry/fallback on malformed output, never pass raw model
// text to users").
async function attemptWithJsonRetry<T>(
  params: StructuredCallParams,
  apiKey: string,
  model: string
): Promise<StructuredCallResult<T>> {
  try {
    return await attemptCall<T>(params, apiKey, model);
  } catch (err) {
    if (err instanceof AiGatewayError && err.message.includes("valid JSON envelope")) {
      throw err; // envelope-level failure — retrying won't help
    }
    if (err instanceof SyntaxError) {
      // JSON.parse failure on the model's text — retry once before giving up.
      try {
        return await attemptCall<T>(params, apiKey, model);
      } catch {
        throw new AiGatewayError("Gemini structured output was not valid JSON, even after one retry", err);
      }
    }
    throw err;
  }
}

const TRANSIENT_RETRY_DELAYS_MS = [500, 1500]; // 2 retries (3 attempts total), short backoff

// Runs the retry-with-backoff loop against ONE model. Used for both the
// primary model (with its own retryDelays) and, below, each fallback model
// (default: an empty retryDelays — one immediate attempt, no backoff —
// unless the caller opted into fallbackRetryDelaysMs, see StructuredCallParams).
async function tryModelWithRetries<T>(
  params: StructuredCallParams,
  apiKey: string,
  model: string,
  retryDelays: number[]
): Promise<StructuredCallResult<T>> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retryDelays.length; attempt++) {
    // Sept 24, 2026: an attempt (after the first) starting with essentially
    // no budget left would just get capped to a ~0ms AbortSignal.timeout by
    // attemptCall above and fail anyway — skip it outright and surface the
    // real last error instead of a confusing instant-timeout one.
    if (attempt > 0 && params.deadlineAt !== undefined && Date.now() >= params.deadlineAt) {
      throw lastErr;
    }
    try {
      return await attemptWithJsonRetry<T>(params, apiKey, model);
    } catch (err) {
      lastErr = err;
      const isLastAttempt = attempt === retryDelays.length;
      // Sept 24, 2026: don't sleep out a backoff window that would just eat
      // into (or exceed) the remaining deadline for no benefit — fail fast
      // instead so the caller's own deadline-aware fallback/route-level
      // catch gets a real chance to run before Vercel's own hard cutoff.
      const budgetForRetry =
        params.deadlineAt === undefined || Date.now() + retryDelays[attempt] < params.deadlineAt;
      if (!isLastAttempt && isRetryableTransientError(err) && budgetForRetry) {
        await sleep(retryDelays[attempt]);
        continue;
      }
      throw err;
    }
  }
  // Unreachable — loop always returns or throws — but keeps TypeScript happy.
  throw lastErr;
}

// Sept 16, 2026 — fire-and-forget cost logging (Part 19). Writes exactly
// one row per callStructured() invocation's final outcome (see the two
// call sites below: one success path, three ways to exhaust every option
// and fail). Deliberately does NOT await the insert from its callers —
// .then()/.catch() only, so a slow or failed cost-log write can never add
// latency to, or break, the actual verification request. Uses the
// service-role client directly (lib/supabase/admin.ts) since this is
// server-only telemetry, never RLS-gated per-user data.
function logCost(entry: {
  model: string;
  tier: ModelTier;
  callSite: string;
  promptTokens: number;
  outputTokens: number;
  totalTokens: number;
  usedFallback: boolean;
  status: "success" | "error";
  errorMessage?: string;
  inputModality: "text" | "audio";
}): void {
  const estimatedCostUsd =
    entry.status === "success"
      ? estimateGeminiCostUsd(entry.model, entry.promptTokens, entry.outputTokens, entry.inputModality)
      : 0;

  createAdminClient()
    .from("api_cost_logs")
    .insert({
      provider: "gemini",
      model: entry.model,
      tier: entry.tier,
      call_site: entry.callSite,
      prompt_tokens: entry.promptTokens,
      output_tokens: entry.outputTokens,
      total_tokens: entry.totalTokens,
      estimated_cost_usd: estimatedCostUsd,
      used_fallback: entry.usedFallback,
      status: entry.status,
      error_message: entry.errorMessage ?? null,
    })
    .then(({ error }) => {
      if (error) console.error("[ai-gateway] cost log insert failed:", error.message);
    });
}

export async function callStructured<T>(params: StructuredCallParams): Promise<StructuredCallResult<T>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new AiGatewayError("GEMINI_API_KEY is not set");
  }

  const primaryModel = modelForTier(params.tier);
  const retryDelays = params.retryDelaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  const fallbackModels = params.fallbackModels ?? [];
  // Gemini prices raw audio input at a different (higher) per-token rate
  // than text/image/video input on models that separate it (see
  // lib/cost-pricing.ts's audioInputPerMillion) — audioParts is the only
  // signal callStructured() has for "this request's input is audio", so
  // it's used here rather than adding a redundant param every caller would
  // have to set by hand.
  const inputModality: "text" | "audio" = params.audioParts && params.audioParts.length > 0 ? "audio" : "text";

  try {
    const result = await tryModelWithRetries<T>(params, apiKey, primaryModel, retryDelays);
    // Sept 15, 2026: added alongside the tier->model split (modelForTier)
    // specifically so "which model actually answered this call" is
    // verifiable from Vercel logs instead of inferred from output alone —
    // came up debugging why a Quick Check and a Deep Investigation on the
    // same video read as near-identical (see git history same day).
    console.log(`[ai-gateway] served by ${primaryModel} (tier: ${params.tier}, primary)`);
    logCost({
      model: primaryModel,
      tier: params.tier,
      callSite: params.callSite,
      promptTokens: result.usage.promptTokens,
      outputTokens: result.usage.outputTokens,
      totalTokens: result.usage.totalTokens,
      usedFallback: false,
      status: "success",
      inputModality,
    });
    return result;
  } catch (primaryErr) {
    if (fallbackModels.length === 0 || !isRetryableTransientError(primaryErr)) {
      logCost({
        model: primaryModel,
        tier: params.tier,
        callSite: params.callSite,
        promptTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        usedFallback: false,
        status: "error",
        errorMessage: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
        inputModality,
      });
      throw primaryErr;
    }
    // Sept 15, 2026: the primary model's own retries are exhausted and it's
    // still a transient (retryable) failure — try each fallback model once,
    // in order, stopping at the first success. No backoff sleep here: the
    // primary model already spent that time, and a different model's
    // serving pool being overloaded at the exact same moment is unlikely
    // enough not to be worth waiting for.
    let lastErr: unknown = primaryErr;
    for (const model of fallbackModels) {
      // Sept 24, 2026: same reasoning as tryModelWithRetries's own check —
      // don't start a fallback model attempt with no realistic time left to
      // finish it; fail fast with whatever real error we already have.
      if (params.deadlineAt !== undefined && Date.now() >= params.deadlineAt) break;
      try {
        const result = await tryModelWithRetries<T>(params, apiKey, model, params.fallbackRetryDelaysMs ?? []);
        console.log(`[ai-gateway] served by ${model} (tier: ${params.tier}, fallback after ${primaryModel} failed)`);
        logCost({
          model,
          tier: params.tier,
          callSite: params.callSite,
          promptTokens: result.usage.promptTokens,
          outputTokens: result.usage.outputTokens,
          totalTokens: result.usage.totalTokens,
          usedFallback: true,
          status: "success",
          inputModality,
        });
        return result;
      } catch (err) {
        lastErr = err;
        if (!isRetryableTransientError(err)) {
          logCost({
            model,
            tier: params.tier,
            callSite: params.callSite,
            promptTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            usedFallback: true,
            status: "error",
            errorMessage: err instanceof Error ? err.message : String(err),
            inputModality,
          });
          throw err;
        }
      }
    }
    logCost({
      model: fallbackModels[fallbackModels.length - 1],
      tier: params.tier,
      callSite: params.callSite,
      promptTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      usedFallback: true,
      status: "error",
      errorMessage: lastErr instanceof Error ? lastErr.message : String(lastErr),
      inputModality,
    });
    throw lastErr;
  }
}
