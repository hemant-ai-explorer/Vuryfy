import type { SupabaseClient } from "@supabase/supabase-js";

// Billing engine, Phase 1a — Nov 24, 2026. See
// claude/billing-engine-scoping-2026-11-24.md in the Vuryfy project for the
// full design. Correction #2 (marketing-site-2026-09-19.md) locked two
// triggers for first asking a user to pay: their 6th Quick Check, their 1st
// Deep Investigation, or the start of their second month — whichever comes
// first. The first two are detected right here, at the exact moment the
// existing decrement_quick_check()/decrement_deep_investigation() RPCs
// (0001_init.sql / 0003_deep_investigation.sql) report zero credits
// remaining during a user's intro month. The third, time-based trigger is
// handled separately by the daily cron job in
// app/api/cron/billing-trigger/route.ts, since it isn't tied to any single
// request.
//
// Phase 1a ships the "gate the request" design (block before the pipeline
// runs), not the better-converting "gate the result" design (let it run,
// show the result, then ask for payment) that Correction #2 names as the
// preferred-but-unbuilt mitigation. See the scoping doc's "Open decision
// #1" for the reasoning — upgrading to that is Phase 2, once there's real
// trigger-to-payment funnel data to justify the extra build.
//
// This module only ever marks a subscription payment_required = true. It
// never talks to a payment gateway — that's Phase 1b, once real Razorpay
// keys exist.

export type GateCheckResult =
  | { status: "payment_required"; trigger: "quick_check_6" | "deep_investigation_1" }
  | { status: "allowance_exhausted" };

/**
 * Call this immediately after decrement_quick_check / decrement_deep_investigation
 * returns null (the user has zero of that credit type remaining). Decides
 * whether this is a genuine first-time billing trigger (still in the intro
 * month, not yet gated) or a different, non-billing situation — a
 * post-payment user who's used up a later month's allowance, or a user with
 * no active subscription row at all (e.g. already canceled). Those existing
 * "you're out of credits, upgrade" / "allowance exhausted" cases are
 * unchanged by this function; it only ever adds the new payment_required
 * branch on top.
 */
export async function checkBillingGate(
  admin: SupabaseClient,
  userId: string,
  trigger: "quick_check_6" | "deep_investigation_1"
): Promise<GateCheckResult> {
  const { data: subscription, error } = await admin
    .from("subscriptions")
    .select("id, is_intro_month, payment_required")
    .eq("user_id", userId)
    .eq("status", "active")
    .maybeSingle();

  if (error || !subscription) {
    console.error("[billing-gate] subscription lookup failed or missing:", error);
    return { status: "allowance_exhausted" };
  }

  if (!subscription.is_intro_month) {
    // Already past the intro month: either already paying (this cycle's
    // allowance just ran out — wait for renewal) or already past_due from
    // an earlier failed charge. Either way, not a NEW trigger.
    return { status: "allowance_exhausted" };
  }

  if (subscription.payment_required) {
    // Already gated from an earlier attempt this intro month — same
    // trigger, not a new one. No new write needed; idempotent.
    return { status: "payment_required", trigger };
  }

  // First time hitting zero credits during the intro month — this IS the
  // trigger moment. A rare concurrent double-write here is harmless (both
  // writes set the same values), so no extra locking beyond what the
  // decrement RPC itself already guarantees.
  const { error: updateError } = await admin
    .from("subscriptions")
    .update({
      payment_required: true,
      last_trigger: trigger,
      last_trigger_at: new Date().toISOString(),
    })
    .eq("id", subscription.id);

  if (updateError) {
    console.error("[billing-gate] failed to mark payment_required:", updateError);
    // Fail toward NOT blocking a real user over our own write failure — the
    // next attempt will retry marking the trigger.
    return { status: "allowance_exhausted" };
  }

  return { status: "payment_required", trigger };
}
