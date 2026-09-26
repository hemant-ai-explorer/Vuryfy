import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runDeepInvestigation, DEEP_ENGINE_VERSION, type DeepInvestigationResult } from "@/lib/deep-investigation";
import { DEEP_INVESTIGATION_BUDGET_MS } from "@/lib/ai-gateway";
import { normalizeClaim } from "@/lib/quick-check";
import { runImageDeepInvestigation, type ImageAnalysisResult } from "@/lib/image-analysis";
import { computeCacheKey, getCachedVerification, writeCache, type CachedVerification } from "@/lib/verification-cache";
import { detectPaymentReceipt } from "@/lib/detect-payment-receipt";
import { getUserLanguage } from "@/lib/user-language";
import { translate } from "@/lib/translations";
import { checkContentSafety, ContentFlaggedError, hashBase64 } from "@/lib/content-safety";
import { track } from "@/lib/analytics";

// Route-level execution budget (Sept 2026 fix — see app/api/deep/route.ts's
// comment for the full rationale). This route runs two AI pipelines in
// parallel (OCR text + photo), so it's exposed to Vercel's silent 10s
// default kill even more than most. 60 is Hobby's max.
export const maxDuration = 60;

// Combined image Deep Investigation — mirrors app/api/verify-image-
// combined/route.ts exactly (see that file's header for the full
// rationale: the duplicate-buttons fix, the explicit 1-credit-total
// decision, and the payment-receipt carve-out). The only differences from
// the Quick Check version: the reasoning-tier pipelines
// (runDeepInvestigation, runImageDeepInvestigation) and their own engine
// versions/cache namespace, decrement_deep_investigation/
// refund_deep_investigation, and including caveats on the OCR row too
// (Deep Investigation's text pipeline produces caveats; Quick Check's
// doesn't — see app/api/deep/route.ts vs app/api/verify/route.ts for the
// same asymmetry elsewhere in the app).
//
// Sept 16, 2026 fast-follow: the text half's cache namespace is now
// language-aware, and the vision half now gets the user's language passed
// through — see app/api/verify-image-combined/route.ts's identical
// comment.
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BASE64_LENGTH = 8_000_000;

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const imageBase64: string = body?.image_base64 ?? "";
  const mimeType: string = body?.mime_type ?? "";
  const ocrText: string = (body?.ocr_text ?? "").trim();
  const context: string = (body?.context ?? "").trim().slice(0, 500);

  if (!imageBase64) {
    return NextResponse.json({ error: "No image was provided." }, { status: 400 });
  }
  if (imageBase64.length > MAX_BASE64_LENGTH) {
    return NextResponse.json({ error: "That image is too large. Try a smaller photo." }, { status: 400 });
  }
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    return NextResponse.json({ error: "Unsupported image type." }, { status: 400 });
  }
  if (ocrText.length < 5) {
    return NextResponse.json(
      { error: "No usable text to combine — use the photo-only check instead." },
      { status: 400 }
    );
  }
  if (ocrText.length > 10000) {
    return NextResponse.json({ error: "Text is too long (10,000 character limit)." }, { status: 400 });
  }

  const admin = createAdminClient();

  // Analytics (Part 23, Sept 21, 2026) — see lib/analytics.ts's header.
  track(user.id, "verification_submitted", { mode: "deep", input_type: "image_combined" });

  // Content safety (Part 15, Sept 19, 2026) — scan before any credit is
  // charged or the image reaches an AI provider. See lib/content-safety.ts's
  // file header (currently a stub; no real hash-matching provider is wired
  // in yet).
  try {
    await checkContentSafety({
      admin,
      userId: user.id,
      contentType: "image",
      contentHash: hashBase64(imageBase64),
      sourceRoute: "deep-image-combined",
      imageBase64,
    });
  } catch (err) {
    if (err instanceof ContentFlaggedError) {
      return NextResponse.json({ error: "This content can't be processed." }, { status: 422 });
    }
    throw err;
  }

  const receipt = detectPaymentReceipt(ocrText);
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
      claim: ocrText,
      receipt,
      credits: {
        quick_checks: balance?.quick_checks_remaining ?? 0,
        deep_investigations: balance?.deep_investigations_remaining ?? 0,
        total: (balance?.quick_checks_remaining ?? 0) + (balance?.deep_investigations_remaining ?? 0),
      },
    });
  }

  const language = await getUserLanguage(admin, user.id);
  const textCacheNamespace = language === "en" ? "image_ocr" : `image_ocr:${language}`;
  const normalizedOcr = normalizeClaim(ocrText);
  const textCacheKey = computeCacheKey(normalizedOcr, textCacheNamespace, DEEP_ENGINE_VERSION);

  const { data: remaining, error: rpcError } = await admin.rpc("decrement_deep_investigation", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[deep-image-combined] decrement_deep_investigation RPC failed:", rpcError);
    return NextResponse.json(
      { error: "Could not check your credit balance. Please try again." },
      { status: 500 }
    );
  }
  if (remaining === null || remaining === undefined) {
    track(user.id, "credits_exhausted", { mode: "deep", credit_type: "deep_investigation" });
    return NextResponse.json(
      { error: "You're out of Deep Investigation credits. Upgrade your plan to continue." },
      { status: 402 }
    );
  }

  const textCached = await getCachedVerification(admin, textCacheKey);
  const textCacheHit = textCached !== null;

  let textResult: DeepInvestigationResult | CachedVerification;
  let imageResult: ImageAnalysisResult;
  try {
    // Sept 24, 2026: one shared deadline for both branches of this
    // Promise.all — they're racing against the SAME 60s route ceiling, so
    // they need to share one real wall-clock budget rather than each
    // independently assuming it has the full retry/fallback allowance
    // available. See ai-gateway.ts's DEEP_INVESTIGATION_BUDGET_MS.
    const deadlineAt = Date.now() + DEEP_INVESTIGATION_BUDGET_MS;
    const [freshText, freshImage] = await Promise.all([
      textCached ? Promise.resolve(null) : runDeepInvestigation(ocrText, language, deadlineAt),
      runImageDeepInvestigation(imageBase64, mimeType, context || null, language, deadlineAt),
    ]);
    textResult = textCached ?? (freshText as DeepInvestigationResult);
    imageResult = freshImage as ImageAnalysisResult;
  } catch (err) {
    console.error("[deep-image-combined] pipeline failed (refunding credit):", err);

    const { error: refundError } = await admin.rpc("refund_deep_investigation", { p_user_id: user.id });
    if (refundError) {
      console.error("[deep-image-combined] refund_deep_investigation RPC ALSO failed:", refundError);
    }

    await admin.from("credit_transactions").insert([
      { user_id: user.id, credit_type: "deep_investigation", amount: -1, reason: "deep_investigation_reserved" },
      { user_id: user.id, credit_type: "deep_investigation", amount: 1, reason: "deep_investigation_refunded_infra_error" },
    ]);

    track(user.id, "verification_failed", { mode: "deep", input_type: "image_combined", reason: "infra_error" });

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

  const { data: ocrRow, error: insertError1 } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      mode: "deep",
      input_type: "ocr",
      claim_text: ocrText,
      normalized_claim: normalizedOcr,
      verdict: textResult.verdict,
      confidence: textResult.confidence,
      summary: textResult.summary,
      key_evidence: textResult.key_evidence,
      sources: textResult.sources,
      caveats: textResult.caveats,
      engine_version: textResult.engine_version,
      credit_charged: true,
    })
    .select()
    .single();

  if (insertError1 || !ocrRow) {
    console.error("[deep-image-combined] ocr verifications insert failed:", insertError1);
    return NextResponse.json(
      { error: "Investigation ran but couldn't be saved. Please try again." },
      { status: 500 }
    );
  }

  const imageClaimText = context || "[Photo submitted for visual analysis]";
  const { data: imageRow, error: insertError2 } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      mode: "deep",
      input_type: "image",
      claim_text: imageClaimText,
      normalized_claim: normalizeClaim(imageClaimText),
      verdict: imageResult.verdict,
      confidence: imageResult.confidence,
      summary: imageResult.summary,
      key_evidence: imageResult.key_evidence,
      sources: imageResult.sources,
      caveats: imageResult.caveats,
      engine_version: imageResult.engine_version,
      credit_charged: false,
    })
    .select()
    .single();

  if (insertError2 || !imageRow) {
    console.error("[deep-image-combined] image verifications insert failed:", insertError2);
  }

  if (!textCacheHit) {
    await writeCache(admin, textCacheKey, ocrRow.id, ocrText);
  }

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: user.id,
    credit_type: "deep_investigation",
    amount: -1,
    reason: textCacheHit
      ? "deep_investigation_completed_combined_image_cache_hit"
      : "deep_investigation_completed_combined_image",
    verification_id: ocrRow.id,
  });
  if (txnError) {
    console.error("[deep-image-combined] credit_transactions insert failed:", txnError);
  }

  const { data: balance } = await admin
    .from("credit_balances")
    .select("quick_checks_remaining, deep_investigations_remaining")
    .eq("user_id", user.id)
    .single();

  track(user.id, "verification_completed", {
    mode: "deep",
    input_type: "ocr",
    verdict: ocrRow.verdict,
    cached: textCacheHit,
    credit_charged: true,
  });
  if (imageRow) {
    track(user.id, "verification_completed", {
      mode: "deep",
      input_type: "image",
      verdict: imageRow.verdict,
      cached: false,
      credit_charged: false,
    });
  }

  return NextResponse.json({
    id: ocrRow.id,
    mode: "deep",
    claim: ocrRow.claim_text,
    verdict: ocrRow.verdict,
    confidence: ocrRow.confidence,
    explanation: ocrRow.summary,
    evidence: ocrRow.key_evidence,
    sources: ocrRow.sources,
    caveats: ocrRow.caveats,
    cached: textCacheHit,
    cached_at: textCacheHit ? (textCached as CachedVerification).cached_at : null,
    secondary: imageRow
      ? {
          id: imageRow.id,
          eyebrow: translate(language, "result.eyebrowPhoto"),
          verdict: imageRow.verdict,
          confidence: imageRow.confidence,
          explanation: imageRow.summary,
          caveats: imageRow.caveats,
        }
      : null,
    credits: {
      quick_checks: balance?.quick_checks_remaining ?? 0,
      deep_investigations: balance?.deep_investigations_remaining ?? 0,
      total: (balance?.quick_checks_remaining ?? 0) + (balance?.deep_investigations_remaining ?? 0),
    },
  });
}
