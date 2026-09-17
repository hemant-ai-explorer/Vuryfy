import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runQuickCheck, normalizeClaim, ENGINE_VERSION, type QuickCheckResult } from "@/lib/quick-check";
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
  const language = await getUserLanguage(admin, user.id);
  const cacheNamespace = language === "en" ? "payee_reputation" : `payee_reputation:${language}`;
  const searchClaim = buildPayeeClaim(payeeName, upiId);
  const normalizedClaim = normalizeClaim(searchClaim);
  const cacheKey = computeCacheKey(normalizedClaim, cacheNamespace, ENGINE_VERSION);
  const displayClaim = payeeName ? `${payeeName} — ${upiId}` : upiId;

  const { data: remaining, error: rpcError } = await admin.rpc("decrement_quick_check", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[verify-payee] decrement_quick_check RPC failed:", rpcError);
    return NextResponse.json(
      { error: "Could not check your credit balance. Please try again." },
      { status: 500 }
    );
  }
  if (remaining === null || remaining === undefined) {
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

      const { error: refundError } = await admin.rpc("refund_quick_check", { p_user_id: user.id });
      if (refundError) {
        console.error("[verify-payee] refund_quick_check RPC ALSO failed:", refundError);
      }

      await admin.from("credit_transactions").insert([
        { user_id: user.id, credit_type: "quick_check", amount: -1, reason: "quick_check_reserved" },
        { user_id: user.id, credit_type: "quick_check", amount: 1, reason: "quick_check_refunded_infra_error" },
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

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: user.id,
    credit_type: "quick_check",
    amount: -1,
    reason: cacheHit
      ? cacheMatchType === "semantic"
        ? "quick_check_completed_payee_cache_hit_semantic"
        : "quick_check_completed_payee_cache_hit"
      : "quick_check_completed_payee",
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
