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
// as a quick add-on). None of these credentials exist yet.
//
// Ships as an explicit, loudly-documented stub — same pattern as
// lib/content-safety.ts's scanContentHash(): it must never be mistaken for
// a working check, so it always reports "unavailable" rather than
// guessing or faking a result. The ONE function to replace once real
// credentials exist is verifyRegisteredName() itself, below — nothing
// else needs to change: the calling routes (app/api/verify-payee/
// route.ts, app/api/deep-payee/route.ts) and the result page (app/result/
// page.tsx's payee_reputation branch) already handle both the
// "unavailable" and the real "available" shape correctly.
//
// Cost/credit design (user's explicit decision, Sept 23, 2026 — revised
// same day after the first version of this design, which charged the
// plain 1-credit rate, turned out to let a Starter user spend their whole
// 30-Quick-Check monthly allowance on this ~₹1.70/lookup path for
// ~₹50-75/month against a ₹99 plan): still no separate button or API
// route, but now a two-tier charge instead of one flat rate —
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
// Unlike the reputation search's result, this is NOT cached via
// lib/verification-cache.ts — when a real provider is wired in, add
// UPI-ID-keyed caching here directly (a registered name essentially never
// changes, so a long TTL, e.g. 90+ days, is safe and would cut real spend
// further on top of the two-tier gating above, especially for frequently-
// rescanned payees like popular merchants).

export type RegisteredNameResult =
  | { available: false }
  | { available: true; registeredName: string; matchesClaimedName: boolean };

export async function verifyRegisteredName(
  upiId: string,
  claimedName: string
): Promise<RegisteredNameResult> {
  // STUB — no provider credentials configured. Replace this entire
  // function body with a real call (e.g. Eko's UPI ID Verification API)
  // once credentials exist (read from an env var, e.g.
  // VPA_VERIFICATION_API_KEY — not yet defined anywhere). Until then,
  // always report unavailable; never fabricate a registered name.
  void upiId;
  void claimedName;
  return { available: false };
}
