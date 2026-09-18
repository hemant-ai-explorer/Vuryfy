import { NextResponse } from "next/server";
import crypto from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { normalizeWhatsAppPhone, verifyTwilioSignature, downloadTwilioMedia } from "@/lib/whatsapp";

// Twilio's inbound-message webhook — WhatsApp media-first flow (Part 13
// rework, Sept 18, 2026). Twilio calls this directly with no Vuryfy
// session or cookie, so identity comes entirely from matching the
// message's content and sender against a whatsapp_link_codes row, never
// from Supabase auth — every DB access here uses the admin (service_role)
// client. Twilio request signature validation (lib/whatsapp.ts) confirms
// the request actually came from Twilio and wasn't forged by someone who
// discovered this URL.
//
// This route now does two things only: (1) link a phone to an account via
// a one-time code, or (2) capture whatever the linked phone forwards next
// — text/a link, or a photo — into whatsapp_submissions, and reply with a
// short "open the app" acknowledgement. It NEVER runs a Quick Check, never
// touches credits, and never writes to `verifications` — that all happens
// afterward through the app's normal /api/verify or /api/verify-image
// routes, once the user opens the pending submission and picks Quick
// Check or Deep Investigation themselves, exactly like any other
// submission. See supabase/migrations/0017_whatsapp_submissions.sql.
//
// A linked phone is no longer single-use: LINK_SESSION_HOURS below is how
// long a link stays usable after the user sends their code, so several
// items can be forwarded before they return to the app. Audio and video
// forwards are acknowledged as "not supported yet" — same scoped-build
// pattern used throughout this project (QR -> image -> audio/video; EN+HI
// -> remaining languages) rather than building all four media types in
// one pass.
export const maxDuration = 60;

const MIN_CLAIM_LENGTH = 5;
const LINK_SESSION_HOURS = 24;
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

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
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const signature = request.headers.get("x-twilio-signature");
  if (!authToken || !accountSid) {
    console.error("[whatsapp/webhook] TWILIO_AUTH_TOKEN / TWILIO_ACCOUNT_SID not set — refusing all requests");
    return new NextResponse("Not configured", { status: 500 });
  }
  if (!verifyTwilioSignature(authToken, request.url, paramsObj, signature)) {
    console.error("[whatsapp/webhook] signature validation failed");
    return new NextResponse("Invalid signature", { status: 403 });
  }

  const from = paramsObj["From"] || "";
  const bodyText = (paramsObj["Body"] || "").trim();
  const numMedia = parseInt(paramsObj["NumMedia"] || "0", 10);
  const mediaUrl = paramsObj["MediaUrl0"] || "";
  const mediaContentType = paramsObj["MediaContentType0"] || "";
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
      const newExpiry = new Date(Date.now() + LINK_SESSION_HOURS * 60 * 60 * 1000).toISOString();
      const { error: linkError } = await admin
        .from("whatsapp_link_codes")
        .update({ phone_number: phone, linked_at: nowIso, expires_at: newExpiry })
        .eq("id", codeRow.id);

      if (linkError) {
        console.error("[whatsapp/webhook] failed to link code:", linkError);
        return twiml("Something went wrong linking your Vuryfy account. Please try again from the app.");
      }

      return twiml(
        "You're connected to Vuryfy. Forward text, a link, or a photo and we'll open it in the app for you to check."
      );
    }
  }

  // Step 2: is this phone currently within an active link session? If so,
  // THIS message is a new submission to capture.
  const { data: linkedRow } = await admin
    .from("whatsapp_link_codes")
    .select("id, user_id")
    .eq("phone_number", phone)
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

  const userId = linkedRow.user_id;

  if (numMedia > 0) {
    const ext = ALLOWED_IMAGE_TYPES[mediaContentType];
    if (!ext) {
      return twiml(
        "Only photos are supported over WhatsApp right now — audio and video aren't yet. Please use the Vuryfy app for those."
      );
    }
    if (!mediaUrl) {
      return twiml("That photo couldn't be read. Please try forwarding it again.");
    }

    let bytes: ArrayBuffer;
    try {
      const downloaded = await downloadTwilioMedia(mediaUrl, accountSid, authToken);
      bytes = downloaded.bytes;
    } catch (err) {
      console.error("[whatsapp/webhook] media download failed:", err);
      return twiml("That photo couldn't be downloaded. Please try forwarding it again.");
    }

    const storagePath = `${userId}/${crypto.randomUUID()}.${ext}`;
    const { error: uploadError } = await admin.storage
      .from("temp-whatsapp-uploads")
      .upload(storagePath, Buffer.from(bytes), { contentType: mediaContentType, upsert: false });

    if (uploadError) {
      console.error("[whatsapp/webhook] storage upload failed:", uploadError);
      return twiml("That photo couldn't be saved. Please try again from the app.");
    }

    const { error: insertError } = await admin.from("whatsapp_submissions").insert({
      user_id: userId,
      phone_number: phone,
      input_type: "image",
      storage_path: storagePath,
      mime_type: mediaContentType,
    });

    if (insertError) {
      console.error("[whatsapp/webhook] whatsapp_submissions insert failed (image):", insertError);
      await admin.storage.from("temp-whatsapp-uploads").remove([storagePath]);
      return twiml("That photo couldn't be saved. Please try again from the app.");
    }

    return twiml("Got it — open the Vuryfy app to continue checking your photo.");
  }

  if (bodyText.length < MIN_CLAIM_LENGTH) {
    return twiml("That message is too short to check. Please send a longer claim, link, or a photo.");
  }

  const { error: insertError } = await admin.from("whatsapp_submissions").insert({
    user_id: userId,
    phone_number: phone,
    input_type: "text",
    claim_text: bodyText,
  });

  if (insertError) {
    console.error("[whatsapp/webhook] whatsapp_submissions insert failed (text):", insertError);
    return twiml("That couldn't be saved. Please try again from the app.");
  }

  return twiml("Got it — open the Vuryfy app to continue checking your claim.");
}
