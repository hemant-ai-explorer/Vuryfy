import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runQuickCheck, normalizeClaim, ENGINE_VERSION, type QuickCheckResult } from "@/lib/quick-check";
import { runImageQuickCheck, type ImageAnalysisResult } from "@/lib/image-analysis";
import { computeCacheKey, getCachedVerification, writeCache, type CachedVerification } from "@/lib/verification-cache";
import { detectPaymentReceipt } from "@/lib/detect-payment-receipt";
import { getUserLanguage } from "@/lib/user-language";
import { translate } from "@/lib/translations";

// Route-level execution budget (Sept 2026 fix — see app/api/deep/route.ts's
// comment for the full rationale). This route runs two AI pipelines in
// parallel (OCR text + photo), so it's exposed to Vercel's silent 10s
// default kill even more than most. 60 is Hobby's max.
export const maxDuration = 60;

// Combined image Quick Check — Sept 15, 2026, mirrors app/api/verify-audio-
// combined/route.ts's rationale exactly, applied to the same standing
// duplicate-buttons complaint that prompted the audio consolidation: a
// photo with readable text was offering TWO separate Quick Check/Deep
// Investigation button pairs on one screen (one for the OCR'd text, one
// for the photo itself), which read as confusing rather than as two
// genuinely different questions. This route runs BOTH the text
// fact-check (lib/quick-check.ts, on the OCR'd text) and the visual read
// (lib/image-analysis.ts, on the photo itself) behind a single button
// press, charging exactly 1 Quick Check credit total — same explicit
// "charge once even though two pipelines run" decision already made for
// audio.
//
// Payment-receipt carve-out (see lib/detect-payment-receipt.ts): this is
// specifically what makes a PHOTOGRAPHED payment receipt behave the same
// honest way a pasted one does. If the OCR'd text looks like a payment
// receipt, this short-circuits before running anything — no text
// fact-check, no vision call, no credit charged — and returns the same
// payment_receipt shape /api/verify does. (The vision half is skipped too,
// deliberately: a detected receipt gets the free, no-AI-call treatment
// across the board, same as a payment QR code gets zero AI calls.)
//
// When the photo has NO readable text at all, the client doesn't call this
// route — it still uses the vision-only /api/verify-image directly, since
// there's nothing to combine (see app/verify/image/page.tsx).
//
// Caching: the text half reuses verification-cache.ts exactly like
// /api/verify (keyed as input_type "image_ocr" rather than "ocr" so an
// OCR'd claim run standalone vs. combined with a photo don't collide on
// the same cache row, since the combined response shape differs). The
// vision half is deliberately NOT cached — see lib/image-analysis.ts's
// header on why (real photos are essentially never byte-identical on
// resubmission).
//
// Sept 16, 2026 fast-follow: the text half's cache namespace is now
// language-aware (same pattern as app/api/verify/route.ts), and the
// vision half now gets the user's language passed through so its own
// summary/caveats come back localized.
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

  const admin = createAdminClient();

  const receipt = detectPaymentReceipt(ocrText);
  if (receipt) {
    const { data: balance } = await admin
      .from("credit_balances")
      .select("quick_checks_remaining, deep_investigations_remaining")
      .eq("user_id", user.id)
      .single();

    return NextResponse.json({
      id: null,
      mode: "quick",
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
  const textCacheKey = computeCacheKey(normalizedOcr, textCacheNamespace, ENGINE_VERSION);

  const { data: remaining, error: rpcError } = await admin.rpc("decrement_quick_check", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[verify-image-combined] decrement_quick_check RPC failed:", rpcError);
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

  const textCached = await getCachedVerification(admin, textCacheKey);
  const textCacheHit = textCached !== null;

  let textResult: QuickCheckResult | CachedVerification;
  let imageResult: ImageAnalysisResult;
  try {
    const [freshText, freshImage] = await Promise.all([
      textCached ? Promise.resolve(null) : runQuickCheck(ocrText, language),
      runImageQuickCheck(imageBase64, mimeType, context || null, language),
    ]);
    textResult = textCached ?? (freshText as QuickCheckResult);
    imageResult = freshImage as ImageAnalysisResult;
  } catch (err) {
    console.error("[verify-image-combined] pipeline failed (refunding credit):", err);

    const { error: refundError } = await admin.rpc("refund_quick_check", { p_user_id: user.id });
    if (refundError) {
      console.error("[verify-image-combined] refund_quick_check RPC ALSO failed:", refundError);
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

  const { data: ocrRow, error: insertError1 } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      mode: "quick",
      input_type: "ocr",
      claim_text: ocrText,
      normalized_claim: normalizedOcr,
      verdict: textResult.verdict,
      confidence: textResult.confidence,
      summary: textResult.summary,
      key_evidence: textResult.key_evidence,
      sources: textResult.sources,
      engine_version: textResult.engine_version,
      credit_charged: true,
    })
    .select()
    .single();

  if (insertError1 || !ocrRow) {
    console.error("[verify-image-combined] ocr verifications insert failed:", insertError1);
    return NextResponse.json(
      { error: "Verification ran but couldn't be saved. Please try again." },
      { status: 500 }
    );
  }

  const imageClaimText = context || "[Photo submitted for visual analysis]";
  const { data: imageRow, error: insertError2 } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      mode: "quick",
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
    console.error("[verify-image-combined] image verifications insert failed:", insertError2);
  }

  if (!textCacheHit) {
    await writeCache(admin, textCacheKey, ocrRow.id, ocrText);
  }

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: user.id,
    credit_type: "quick_check",
    amount: -1,
    reason: textCacheHit ? "quick_check_completed_combined_image_cache_hit" : "quick_check_completed_combined_image",
    verification_id: ocrRow.id,
  });
  if (txnError) {
    console.error("[verify-image-combined] credit_transactions insert failed:", txnError);
  }

  const { data: balance } = await admin
    .from("credit_balances")
    .select("quick_checks_remaining, deep_investigations_remaining")
    .eq("user_id", user.id)
    .single();

  return NextResponse.json({
    id: ocrRow.id,
    mode: "quick",
    claim: ocrRow.claim_text,
    verdict: ocrRow.verdict,
    confidence: ocrRow.confidence,
    explanation: ocrRow.summary,
    evidence: ocrRow.key_evidence,
    sources: ocrRow.sources,
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
