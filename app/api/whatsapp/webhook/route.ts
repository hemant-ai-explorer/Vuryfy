import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeWhatsAppPhone, verifyTwilioSignature } from "@/lib/whatsapp";
import { runQuickCheck, normalizeClaim } from "@/lib/quick-check";
import { getUserLanguage } from "@/lib/user-language";

// Twilio's inbound-message webhook for the WhatsApp submission MVP (Part
// 13) — see supabase/migrations/0016_whatsapp_link_codes.sql's header for
// the full design. Twilio calls this directly with no Vuryfy session or
// cookie, so identity comes entirely from matching the message's content
// and sender against a whatsapp_link_codes row, never from Supabase auth
// — every DB access here uses the admin (service_role) client.
//
// Twilio request signature validation (lib/whatsapp.ts) confirms the
// request actually came from Twilio and wasn't forged by someone who
// discovered this URL.
//
// Deliberately simpler than app/api/verify/route.ts's full pipeline: no
// exact/semantic cache lookup, no payment-receipt/payment-request
// carve-outs — just decrement credit -> runQuickCheck -> insert
// verification, mirroring only that route's credit-safety half (reserve,
// refund on infra failure). Flagged here as a known simplification to
// close later, not an oversight — same "ship the mechanism thin first,
// extend later" pattern used everywhere else in this project.
//
// No WhatsApp reply after a claim is processed, per the user's explicit
// choice — WhatsApp is purely an upload channel here; the verdict is
// viewed in the app (app/saved/page.tsx's history list) once the new
// verification row lands. The ONE reply this route ever sends is a short
// operational confirmation on successful LINKING ("you're connected,
// send your claim next") — never the verdict itself.
export const maxDuration = 60;

const MIN_CLAIM_LENGTH = 5;
const RELINK_WINDOW_MINUTES = 15;

function twiml(message?: string): NextResponse {
  const body = message
    ? `<Response><Message>${escapeXml(message)}</Message></Response>`
    : `<Response></Response>`;
  return new NextResponse(body, { headers: { "Content-Type": "text/xml" } });
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function POST(request: Request) {
  const rawBody = await request.text();
  const params = new URLSearchParams(rawBody);
  const paramsObj: Record<string, string> = {};
  params.forEach((value, key) => {
    paramsObj[key] = value;
  });

  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const signature = request.headers.get("x-twilio-signature");
  if (!authToken) {
    console.error("[whatsapp/webhook] TWILIO_AUTH_TOKEN is not set — refusing all requests");
    return new NextResponse("Not configured", { status: 500 });
  }
  if (!verifyTwilioSignature(authToken, request.url, paramsObj, signature)) {
    console.error("[whatsapp/webhook] signature validation failed");
    return new NextResponse("Invalid signature", { status: 403 });
  }

  const from = paramsObj["From"] || "";
  const bodyText = (paramsObj["Body"] || "").trim();
  const numMedia = parseInt(paramsObj["NumMedia"] || "0", 10);
  const phone = normalizeWhatsAppPhone(from);

  if (!phone) {
    return twiml();
  }

  const admin = createAdminClient();
  const nowIso = new Date().toISOString();

  // Step 1: does this message's text match a pending (generated, not yet
  // linked, unexpired, unconsumed) code exactly? Codes are generated
  // uppercase; compared case-insensitively since a person retyping one
  // might not preserve case even though wa.me's pre-filled text usually
  // means they never actually retype it.
  const candidateCode = bodyText.toUpperCase();
  if (candidateCode.length > 0 && numMedia === 0) {
    const { data: codeRow } = await admin
      .from("whatsapp_link_codes")
      .select("id")
      .eq("code", candidateCode)
      .is("consumed_at", null)
      .is("linked_at", null)
      .gt("expires_at", nowIso)
      .maybeSingle();

    if (codeRow) {
      const newExpiry = new Date(Date.now() + RELINK_WINDOW_MINUTES * 60 * 1000).toISOString();
      const { error: linkError } = await admin
        .from("whatsapp_link_codes")
        .update({ phone_number: phone, linked_at: nowIso, expires_at: newExpiry })
        .eq("id", codeRow.id);

      if (linkError) {
        console.error("[whatsapp/webhook] failed to link code:", linkError);
        return twiml("Something went wrong linking your Vuryfy account. Please try again from the app.");
      }

      return twiml(
        "You're connected to Vuryfy. Send the text, claim, or link you want checked as your next message."
      );
    }
  }

  // Step 2: is this phone number currently linked to a pending (unconsumed,
  // unexpired) code? If so, THIS message is the claim to verify.
  const { data: linkedRow } = await admin
    .from("whatsapp_link_codes")
    .select("id, user_id, input_type")
    .eq("phone_number", phone)
    .is("consumed_at", null)
    .not("linked_at", "is", null)
    .gt("expires_at", nowIso)
    .order("linked_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!linkedRow) {
    // Unrecognized sender/message — ignore silently rather than engaging
    // with random numbers that happen to text the sandbox/production
    // number.
    return twiml();
  }

  if (numMedia > 0) {
    return twiml(
      "Photo, audio, and video submissions over WhatsApp aren't available yet — only text claims are supported right now. Please use the Vuryfy app for other formats."
    );
  }

  if (bodyText.length < MIN_CLAIM_LENGTH) {
    return twiml("That message is too short to check. Please send a longer claim or statement.");
  }

  const userId = linkedRow.user_id;

  // Same atomic conditional decrement as app/api/verify/route.ts — only
  // succeeds if the user actually has a Quick Check left.
  const { data: remaining, error: rpcError } = await admin.rpc("decrement_quick_check", {
    p_user_id: userId,
  });

  if (rpcError) {
    console.error("[whatsapp/webhook] decrement_quick_check RPC failed:", rpcError);
    return twiml("Couldn't check your credit balance right now. Please try again from the app.");
  }

  if (remaining === null || remaining === undefined) {
    return twiml("You're out of Quick Check credits. Upgrade your plan in the app to continue.");
  }

  const language = await getUserLanguage(admin, userId);

  let result;
  try {
    result = await runQuickCheck(bodyText, language);
  } catch (err) {
    console.error("[whatsapp/webhook] Quick Check pipeline failed (refunding credit):", err);
    const { error: refundError } = await admin.rpc("refund_quick_check", { p_user_id: userId });
    if (refundError) {
      console.error("[whatsapp/webhook] refund_quick_check RPC ALSO failed:", refundError);
    }
    await admin.from("credit_transactions").insert([
      { user_id: userId, credit_type: "quick_check", amount: -1, reason: "quick_check_reserved" },
      { user_id: userId, credit_type: "quick_check", amount: 1, reason: "quick_check_refunded_infra_error" },
    ]);
    return twiml("That check couldn't be completed. Please try again from the app.");
  }

  const normalizedClaim = normalizeClaim(bodyText);

  const { data: verification, error: insertError } = await admin
    .from("verifications")
    .insert({
      user_id: userId,
      input_type: linkedRow.input_type,
      claim_text: bodyText,
      normalized_claim: normalizedClaim,
      verdict: result.verdict,
      confidence: result.confidence,
      summary: result.summary,
      key_evidence: result.key_evidence,
      sources: result.sources,
      engine_version: result.engine_version,
      credit_charged: true,
    })
    .select()
    .single();

  if (insertError || !verification) {
    console.error("[whatsapp/webhook] verifications insert failed:", insertError);
    return twiml("That check ran but couldn't be saved. Please try again from the app.");
  }

  const { error: txnError } = await admin.from("credit_transactions").insert({
    user_id: userId,
    credit_type: "quick_check",
    amount: -1,
    reason: "quick_check_completed",
    verification_id: verification.id,
  });
  if (txnError) {
    console.error("[whatsapp/webhook] credit_transactions insert failed:", txnError);
  }

  const { error: consumeError } = await admin
    .from("whatsapp_link_codes")
    .update({ consumed_at: nowIso, verification_id: verification.id })
    .eq("id", linkedRow.id);
  if (consumeError) {
    console.error("[whatsapp/webhook] failed to mark code consumed:", consumeError);
  }

  // No result reply — see the file header for why.
  return twiml();
}
