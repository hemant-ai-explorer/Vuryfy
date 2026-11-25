import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getOrCreateRazorpayPlanId, createRazorpaySubscription } from "@/lib/razorpay";

// Billing engine, Phase 1b — Nov 25, 2026. See
// claude/billing-engine-scoping-2026-11-24.md in the Vuryfy project for the
// full design. Called when a gated user (lib/billing-gate.ts has already
// marked their subscription payment_required = true) clicks "Subscribe" on
// app/billing/page.tsx. Creates a real Razorpay Subscription object and
// hands its id back to the frontend, which opens Razorpay's Standard
// Checkout modal keyed to that subscription_id.
//
// This route never marks anything paid — see lib/razorpay.ts's
// verifyCheckoutSignature comment for why only
// app/api/webhooks/razorpay/route.ts is allowed to do that.

export async function POST() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const admin = createAdminClient();

  const { data: subscription, error: subError } = await admin
    .from("subscriptions")
    .select("id, plan_code")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  if (subError || !subscription) {
    console.error("[create-subscription] no active subscription row:", subError);
    return NextResponse.json({ error: "No active subscription found for your account." }, { status: 400 });
  }

  const { data: plan, error: planError } = await admin
    .from("plans")
    .select("code, display_name, price_inr, is_active, razorpay_plan_id")
    .eq("code", subscription.plan_code)
    .maybeSingle();

  if (planError || !plan || !plan.is_active) {
    return NextResponse.json({ error: "Your plan is no longer available." }, { status: 400 });
  }

  let razorpaySubscriptionId: string;
  try {
    const razorpayPlanId = await getOrCreateRazorpayPlanId(admin, plan);
    razorpaySubscriptionId = await createRazorpaySubscription({
      razorpayPlanId,
      userId: user.id,
      planCode: plan.code,
    });
  } catch (err) {
    console.error("[create-subscription] Razorpay call failed:", err);
    return NextResponse.json({ error: "Could not start checkout. Please try again." }, { status: 500 });
  }

  const { error: updateError } = await admin
    .from("subscriptions")
    .update({ gateway: "razorpay", gateway_subscription_id: razorpaySubscriptionId })
    .eq("id", subscription.id);

  if (updateError) {
    // Not fatal to the checkout itself — the webhook handler looks up the
    // subscription row by gateway_subscription_id, so if this write
    // somehow failed, log loudly and still let the user try to pay; worth
    // a manual fix-up if this is ever actually hit.
    console.error("[create-subscription] failed to save gateway_subscription_id:", updateError);
  }

  await admin.from("payments").insert({
    user_id: user.id,
    subscription_id: subscription.id,
    gateway: "razorpay",
    gateway_event: "subscription.created",
    status: "created",
    raw_payload: { razorpay_subscription_id: razorpaySubscriptionId },
  });

  return NextResponse.json({
    razorpay_subscription_id: razorpaySubscriptionId,
    razorpay_key_id: process.env.RAZORPAY_KEY_ID,
    display_name: plan.display_name,
    price_inr: plan.price_inr,
  });
}
