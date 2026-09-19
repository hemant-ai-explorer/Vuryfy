import crypto from "crypto";

// Helpers for the WhatsApp submission flow (Part 13) — see
// supabase/migrations/0016_whatsapp_link_codes.sql and 0017_whatsapp_
// submissions.sql for the full design.

// Paused Sept 19, 2026 — user's explicit call: "stop the whatsapp feature
// for now. we will make it on when instagram and facebook connections are
// also done" (see architecture-decisions-addendum-2026-09-19.md's
// "Instagram + Facebook social connections" spec — the plan is to launch
// WhatsApp, Instagram, and Facebook connections together as a premium-tier
// feature once all three exist). This single flag gates every WhatsApp
// entry point (the link-code API, the webhook, and both UI panels) —
// flip it back to true once Instagram/Facebook are ready to ship
// alongside it. No code was removed and no data was touched; this only
// stops new links/submissions from being created while it's off.
export const WHATSAPP_FEATURE_ENABLED = false;

// Generates the one-time code shown in-app and sent as the user's first
// WhatsApp message. Avoids visually ambiguous characters (0/O, 1/I/L)
// since it's read and typed by a person, even though wa.me's pre-filled
// text usually means they never actually retype it.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

export function generateLinkCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

// Twilio sends the sender's address as "whatsapp:+919999999999" — this is
// the only place that "whatsapp:" prefix is stripped, so every other piece
// of code (the whatsapp_link_codes.phone_number column, comparisons in the
// webhook) works with a plain E.164 number.
export function normalizeWhatsAppPhone(from: string): string {
  return from.replace(/^whatsapp:/i, "").trim();
}

// Twilio request signature validation —
// https://www.twilio.com/docs/usage/webhooks/webhooks-security
//
// Implemented by hand (HMAC-SHA1 of the full webhook URL with every POST
// parameter's name+value appended, sorted by name, base64-encoded) rather
// than pulling in the `twilio` npm package for this one check — the
// algorithm is short, stable, and documented, and this project already
// avoids adding a dependency where a few dozen lines of hand-written code
// covers it (same reasoning as lib/payee-similarity.ts's hand-written
// Levenshtein distance).
export function verifyTwilioSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
  signature: string | null
): boolean {
  if (!signature) return false;

  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const expected = crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf-8")).digest("base64");

  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  // Constant-time comparison to avoid a timing side-channel; a length
  // mismatch alone is a safe, immediate "no" (timingSafeEqual throws on
  // mismatched lengths rather than returning false).
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

// Twilio media URLs (MediaUrl0, MediaUrl1, ...) require HTTP Basic Auth
// with the Account SID as username and Auth Token as password — this is
// separate from webhook signature validation above. Used when a linked
// phone forwards a photo, to pull the actual image bytes server-side
// before re-uploading them to our own temp-whatsapp-uploads bucket (see
// app/api/whatsapp/webhook/route.ts).
export async function downloadTwilioMedia(
  mediaUrl: string,
  accountSid: string,
  authToken: string
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString("base64");
  const res = await fetch(mediaUrl, { headers: { Authorization: `Basic ${auth}` } });
  if (!res.ok) {
    throw new Error(`Twilio media download failed with status ${res.status}`);
  }
  const bytes = await res.arrayBuffer();
  const contentType = res.headers.get("content-type") || "application/octet-stream";
  return { bytes, contentType };
}
