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
// ============================================================================
// PROVIDER SWITCH: Eko -> Decentro — Sept 25, 2026.
//
// First wired up Sept 24, 2026 against Eko's Connected Banking / UPI ID
// Verification API. Eko turned out to have a real, blocking limitation:
// its endpoint validates a (VPA, mobile number) PAIR — recipient_mobile is
// a REQUIRED input, not just an output — and Vuryfy's actual data (a
// scanned payment QR) only ever supplies a UPI ID, never a phone number.
// Eko could only resolve personal-handle VPAs where the local part
// (before "@") happens to itself be a 10-digit mobile number
// ("98765xxxxx@ybl") — every merchant-style handle ("amazon@icici",
// "flipkart.rzp@icici") came back { available: false }, which is most of
// what a real user actually wants checked. User's call, Sept 25, 2026:
// drop Eko entirely, switch to Decentro's VerifyPay (V3) as the sole
// provider — its request body takes only upi_vpa, no phone number
// required, so it resolves personal AND merchant VPAs alike.
//
// The real cost of that fix: Decentro's VerifyPay does NOT do a passive
// lookup — per their docs, "Decentro will perform a penny drop (INR 1.00)
// or a paisa drop (INR 0.01) as part of the validation process" on EVERY
// call. This is a genuine, real money transfer into the payee's bank
// account (from Vuryfy's Decentro settlement account), not just an API
// read. Explicitly discussed with the user (Sept 25, 2026): this stays
// invisible to the end user exactly like the Eko check was — no new
// disclosure UI, same silent bundled-in-DI / 2-credit-opt-in-in-QC cost
// design already locked in (see 0023_registered_name_credit_amount.sql).
// The end user experiences this exactly as "checking a name"; the real
// fund movement happens behind that, funded from Vuryfy's own settlement
// balance with Decentro. This mirrors how every mainstream UPI app (GPay,
// PhonePe) already resolves a "Verified Name" the same way behind the
// scenes before a payment — Vuryfy isn't introducing a new pattern here.
//
// Rate limits (Decentro's own, not something this code needs to enforce
// itself): 3/min, 4/hour, 5/day, scoped to the mobile number Decentro
// resolves as tied to the VPA being checked (not per Vuryfy user, and not
// something this code supplies as an input) — a single popular payee
// could hit that cap after enough distinct Vuryfy users check it in one
// day. Handled the same way as every other failure mode here: a 4xx/5xx
// or unexpected response just returns null (available: false) rather than
// surfacing an error, so hitting this limit degrades to "unavailable,"
// never a broken check.
//
// Field names below come from Decentro's public docs page
// (docs.decentro.tech/reference/verifypay-V3), not a logged-in view of
// the developer portal or a real captured response — same "unverified
// against a real live response" caveat the Eko version carried. Treat the
// first real staging call as a smoke test; if parsing comes back empty
// when the raw response clearly has data in it, only this file needs to
// change. `vpa_status`/`name_match_score`/`name_match_status` are present
// in Decentro's documented response shape but deliberately NOT used below
// to gate validity — their exact value semantics aren't confirmed from
// the docs scrape this was built against, so leaning on `api_status`
// plus a non-empty `account_holder_name` is the safer bar for now.
//
// KNOWN GAP: Decentro's response can come back `api_status: "PENDING"`
// with a separate GET endpoint to poll for the terminal result. That
// polling endpoint's exact path isn't confirmed from the docs scrape this
// was built against, so a PENDING response is currently treated as
// "unavailable" (returns null) rather than guessing an unverified
// endpoint — worth revisiting once a real PENDING response is seen in
// practice (Decentro's own onboarding note said staging responses aren't
// real-time, so this may show up often there and rarely in production).
//
// Required env vars (Vercel project settings — never committed to git,
// set separately for Preview/vuryfy-test and Production/vuryfy-prod since
// Decentro issues distinct staging vs. production credentials and base
// URLs): DECENTRO_CLIENT_ID, DECENTRO_CLIENT_SECRET, DECENTRO_CONSUMER_URN,
// DECENTRO_BASE_URL (e.g. https://staging.api.decentro.tech on test,
// https://api.decentro.tech on prod — no hardcoded default, since silently
// picking either one on a missing/misconfigured var risks either quietly
// no-op'ing or quietly spending real production money; missing config just
// reports unavailable, same as every other missing-config path here). The
// old EKO_* env vars are no longer read by this file and can be removed
// from Vercel once this ships.
//
// Caching: unchanged from the Eko version — a registered name essentially
// never changes, so results are cached by UPI ID in
// vpa_registered_name_cache (supabase/migrations/
// 0021_vpa_registered_name_cache.sql) with a 90-day TTL, checked before
// any billed/real-money Decentro call. This matters even more now than it
// did for Eko, since a cache hit is the difference between a free lookup
// and a real bank transfer.

import type { SupabaseClient } from "@supabase/supabase-js";
import crypto from "node:crypto";
import { nameSimilarity } from "@/lib/payee-similarity";

export type RegisteredNameResult =
  | { available: false }
  | { available: true; registeredName: string; matchesClaimedName: boolean };

const DECENTRO_VERIFY_PAY_PATH = "/v3/banking/verify_pay";

const CACHE_TABLE = "vpa_registered_name_cache";
const CACHE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days — see file header.

// Same 0.82 threshold lib/payee-similarity.ts's own callers use for "these
// two names are the same, allowing for minor spelling/formatting drift."
const MATCH_THRESHOLD = 0.82;

let warnedMissingConfigOnce = false;

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
    // Never let a cache-write failure block returning the real result — it
    // just means the next lookup of this UPI ID re-fetches (and re-bills,
    // now with a real fund transfer) instead of hitting cache. Log loudly
    // since repeated misses here quietly cost real money.
    console.error("[vpa-registered-name] failed to write cache row (next lookup will re-fetch and re-transfer):", error);
  }
}

// The real Decentro VerifyPay call. Returns the registered name, or null
// if the lookup is genuinely unavailable (missing config, API error,
// invalid VPA, unresolved PENDING) — never fabricated. See file header for
// the full rationale, including the real-money mechanics and the PENDING
// gap.
async function fetchFromDecentro(upiId: string): Promise<string | null> {
  const clientId = process.env.DECENTRO_CLIENT_ID;
  const clientSecret = process.env.DECENTRO_CLIENT_SECRET;
  const consumerUrn = process.env.DECENTRO_CONSUMER_URN;
  const baseUrl = process.env.DECENTRO_BASE_URL;

  if (!clientId || !clientSecret || !consumerUrn || !baseUrl) {
    if (!warnedMissingConfigOnce) {
      warnedMissingConfigOnce = true;
      console.error(
        "[vpa-registered-name] DECENTRO_CLIENT_ID/DECENTRO_CLIENT_SECRET/DECENTRO_CONSUMER_URN/DECENTRO_BASE_URL " +
          "not fully configured — reporting unavailable for every lookup until set in Vercel env vars."
      );
    }
    return null;
  }

  const payload = {
    consumer_urn: consumerUrn,
    is_consent_granted: true,
    // 32 lowercase-hex chars — well within the documented 2-100 char,
    // no-special-character requirement for reference_id.
    reference_id: crypto.randomBytes(16).toString("hex"),
    upi_vpa: upiId,
    purpose_message: "Vuryfy identity check",
  };

  try {
    const response = await fetch(`${baseUrl}${DECENTRO_VERIFY_PAY_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        client_id: clientId,
        client_secret: clientSecret,
      },
      body: JSON.stringify(payload),
      // A real bank-network call — give it real room, but still bounded;
      // this runs inline in a Quick Check/Deep Investigation request, not
      // a background job.
      signal: AbortSignal.timeout(15_000),
    });

    const json = await response.json().catch(() => null);

    if (!response.ok) {
      console.error(
        `[vpa-registered-name] Decentro API returned ${response.status} — reporting unavailable. body=${JSON.stringify(json)}`
      );
      return null;
    }

    if (json?.api_status === "PENDING") {
      // See file header, KNOWN GAP — polling endpoint not yet wired.
      console.error(
        "[vpa-registered-name] Decentro returned PENDING (async polling not yet implemented) — reporting unavailable for this call:",
        JSON.stringify(json)
      );
      return null;
    }

    if (json?.api_status !== "SUCCESS") {
      return null;
    }

    const registeredName: string | undefined = json?.data?.account_holder_name;
    if (!registeredName || typeof registeredName !== "string") {
      return null;
    }
    return registeredName;
  } catch (err) {
    console.error("[vpa-registered-name] Decentro API call failed — reporting unavailable:", err);
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
    registeredName = await fetchFromDecentro(normalizedUpiId);
    if (!registeredName) return { available: false };
    await writeCachedRegisteredName(admin, normalizedUpiId, registeredName);
  }

  const matchesClaimedName =
    !!claimedName.trim() && nameSimilarity(claimedName, registeredName) >= MATCH_THRESHOLD;

  return { available: true, registeredName, matchesClaimedName };
}
