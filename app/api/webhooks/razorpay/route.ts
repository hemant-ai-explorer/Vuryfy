import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifyWebhookSignature } from "@/lib/razorpay";

// Billing engine, Phase 1b — Nov 25, 2026. See
// claude/billing-engine-scoping-2026-11-24.md in the Vuryfy project. This
// is the ONLY place that ever marks a Vuryfy subscription paid/active —
// see lib/billing-gate.ts and lib/razorpay.ts's comments for why (this
// project's locked "AI/billing logic is decided by deterministic backend
// code only" principle, applied here as "only a server-to-server call
// Razorpay itself signs can flip payment_required off").
//
// Configure this URL (https://app.vuryfy.com/api/webhooks/razorpay) in the
// Razorpay Dashboard under Settings → Webhooks, subscribed at minimum to:
// subscription.activated, subscription.charged, subscription.cancelled,
// subscription.completed, subscription.halted, payment.failed. The
// Dashboard generates a separate Webhook Secret at that point — put it in
// RAZORPAY_WEBHOOK_SECRET (NOT the same value as RAZORPAY_KEY_SECRET).
//
// NOT YET HANDLED (flagged, not silently skipped): real dunning/retry
// messaging beyond marking the row past_due on a halted subscription or a
// failed charge — same "Phase 2, once there's real data" posture as
// billing-gate.ts's "gate the result" note. Also not wired up:
// cancel_at_period_end actually calling Razorpay's DELETE
// /v1/subscriptions/:id — that column exists on public.subscriptions
// (0001_init.sql) but nothing in this codebase calls Razorpay when it's
// set yet.

const DEFAULT_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

export async function POST(request: Request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-razorpay-signature");

  if (!verifyWebhookSignature(rawBody, signature)) {
    console.error("[razorpay-webhook] signature verification failed");
    return NextResponse.json({ error: "Invalid signature." }, { status: 400 });
  }

  let payload: {
    event: string;
    payload?: {
      subscription?: { entity?: { id?: string; current_start?: number; current_end?: number } };
      payment?: { entity?: { id?: string; amount?: number } };
    };
  };
  try {
    payload = JSON.parse(rawBody);
  } catch (err) {
    console.error("[razorpay-webhook] could not parse body as JSON:", err);
    return NextResponse.json({ error: "Malformed body." }, { status: 400 });
  }

  const event = payload.event;
  const subscriptionEntity = payload.payload?.subscription?.entity;
  const paymentEntity = payload.payload?.payment?.entity;
  const gatewaySubscriptionId = subscriptionEntity?.id;

  const admin = createAdminClient();

  if (!gatewaySubscriptionId) {
    // This app only ever creates Razorpay Subscriptions (never one-off
    // Orders), so every event we care about carries a subscription entity.
    // Acknowledge anything else rather than erroring — a 4xx/5xx here makes
    // Razorpay retry the same event indefinitely.
    console.warn("[razorpay-webhook] event with no subscription entity:", event);
    return NextResponse.json({ ok: true });
  }

  const { data: subscription, error: lookupError } = await admin
    .from("subscriptions")
    .select("id, user_id, plan_code")
    .eq("gateway_subscription_id", gatewaySubscriptionId)
    .maybeSingle();

  if (lookupError || !subscription) {
    console.error("[razorpay-webhook] no matching subscription for", gatewaySubscriptionId, lookupError);
    return NextResponse.json({ ok: true }); // acknowledge anyway — nothing to retry into
  }

  await admin.from("payments").insert({
    user_id: subscription.user_id,
    subscription_id: subscription.id,
    gateway: "razorpay",
    gateway_payment_id: paymentEntity?.id ?? null,
    gateway_event: event,
    amount_inr: paymentEntity?.amount ? Math.round(paymentEntity.amount / 100) : null,
    status: event,
    raw_payload: payload,
  });

  if (event === "subscription.activated" || event === "subscription.charged") {
    const { data: plan } = await admin
      .from("plans")
      .select("monthly_quick_checks, monthly_deep_investigations")
      .eq("code", subscription.plan_code)
      .maybeSingle();

    const periodStart = subscriptionEntity?.current_start
      ? new Date(subscriptionEntity.current_start * 1000).toISOString()
      : new Date().toISOString();
    const periodEnd = subscriptionEntity?.current_end
      ? new Date(subscriptionEntity.current_end * 1000).toISOString()
      : new Date(Date.now() + DEFAULT_PERIOD_MS).toISOString();

    await admin
      .from("subscriptions")
      .update({
        status: "active",
        is_intro_month: false,
        payment_required: false,
        current_period_start: periodStart,
        current_period_end: periodEnd,
      })
      .eq("id", subscription.id);

    if (plan) {
      await admin.from("credit_balances").upsert(
        {
          user_id: subscription.user_id,
          quick_checks_remaining: plan.monthly_quick_checks,
          deep_investigations_remaining: plan.monthly_deep_investigations,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" }
      );

      const grants: { credit_type: "quick_check" | "deep_investigation"; amount: number }[] = [];
      if (plan.monthly_quick_checks > 0) grants.push({ credit_type: "quick_check", amount: plan.monthly_quick_checks });
      if (plan.monthly_deep_investigations > 0)
        grants.push({ credit_type: "deep_investigation", amount: plan.monthly_deep_investigations });

      if (grants.length > 0) {
        await admin.from("credit_transactions").insert(
          grants.map((g) => ({
            user_id: subscription.user_id,
            credit_type: g.credit_type,
            amount: g.amount,
            reason: "subscription_charged",
          }))
        );
      }
    }
  } else if (event === "subscription.cancelled" || event === "subscription.completed") {
    await admin.from("subscriptions").update({ status: "canceled" }).eq("id", subscription.id);
  } else if (event === "subscription.halted" || event === "payment.failed") {
    // Halted = Razorpay gave up retrying a failed charge. Mark past_due and
    // re-gate the account so the existing lib/billing-gate.ts /
    // app/billing/page.tsx flow takes over again — real dunning/retry
    // messaging beyond this is a Phase 2 item, not built here.
    await admin
      .from("subscriptions")
      .update({ status: "past_due", payment_required: true, last_trigger: "month_end" })
      .eq("id", subscription.id);
  }

  return NextResponse.json({ ok: true });
}
