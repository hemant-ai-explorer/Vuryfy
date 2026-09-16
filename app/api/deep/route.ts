import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runDeepInvestigation, DEEP_ENGINE_VERSION, type DeepInvestigationResult } from "@/lib/deep-investigation";
import { normalizeClaim } from "@/lib/quick-check";
import {
  computeCacheKey,
  getCachedVerification,
  writeCache,
  checkSemanticCache,
  writeSemanticCache,
  type CachedVerification,
} from "@/lib/verification-cache";
import { detectPaymentReceipt } from "@/lib/detect-payment-receipt";
import { detectPaymentRequest } from "@/lib/detect-payment-request";

// Route-level execution budget (Sept 2026 fix, added across every AI-
// calling route after the video-upload 413 investigation surfaced that
// NONE of them declared this — see lib/prepare-video-upload.ts and app/
// api/transcribe-video/route.ts for the original discovery). Without this,
// Vercel kills the function at its Hobby-plan default of 10 seconds, which
// Deep Investigation's multi-step decompose-and-search pipeline can
// realistically exceed under real-world latency variance. A killed
// function returns no JSON body, so the browser just hangs with no
// feedback — the same silent-failure shape video hit, just triggered by
// slow search/synthesis instead of a large payload. 60 is Hobby's max.
export const maxDuration = 60;

// Deep Investigation (Part 11 routing logic + Part 26.5) — a heavier,
// multi-angle version of Quick Check: the claim is decomposed into a
// handful of sub-questions, each searched independently, and a
// reasoning-tier model synthesizes a verdict across all of that evidence
// with explicit contradiction analysis and caveats (see
// lib/deep-investigation.ts for the pipeline itself and the architecture
// note on why this is a single synchronous request rather than a
// background job).
//
// Payment-receipt carve-out (Sept 15, 2026, see lib/detect-payment-
// receipt.ts for the full rationale): mirrors the same carve-out added to
// app/api/verify/route.ts — a claim shaped like a private payment receipt
// short-circuits before any credit/cache machinery runs, since neither
// pipeline can confirm a private transaction actually happened. No AI
// call, no verdict, no credit charged.
//
// Everything else below deliberately mirrors app/api/verify/route.ts as
// closely as possible — same credit reserve/refund-on-infra-failure
// pattern (Part 26.4 addition #1's "charge on completion, refund only on
// genuine infra failure" principle applies identically here), same
// exact-match cache integration (a Deep Investigation cache hit still
// charges the credit and still creates a fresh per-user verifications row,
// for the same reasons as Quick Check — see verification-cache.ts and
// architecture-decisions.md's "Caching, Phase 1"). The two routes are kept
// as separate files rather than a shared parameterized handler because the
// pipelines, credit RPCs, and response shapes differ enough that a shared
// abstraction would mostly be indirection.
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const claim: string = (body?.claim ?? "").trim();
  const inputType: string = body?.input_type ?? "text";

  if (claim.length < 5) {
    return NextResponse.json({ error: "Claim is too short." }, { status: 400 });
  }
  if (claim.length > 10000) {
    return NextResponse.json({ error: "Claim is too long (10,000 character limit)." }, { status: 400 });
  }
  if (
    inputType !== "text" &&
    inputType !== "link" &&
    inputType !== "qr" &&
    inputType !== "ocr" &&
    inputType !== "audio_transcript"
  ) {
    return NextResponse.json(
      { error: `Input type "${inputType}" isn't supported yet.` },
      { status: 400 }
    );
  }

  const admin = createAdminClient();

  const receipt = detectPaymentReceipt(claim);
  if (receipt) {
    const { data: balance } = await admin
      .from("credit_balances")
      .select("quick_checks_remaining, deep_investigations_remaining")
      .eq("user_id", user.id)
      .single();

    return NextResponse.json({
      id: null,
      mode: "deep",
      type: "payment_receipt",
      claim,
      receipt,
      credits: {
        quick_checks: balance?.quick_checks_remaining ?? 0,
        deep_investigations: balance?.deep_investigations_remaining ?? 0,
        total: (balance?.quick_checks_remaining ?? 0) + (balance?.deep_investigations_remaining ?? 0),
      },
    });
  }

  // Payment-REQUEST carve-out (Sept 15, 2026, see lib/detect-payment-
  // request.ts) — mirrors the same carve-out in app/api/verify/route.ts.
  const paymentRequest = detectPaymentRequest(claim);
  if (paymentRequest) {
    const { data: balance } = await admin
      .from("credit_balances")
      .select("quick_checks_remaining, deep_investigations_remaining")
      .eq("user_id", user.id)
      .single();

    return NextResponse.json({
      id: null,
      mode: "deep",
      type: "payment_request",
      claim,
      payment_request: paymentRequest,
      credits: {
        quick_checks: balance?.quick_checks_remaining ?? 0,
        deep_investigations: balance?.deep_investigations_remaining ?? 0,
        total: (balance?.quick_checks_remaining ?? 0) + (balance?.deep_investigations_remaining ?? 0),
      },
    });
  }

  const normalizedClaim = normalizeClaim(claim);
  const cacheKey = computeCacheKey(normalizedClaim, inputType, DEEP_ENGINE_VERSION);

  // Atomic conditional decrement, same pattern as decrement_quick_check()
  // (see supabase/migrations/0003_deep_investigation.sql) — only succeeds
  // if the user actually has a Deep Investigation left, and can't go
  // negative under concurrent requests.
  const { data: remaining, error: rpcError } = await admin.rpc("decrement_deep_investigation", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[deep] decrement_deep_investigation RPC failed:", rpcError);
    return NextResponse.json(
      { error: "Could not check your credit balance. Please try again." },
      { status: 500 }
    );
  }

  if (remaining === null || remaining === undefined) {
    return NextResponse.json(
      { error: "You're out of Deep Investigation credits. Upgrade your plan to continue." },
      { status: 402 }
    );
  }

  // Semantic-cache fallback (Part 11's "Semantic" layer, Sept 16, 2026) —
  // see app/api/verify/route.ts's identical comment for the full rationale.
  const cached = await getCachedVerification(admin, cacheKey);
  let cacheHit = cached !== null;
  let cacheMatchType: "exact" | "semantic" | null = cacheHit ? "exact" : null;
  let semanticEmbedding: number[] | null = null;
  let semanticMatch: CachedVerification | null = null;

  if (!cached) {
    const semantic = await checkSemanticCache(admin, normalizedClaim, inputType, DEEP_ENGINE_VERSION);
    semanticEmbedding = semantic.embedding;
    semanticMatch = semantic.match;
    if (semanticMatch) {
      cacheHit = true;
      cacheMatchType = "semantic";
    }
  }

  let result: DeepInvestigationResult | CachedVerification;
  if (cached) {
    result = cached;
  } else if (semanticMatch) {
    result = semanticMatch;
  } else {
    try {
      result = await runDeepInvestigation(claim);
    } catch (err) {
      console.error("[deep] Deep Investigation pipeline failed (refunding credit):", err);

      const { data: refunded, error: refundError } = await admin.rpc("refund_deep_investigation", {
        p_user_id: user.id,
      });
      if (refundError) {
        console.error("[deep] refund_deep_investigation RPC ALSO failed:", refundError);
      } else {
        console.error("[deep] credit refunded, new balance:", refunded);
      }

      await admin.from("credit_transactions").insert([
        { user_id: user.id, credit_type: "deep_investigation", amount: -1, reason: "deep_investigation_reserved" },
        { user_id: user.id, credit_type: "deep_investigation", amount: 1, reason: "deep_investigation_refunded_infra_error" },
      ]);

      // Same terse "Try Again" convention as Quick Check (Sept 14, 2026) —
      // the AI Gateway already retries transient provider failures
      // internally, so reaching this branch means those retries were
      // exhausted.
      return NextResponse.json(
        {
          error: "Try Again",
          ...(process.env.NODE_ENV !== "production"
            ? { debug: { message: err instanceof Error ? err.message : String(err) } }
            : {}),
        },
        { status: 502 }
      );
    }
  }

  const { data: verification, error: insertError } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      mode: "deep",
      input_type: inputType,
      claim_text: claim,
      normalized_claim: normalizedClaim,
      verdict: result.verdict,
      confidence: result.confidence,
      summary: result.summary,
      key_evidence: result.key_evidence,
      sources: result.sources,
      caveats: result.caveats,
      engine_version: result.engine_version,
      credit_charged: true,
    })
    .select()
    .single();

  if (insertError || !verification) {
    console.error("[deep] verifications insert failed:", insertError);
    return NextResponse.json(
      {
        error: "Investigation ran but couldn't be saved. Please try again.",
        ...(process.env.NODE_ENV !== "production" && insertError
          ? {
              debug: {
                message: insertError.message,
                details: insertError.details,
                hint: insertError.hint,
                code: insertError.code,
              },
            }
          : {}),
      },
      { status: 500 }
    );
  }

  if (!cacheHit) {
    await writeCache(admin, cacheKey, verification.id, claim);
    if (semanticEmbedding) {
      await writeSemanticCache(admin, semanticEmbedding, inputType, DEEP_ENGINE_VERSION, verification.id, normalizedClaim, claim);
    }
  }

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: user.id,
    credit_type: "deep_investigation",
    amount: -1,
    reason: cacheHit
      ? cacheMatchType === "semantic"
        ? "deep_investigation_completed_cache_hit_semantic"
        : "deep_investigation_completed_cache_hit"
      : "deep_investigation_completed",
    verification_id: verification.id,
  });
  if (txnError) {
    console.error("[deep] credit_transactions insert failed:", txnError);
  }

  const { data: balance } = await admin
    .from("credit_balances")
    .select("quick_checks_remaining, deep_investigations_remaining")
    .eq("user_id", user.id)
    .single();

  return NextResponse.json({
    id: verification.id,
    mode: "deep",
    claim: verification.claim_text,
    verdict: verification.verdict,
    confidence: verification.confidence,
    explanation: verification.summary,
    evidence: verification.key_evidence,
    sources: verification.sources,
    caveats: verification.caveats,
    cached: cacheHit,
    cached_at: cacheHit ? (result as CachedVerification).cached_at : null,
    credits: {
      quick_checks: balance?.quick_checks_remaining ?? 0,
      deep_investigations: balance?.deep_investigations_remaining ?? 0,
      total: (balance?.quick_checks_remaining ?? 0) + (balance?.deep_investigations_remaining ?? 0),
    },
  });
}
