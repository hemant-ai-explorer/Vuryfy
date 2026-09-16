import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runImageQuickCheck } from "@/lib/image-analysis";
import { normalizeClaim } from "@/lib/quick-check";
import { getUserLanguage } from "@/lib/user-language";

// Route-level execution budget (Sept 2026 fix — see app/api/deep/route.ts's
// comment for the full rationale). 60 is Hobby's max; without it Vercel's
// silent 10s default kill can cut off runImageQuickCheck before it
// returns.
export const maxDuration = 60;

// Photo-as-claim Quick Check — a separate route from /api/verify rather
// than a special case bolted onto it, because the request/response shape
// genuinely differs: this one carries base64 image data instead of a plain
// claim string, and its result comes from lib/image-analysis.ts's
// deliberately narrower, non-evidence-grounded verdict vocabulary (Clean/
// Suspicious/Inconclusive), not the True/False/Misleading/Unverified/Scam
// set text claims get. Same separate-files rationale already used for
// /api/verify vs /api/deep applies here too — a shared handler would
// mostly be indirection given how much actually differs.
//
// The OTHER half of image input — OCR-extracted text — does NOT come
// through here. It reuses /api/verify directly with input_type: "ocr",
// exactly like QR reuses it with input_type: "qr", because that path
// really is just a claim string once decode-image-text.ts has run
// client-side. This route exists only for the photo itself.
//
// Credit pattern: identical reserve-then-refund-on-infra-failure semantics
// as /api/verify, spending a Quick Check credit — a photo-as-claim
// analysis is still a Quick Check from the user's/billing's perspective,
// same principle as Part 26.4 addition #1 ("charge on completion,
// including a non-committal verdict — Inconclusive here plays the same
// role Unverified/Clean do for text").
//
// No exact-match cache integration — see lib/image-analysis.ts's file
// header for why (byte-identical resubmission is rare enough for real
// photos that it isn't worth the complexity in V1).
//
// Media retention: the image arrives as base64 in the request body, is
// passed straight through to the Gemini vision call, and is never written
// to Supabase storage or any other persistence layer here — see lib/
// image-analysis.ts for the full retention rationale.
//
// Sept 16, 2026 fast-follow: looks up the user's stored language
// preference and passes it through to runImageQuickCheck so the AI's own
// summary/signals_found (and the code-built disclaimer/caveats) come back
// localized. No cache key change needed here — this pipeline is uncached.
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_BASE64_LENGTH = 8_000_000; // ~6MB binary — generous for a client-downscaled JPEG

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

  const admin = createAdminClient();
  const language = await getUserLanguage(admin, user.id);

  const { data: remaining, error: rpcError } = await admin.rpc("decrement_quick_check", {
    p_user_id: user.id,
  });

  if (rpcError) {
    console.error("[verify-image] decrement_quick_check RPC failed:", rpcError);
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

  let result;
  try {
    result = await runImageQuickCheck(imageBase64, mimeType, context || null, language);
  } catch (err) {
    console.error("[verify-image] pipeline failed (refunding credit):", err);

    const { error: refundError } = await admin.rpc("refund_quick_check", { p_user_id: user.id });
    if (refundError) {
      console.error("[verify-image] refund_quick_check RPC ALSO failed:", refundError);
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

  const claimText = context || "[Photo submitted for visual analysis]";

  const { data: verification, error: insertError } = await admin
    .from("verifications")
    .insert({
      user_id: user.id,
      mode: "quick",
      input_type: "image",
      claim_text: claimText,
      normalized_claim: normalizeClaim(claimText),
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
    console.error("[verify-image] verifications insert failed:", insertError);
    return NextResponse.json(
      {
        error: "Analysis ran but couldn't be saved. Please try again.",
        ...(process.env.NODE_ENV !== "production" && insertError
          ? { debug: { message: insertError.message, details: insertError.details, hint: insertError.hint, code: insertError.code } }
          : {}),
      },
      { status: 500 }
    );
  }

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: user.id,
    credit_type: "quick_check",
    amount: -1,
    reason: "quick_check_completed",
    verification_id: verification.id,
  });
  if (txnError) {
    console.error("[verify-image] credit_transactions insert failed:", txnError);
  }

  const { data: balance } = await admin
    .from("credit_balances")
    .select("quick_checks_remaining, deep_investigations_remaining")
    .eq("user_id", user.id)
    .single();

  return NextResponse.json({
    id: verification.id,
    mode: "quick",
    claim: verification.claim_text,
    verdict: verification.verdict,
    confidence: verification.confidence,
    explanation: verification.summary,
    evidence: verification.key_evidence,
    sources: verification.sources,
    caveats: verification.caveats,
    cached: false,
    cached_at: null,
    credits: {
      quick_checks: balance?.quick_checks_remaining ?? 0,
      deep_investigations: balance?.deep_investigations_remaining ?? 0,
      total: (balance?.quick_checks_remaining ?? 0) + (balance?.deep_investigations_remaining ?? 0),
    },
  });
}
