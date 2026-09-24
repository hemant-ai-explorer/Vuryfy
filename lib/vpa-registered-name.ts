// Real VPA (UPI ID) → registered bank account holder name lookup —
// scaffolded Sept 23, 2026, at the user's explicit request ("i want to
// show who it really registered to").
//
// This answers a genuinely different question from everything else this
// codebase already checks for a payment QR: not "does this name/UPI ID
// have any public reputation" (lib/quick-check.ts via app/api/verify-payee
// and app/api/deep-payee — an evidence-grounded web search), and not "does
// this name look like one already in the user's own scan history"
// (lib/payee-similarity.ts's findSimilarPayee — a free, deterministic
// comparison against payment_payees_seen). Neither of those can say who
// actually controls a UPI handle. This is the same "Verified Name" check
// every UPI app (GPay, PhonePe, Paytm) shows before you confirm a
// payment — a live call into the NPCI/bank network itself, the only real
// source of truth for VPA ownership.
//
// That access is NOT free and NOT obtainable without a paid, licensed
// integration — this cannot be built as a plain web search or a client-
// side check the way everything else in this file's neighbors is. Real
// options researched (Sept 23, 2026): Eko (eps.eko.in — ₹1.44/lookup
// ex-GST, self-serve sign-up with OTP, sandbox instant, production needs
// basic KYC + a prepaid wallet — the fastest realistic path to test this
// for real), Cashfree's Secure ID / Verify UPI (no public per-call price,
// self-serve signup + free trial, contact sales for production terms),
// Decentro (basic valid/invalid vs. advanced holder-name/IFSC/MCC tiers,
// no public pricing), or becoming an NPCI-certified TPAP directly via a
// sponsor bank (RazorpayX's Validate VPA API works this way — heavy,
// requires an actual current-account banking relationship, not realistic
// as a quick add-on).
//
// Cost/credit design (user's explicit decision, Sept 23, 2026 — revised
// same day after the first version of this design, which charged the
// plain 1-credit rate, turned out to let a Starter user spend their whole
// 30-Quick-Check monthly allowance on this ~₹1.70/lookup path for
// ~₹50-75/month against a ₹99 plan): still no separate button or API
// route, but a two-tier charge instead of one flat rate —
//   - Deep Investigation (app/api/deep-payee/route.ts) bundles this in
//     automatically, unconditionally, at no extra credit cost. Safe
//     because DI's allowance is small (2-5/month), so the worst case
//     stays under ₹10/month even fully loaded.
//   - Quick Check (app/api/verify-payee/route.ts) only runs this when the
//     caller explicitly opts in via `include_registered_name: true`, and
//     that opt-in costs 2 Quick Check credits instead of 1 (see
//     decrement_quick_check's p_amount param, migration
//     0020_registered_name_credit_amount.sql). This halves the Quick
//     Check worst case (max 15 such checks/month on Starter instead of
//     30). An ordinary payee Quick Check (no opt-in) is unaffected.
//
// ============================================================================
// WIRED IN — Sept 24, 2026. Eko issued live production credentials for
// their Connected Banking / UPI ID Verification API. Two honest, by-design
// limitations (not bugs — this file still never fabricates a result):
//
// 1. Eko's endpoint validates a (VPA, mobile number) PAIR — recipient_
//    mobile is a required input, not just an output. Vuryfy's actual data
//    (a scanned payment QR) only ever supplies a UPI ID and a claimed
//    name, never a phone number. Where the VPA's own local-part (before
//    the "@") is itself a 10-digit Indian mobile number — true for most
//    personal UPI handles, e.g. "98765xxxxx@ybl" — that number doubles as
//    recipient_mobile. For merchant-style handles (e.g. "amazon@icici",
//    "flipkart.rzp@icici") there is no phone number anywhere in the
//    input, so this reports { available: false } rather than guessing or
//    fabricating one. In practice: this real-name check currently only
//    resolves for personal-handle VPAs, not merchant ones — worth knowing
//    when judging how often it'll actually show something on the result
//    page.
// 2. Field/endpoint names below come from Eko's public docs pages
//    (eps.eko.in/docs/upi-validate-vpa, developers.eko.in/reference/dwqd),
//    not a logged-in view of the developer portal, and are UNVERIFIED
//    against a real live response. Eko's own onboarding email recommends
//    testing via Postman first and sharing the raw response if anything
//    errors — treat the first real call in production as that smoke test.
//    If the response shape differs from what's parsed below, only this
//    file needs to change.
//
// Required env vars (Vercel project settings — never committed to git):
// EKO_DEVELOPER_KEY, EKO_INITIATOR_ID, EKO_ACCESS_KEY (Eko's
// "Authenticator Key" — used to derive the per-request secret-key, never
// sent as-is). Optional: EKO_USER_CODE (Eko's "retailer user code" — leave
// unset unless Eko support says this account needs it), EKO_BASE_URL
// (defaults to the production base URL Eko issued), EKO_LATLONG (defaults
// to Vuryfy's registered business location in Gomti Nagar, Lucknow — the
// API requires geo-coordinates of the request origin and there is no
// end-user location available server-side for this lookup).
//
// Caching: as flagged when this was first scaffolded, a registered name
// essentially never changes, so results are cached by UPI ID in the new
// vpa_registered_name_cache table (see supabase/migrations/
// 0021_vpa_registered_name_cache.sql) with a 90-day TTL, checked before
// any billed Eko call. This is why verifyRegisteredName() now takes an
// `admin` client as its first argument — the one call-site change beyond
// this file (app/api/verify-payee/route.ts and app/api/deep-payee/
// route.ts each already have `admin` in scope; both just pass it through).

import type { SupabaseClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { nameSimilarity } from "@/lib/payee-similarity";

export type RegisteredNameResult =
  | { available: false }
  | { available: true; registeredName: string; matchesClaimedName: boolean };

const EKO_VPA_VALIDATE_PATH = "/v3/customer/payment/upi/validate-vpa";
const DEFAULT_EKO_BASE_URL = "https://api.eko.in:25002/ekoicici";
// Vuryfy's registered business location (Gomti Nagar, Lucknow) — used as
// the request-origin latlong Eko's API requires, since there is no
// end-user geolocation available server-side for this lookup.
const DEFAULT_LATLONG = "26.8500,80.9970";

const CACHE_TABLE = "vpa_registered_name_cache";
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days — see file header.

// Same 0.82 threshold lib/payee-similarity.ts's own callers use for "these
// two names are the same, allowing for minor spelling/formatting drift."
const MATCH_THRESHOLD = 0.82;

let warnedMissingConfigOnce = false;

// A VPA's local-part (before "@") that is itself a 10-digit Indian mobile
// number — true for most personal UPI handles, false for merchant-style
// handles. See file header, limitation 1.
function extractMobileFromVpa(upiId: string): string | null {
  const localPart = upiId.split("@")[0]?.trim() ?? "";
  return /^[6-9]\d{9}$/.test(localPart) ? localPart : null;
}

function computeSecretKey(accessKey: string, timestampMs: string): string {
  // Per Eko's auth guide: base64-encode the access key and use THAT
  // encoded string (not the raw key) as the HMAC key, signing the
  // timestamp as the message.
  const encodedKey = Buffer.from(accessKey).toString("base64");
  return crypto.createHmac("sha256", encodedKey).update(timestampMs).digest("base64");
}

async function getCachedRegisteredName(admin: SupabaseClient, upiId: string): Promise<string | null> {
  const { data, error } = await admin
    .from(CACHE_TABLE)
    .select("registered_name, fetched_at")
    .eq("upi_id", upiId)
    .maybeSingle();

  if (error || !data) return null;
  const age = Date.now() - new Date(data.fetched_at).getTime();
  if (age > CACHE_TTL_MS) return null; // stale — treat as a miss, re-fetch below.
  return data.registered_name;
}

async function writeCachedRegisteredName(admin: SupabaseClient, upiId: string, registeredName: string): Promise<void> {
  const { error } = await admin
    .from(CACHE_TABLE)
    .upsert({ upi_id: upiId, registered_name: registeredName, fetched_at: new Date().toISOString() });
  if (error) {
    // Never let a cache-write failure block returning the real result —
    // it just means the next lookup of this UPI ID re-fetches (and
    // re-bills) instead of hitting cache. Log loudly since repeated
    // misses here quietly cost real money.
    console.error("[vpa-registered-name] failed to write cache row (next lookup will re-fetch):", error);
  }
}

// The real Eko call. Returns the registered name, or null if the lookup
// is genuinely unavailable (missing config, no derivable mobile number,
// API error, invalid VPA) — never fabricated. See file header for the
// full rationale on both limitations.
async function fetchFromEko(upiId: string, claimedName: string): Promise<string | null> {
  const developerKey = process.env.EKO_DEVELOPER_KEY;
  const initiatorId = process.env.EKO_INITIATOR_ID;
  const accessKey = process.env.EKO_ACCESS_KEY;

  if (!developerKey || !initiatorId || !accessKey) {
    if (!warnedMissingConfigOnce) {
      warnedMissingConfigOnce = true;
      console.error(
        "[vpa-registered-name] EKO_DEVELOPER_KEY/EKO_INITIATOR_ID/EKO_ACCESS_KEY not configured — " +
          "reporting unavailable for every lookup until set in Vercel env vars."
      );
    }
    return null;
  }

  const recipientMobile = extractMobileFromVpa(upiId);
  if (!recipientMobile) {
    // Merchant-style VPA — no phone number anywhere in the input. See
    // file header, limitation 1. Not an error; just not answerable today.
    return null;
  }

  const baseUrl = process.env.EKO_BASE_URL || DEFAULT_EKO_BASE_URL;
  const latlong = process.env.EKO_LATLONG || DEFAULT_LATLONG;
  const timestampMs = Date.now().toString();
  const secretKey = computeSecretKey(accessKey, timestampMs);

  const payload: Record<string, string> = {
    initiator_id: initiatorId,
    client_ref_id: crypto.randomUUID(),
    customer_vpa: upiId,
    recipient_mobile: recipientMobile,
    name: claimedName || upiId,
    latlong,
  };
  if (process.env.EKO_USER_CODE) {
    payload.user_code = process.env.EKO_USER_CODE;
  }

  try {
    const response = await fetch(`${baseUrl}${EKO_VPA_VALIDATE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        developer_key: developerKey,
        "secret-key": secretKey,
        "secret-key-timestamp": timestampMs,
      },
      body: JSON.stringify(payload),
    });

    const json = await response.json().catch(() => null);

    if (!response.ok) {
      console.error(
        `[vpa-registered-name] Eko API returned ${response.status} — reporting unavailable. body=${JSON.stringify(json)}`
      );
      return null;
    }

    const registeredName: string | undefined = json?.data?.recipient_name;
    const isValid: boolean | undefined = json?.data?.valid;

    if (!registeredName || isValid === false) {
      return null;
    }
    return registeredName;
  } catch (err) {
    console.error("[vpa-registered-name] Eko API call failed — reporting unavailable:", err);
    return null;
  }
}

export async function verifyRegisteredName(
  admin: SupabaseClient,
  upiId: string,
  claimedName: string
): Promise<RegisteredNameResult> {
  const normalizedUpiId = upiId.trim().toLowerCase();
  if (!normalizedUpiId) return { available: false };

  let registeredName = await getCachedRegisteredName(admin, normalizedUpiId);
  if (!registeredName) {
    registeredName = await fetchFromEko(normalizedUpiId, claimedName);
    if (!registeredName) return { available: false };
    await writeCachedRegisteredName(admin, normalizedUpiId, registeredName);
  }

  const matchesClaimedName =
    !!claimedName.trim() && nameSimilarity(claimedName, registeredName) >= MATCH_THRESHOLD;

  return { available: true, registeredName, matchesClaimedName };
}
