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

// Route-level execution budget (Sept 2026 fix — see app/api/deep/route.ts's
// comment for the full rationale). 60 is Hobby's max; without it Vercel's
// silent 10s default kill can cut off runDeepInvestigation's multi-step
// search before it returns.
export const maxDuration = 60;

// Payee reputation Deep Investigation — mirrors app/api/verify-payee/
// route.ts exactly (see that file's header for the full rationale: why
// this exists, what it can and can't actually answer, and why the
// "Scam"/"Unverified" verdict split from lib/quick-check.ts's grounding
// rules already fits this use case). The only differences from the Quick
// Check version: the reasoning-tier pipeline (runDeepInvestigation
// decomposes into sub-questions and searches each — e.g. "has this UPI ID
// been reported in scam complaints", "does this business name have a
// verifiable public presence" — rather than one search pass), its own
// engine version/cache namespace, and decrement_deep_investigation/
// refund_deep_investigation. The reputation disclaimer caveat is
// prepended to whatever caveats Deep Investigation's own pipeline
// produces, rather than replacing them, since a Deep Investigation result
// can have genuinely useful caveats of its own (contradictory sources,
// stale information, etc.).
const DISCLAIMER =
  "This searches the public web for reports about this payee — it can't confirm who actually controls the payment ID, and finding nothing doesn't mean they're legitimate. Most real businesses and most scammers alike often have little to no searchable footprint.";

function buildPayeeClaim(payeeName: string, upiId: string): string {
  if (payeeName) {
    return `"${payeeName}" (UPI ID: ${upiId}) is a legitimate business or individual, with no public reports identifying them in a scam, fraud, or non-payment scheme.`;
  }
  return `The UPI ID "${upiId}" is legitimate, with no public reports identifying it in a scam, fraud, or non-payment scheme.`;
}

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const payeeName: string = (body?.payee_name ?? "").trim().slice(0, 200);
  const upiId: string = (body?.upi_id ?? "").trim().slice(0, 200);

  if (!upiId) {
    return NextResponse.json({ error: "No payee ID was provided." }, { status: 400 });
  }

  const admin = createAdminClient();
  const searchClaim = buildPayeeClaim(payeeName, upiId);
  const normalizedClaim = normalizeClaim(searchClaim);
  const cacheKey = computeCacheKey(normalizedClaim, "payee_reputation", DEEP_ENGINE_VERSION);
  const displayClaim = payeeName ? `${payeeName} — ${upiId}` : upiId;

  const { data: remaining, error: rpcError } = await admin.rpc("decrement_deep_investigation", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[deep-payee] decrement_deep_investigation RPC failed:", rpcError);
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
    const semantic = await checkSemanticCache(admin, normalizedClaim, "payee_reputation", DEEP_ENGINE_VERSION);
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
      result = await runDeepInvestigation(searchClaim);
    } catch (err) {
      console.error("[deep-payee] pipeline failed (refunding credit):", err);

      const { error: refundError } = await admin.rpc("refund_deep_investigation", { p_user_id: user.id });
      if (refundError) {
        console.error("[deep-payee] refund_deep_investigation RPC ALSO failed:", refundError);
      }

      await admin.from("credit_transactions").insert([
        { user_id: user.id, credit_type: "deep_investigation", amount: -1, reason: "deep_investigation_reserved" },
        { user_id: user.id, credit_type: "deep_investigation", amount: 1, reason: "deep_investigation_refunded_infra_error" },
      ]);

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

  const caveats = [DISCLAIMER, ...(result.caveats ?? [])];

  const { data: verification, error: insertError } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      mode: "deep",
      input_type: "payee_reputation",
      claim_text: displayClaim,
      normalized_claim: normalizeClaim(displayClaim),
      verdict: result.verdict,
      confidence: result.confidence,
      summary: result.summary,
      key_evidence: result.key_evidence,
      sources: result.sources,
      caveats,
      engine_version: result.engine_version,
      credit_charged: true,
    })
    .select()
    .single();

  if (insertError || !verification) {
    console.error("[deep-payee] verifications insert failed:", insertError);
    return NextResponse.json(
      { error: "Investigation ran but couldn't be saved. Please try again." },
      { status: 500 }
    );
  }

  if (!cacheHit) {
    await writeCache(admin, cacheKey, verification.id, searchClaim);
    if (semanticEmbedding) {
      await writeSemanticCache(
        admin,
        semanticEmbedding,
        "payee_reputation",
        DEEP_ENGINE_VERSION,
        verification.id,
        normalizedClaim,
        searchClaim
      );
    }
  }

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: user.id,
    credit_type: "deep_investigation",
    amount: -1,
    reason: cacheHit
      ? cacheMatchType === "semantic"
        ? "deep_investigation_completed_payee_cache_hit_semantic"
        : "deep_investigation_completed_payee_cache_hit"
      : "deep_investigation_completed_payee",
    verification_id: verification.id,
  });
  if (txnError) {
    console.error("[deep-payee] credit_transactions insert failed:", txnError);
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
