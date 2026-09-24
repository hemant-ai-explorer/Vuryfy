import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runQuickCheck, normalizeClaim, ENGINE_VERSION, type QuickCheckResult } from "@/lib/quick-check";
import { findSimilarPayee } from "@/lib/payee-similarity";
import { verifyRegisteredName } from "@/lib/vpa-registered-name";
import { getUserLanguage } from "@/lib/user-language";
import { translate } from "@/lib/translations";
import {
  computeCacheKey,
  getCachedVerification,
  writeCache,
  checkSemanticCache,
  writeSemanticCache,
  type CachedVerification,
} from "@/lib/verification-cache";
import { track } from "@/lib/analytics";

// Route-level execution budget (Sept 2026 fix — see app/api/deep/route.ts's
// comment for the full rationale). 60 is Hobby's max; without it Vercel's
// silent 10s default kill can cut off runQuickCheck's search-and-synthesize
// pipeline before it returns.
export const maxDuration = 60;

// Payee reputation Quick Check — Sept 15, 2026, added from the payment-QR
// card (app/verify/qr/page.tsx) after a user asked "what if I want Deep
// Investigation on this?" for a payment QR.
//
// This is deliberately a DIFFERENT question from what the payment-QR
// carve-out (lib/detect-payment-link.ts) and the payment-receipt carve-out
// (lib/detect-payment-receipt.ts) both correctly refuse to answer. Neither
// pipeline can confirm who controls a specific UPI ID or whether a private
// transaction happened — that's still true here, and this route doesn't
// try. What IS a genuinely searchable, evidence-groundable question: does
// this payee NAME or UPI ID have any public reputation — scam reports,
// fraud complaints, a legitimate business footprint — the same kind of
// question the ordinary text pipeline already answers for any other claim.
//
// This reuses lib/quick-check.ts entirely unchanged, just with a
// constructed claim rather than a user-typed one, framed so the existing
// "Scam" verdict (see quick-check.ts's header) does exactly the right
// thing: it only fires when retrieved evidence specifically names THIS
// payee/UPI ID as a scam, never from vibes. The much more common case —
// zero search results, since most small businesses and most scammers
// alike have little to no web footprint — correctly falls back to
// "Unverified" (quick-check.ts's built-in zero-evidence path), which is
// exactly right here too: no news is not good news. A caveat saying so is
// attached to every result below, in code, so it survives regardless of
// how the model happens to phrase its summary.
//
// Credit/cache pattern: identical to /api/verify — a real search + AI call
// happened, so it costs a Quick Check credit like any other claim, and
// gets the same exact-match caching (a repeat investigation of the same
// payee within the cache TTL doesn't re-run the search).
//
// Sept 16, 2026 fast-follow: reuses lib/quick-check.ts's own output
// localization (a `language` param already threaded through that
// pipeline) — this route just needed to look up the user's language and
// pass it along, plus namespace the cache key by language, same pattern
// as app/api/verify/route.ts.
//
// Sept 17, 2026: closed the DISCLAIMER localization gap flagged at the end
// of the Sept 16 fast-follow above — this caveat now comes from
// translate(language, "payee.disclaimer") (lib/translations.ts) instead of
// a hardcoded English const, computed inline in POST() below where
// `language` is actually known, same pattern as every other pipeline's
// disclaimer caveat.
//
// Sept 23, 2026: revised cost design for the real VPA→registered-name
// lookup (lib/vpa-registered-name.ts). Deep Investigation bundles it in
// automatically at no extra cost (its allowance is small enough that the
// worst case stays under ₹10/month). Quick Check only includes it when the
// caller explicitly opts in via `include_registered_name: true` in the
// request body — and that opt-in costs 2 Quick Check credits instead of 1,
// via decrement_quick_check's new optional p_amount param (migration
// 0020_registered_name_credit_amount.sql). This halves the worst-case
// exposure on the Starter plan (max 15 such checks/month instead of 30)
// versus riding the plain 1-credit charge. An ordinary payee Quick Check
// (no registered-name opt-in) is completely unaffected — still 1 credit,
// exactly as before.

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
  // Sept 23, 2026: see this file's header comment for the full cost-design
  // rationale — opting into the real registered-name lookup here costs 2
  // Quick Check credits instead of 1.
  const includeRegisteredName: boolean = body?.include_registered_name === true;
  const quickCheckAmount = includeRegisteredName ? 2 : 1;

  if (!upiId) {
    return NextResponse.json({ error: "No payee ID was provided." }, { status: 400 });
  }

  const admin = createAdminClient();

  // Analytics (Part 23, Sept 21, 2026) — see lib/analytics.ts's header.
  track(user.id, "verification_submitted", { mode: "quick", input_type: "payee_reputation" });

  const language = await getUserLanguage(admin, user.id);
  const cacheNamespace = language === "en" ? "payee_reputation" : `payee_reputation:${language}`;
  const searchClaim = buildPayeeClaim(payeeName, upiId);
  const normalizedClaim = normalizeClaim(searchClaim);
  const cacheKey = computeCacheKey(normalizedClaim, cacheNamespace, ENGINE_VERSION);
  const displayClaim = payeeName ? `${payeeName} — ${upiId}` : upiId;

  const { data: remaining, error: rpcError } = await admin.rpc("decrement_quick_check", {
    p_user_id: user.id,
    p_amount: quickCheckAmount,
  });

  if (rpcError) {
    console.error("[verify-payee] decrement_quick_check RPC failed:", rpcError);
    return NextResponse.json(
      { error: "Could not check your credit balance. Please try again." },
      { status: 500 }
    );
  }
  if (remaining === null || remaining === undefined) {
    track(user.id, "credits_exhausted", { mode: "quick", credit_type: "quick_check" });
    return NextResponse.json(
      { error: "You're out of Quick Check credits. Upgrade your plan to continue." },
      { status: 402 }
    );
  }

  // Semantic-cache fallback (Part 11's "Semantic" layer, Sept 16, 2026) —
  // see app/api/verify/route.ts's identical comment for the full rationale.
  // Payee-reputation claims are auto-constructed from a name/UPI ID (see
  // buildPayeeClaim above), so this mainly helps when the same payee is
  // re-investigated with a slightly different name spelling/casing that
  // survives normalizeClaim() differently but still embeds near-identically.
  const cached = await getCachedVerification(admin, cacheKey);
  let cacheHit = cached !== null;
  let cacheMatchType: "exact" | "semantic" | null = cacheHit ? "exact" : null;
  let semanticEmbedding: number[] | null = null;
  let semanticMatch: CachedVerification | null = null;

  if (!cached) {
    const semantic = await checkSemanticCache(admin, normalizedClaim, cacheNamespace, ENGINE_VERSION);
    semanticEmbedding = semantic.embedding;
    semanticMatch = semantic.match;
    if (semanticMatch) {
      cacheHit = true;
      cacheMatchType = "semantic";
    }
  }

  let result: QuickCheckResult | CachedVerification;
  if (cached) {
    result = cached;
  } else if (semanticMatch) {
    result = semanticMatch;
  } else {
    try {
      result = await runQuickCheck(searchClaim, language);
    } catch (err) {
      console.error("[verify-payee] pipeline failed (refunding credit):", err);

      const { error: refundError } = await admin.rpc("refund_quick_check", {
        p_user_id: user.id,
        p_amount: quickCheckAmount,
      });
      if (refundError) {
        console.error("[verify-payee] refund_quick_check RPC ALSO failed:", refundError);
      }

      await admin.from("credit_transactions").insert([
        { user_id: user.id, credit_type: "quick_check", amount: -quickCheckAmount, reason: "quick_check_reserved" },
        {
          user_id: user.id,
          credit_type: "quick_check",
          amount: quickCheckAmount,
          reason: "quick_check_refunded_infra_error",
        },
      ]);

      track(user.id, "verification_failed", { mode: "quick", input_type: "payee_reputation", reason: "infra_error" });

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

  // Sept 23, 2026: the impersonation/look-alike warning now surfaces only
  // here — as part of the credit-charged result — never on the free
  // pre-choice payment card. See lib/payee-similarity.ts's header for the
  // full rationale. Computed fresh every request, independent of the
  // verdict cache above, since scan history can change between requests.
  const similarMatch = await findSimilarPayee(admin, user.id, upiId, payeeName);

  // Sept 23, 2026: see lib/vpa-registered-name.ts's header and this file's
  // header for the full rationale — currently always resolves to
  // { available: false } since no real provider is wired in yet. Only
  // attempted when the caller opted in (and paid the extra credit for it,
  // above) — a plain payee Quick Check never calls this, so no `null` vs
  // `{available:false}` distinction is lost by skipping it: both render as
  // nothing on the result page either way.
  const registeredIdentity = includeRegisteredName ? await verifyRegisteredName(admin, upiId, payeeName) : null;

  const caveats = [translate(language, "payee.disclaimer")];

  const { data: verification, error: insertError } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      mode: "quick",
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
    console.error("[verify-payee] verifications insert failed:", insertError);
    return NextResponse.json(
      { error: "Verification ran but couldn't be saved. Please try again." },
      { status: 500 }
    );
  }

  if (!cacheHit) {
    await writeCache(admin, cacheKey, verification.id, searchClaim);
    if (semanticEmbedding) {
      await writeSemanticCache(
        admin,
        semanticEmbedding,
        cacheNamespace,
        ENGINE_VERSION,
        verification.id,
        normalizedClaim,
        searchClaim
      );
    }
  }

  // Sept 23, 2026: reason string gets a "_with_registered_name" suffix
  // when the caller opted into (and paid the extra credit for) the real
  // VPA lookup, so the billing ledger shows which 2-credit charges were
  // for that specifically — independent of the amount field, which
  // already reflects the actual credits moved (-1 vs -2).
  let quickCheckReason = cacheHit
    ? cacheMatchType === "semantic"
      ? "quick_check_completed_payee_cache_hit_semantic"
      : "quick_check_completed_payee_cache_hit"
    : "quick_check_completed_payee";
  if (includeRegisteredName) quickCheckReason += "_with_registered_name";

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: user.id,
    credit_type: "quick_check",
    amount: -quickCheckAmount,
    reason: quickCheckReason,
    verification_id: verification.id,
  });
  if (txnError) {
    console.error("[verify-payee] credit_transactions insert failed:", txnError);
  }

  const { data: balance } = await admin
    .from("credit_balances")
    .select("quick_checks_remaining, deep_investigations_remaining")
    .eq("user_id", user.id)
    .single();

  track(user.id, "verification_completed", {
    mode: "quick",
    input_type: "payee_reputation",
    verdict: verification.verdict,
    cached: cacheHit,
    cache_match_type: cacheMatchType,
    engine_version: verification.engine_version,
  });

  return NextResponse.json({
    id: verification.id,
    mode: "quick",
    // Sept 17, 2026: `type: "payee_reputation"` + the explicit `payee`
    // object let app/result/page.tsx render this differently from an
    // ordinary claim result — see that file's payee_reputation branch.
    // The raw True/False/Misleading/Unverified verdict word was reading
    // as confusing/alarming for what's really an identity/reputation
    // lookup, not a fact-check, so the result now leads with the payee's
    // own name/ID instead (same treatment the free QR-decode preview
    // already gives it) and only shows a dedicated alert when the verdict
    // actually is "Scam" — verdict/confidence/explanation/evidence/caveats
    // are all still returned unchanged below for that rendering to use.
    type: "payee_reputation",
    payee: { name: payeeName || null, upiId },
    similarMatch,
    registeredIdentity,
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
