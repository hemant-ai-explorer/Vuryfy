import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

// Billing engine, Phase 1b — Nov 25, 2026. See
// claude/billing-engine-scoping-2026-11-24.md in the Vuryfy project for the
// full design (Phase 1a shipped the free-intro-month paywall gate; this is
// the real Razorpay wiring lib/billing-gate.ts's header comment flagged as
// "that's Phase 1b, once real Razorpay keys exist").
//
// Hand-rolled fetch calls against Razorpay's REST API, same "no SDK
// dependency for a handful of HTTP calls" reasoning as lib/whatsapp.ts's
// Twilio integration (see that file's verifyTwilioSignature comment) —
// avoids adding the `razorpay` npm package for what is, in total, two
// endpoints (create a Plan, create a Subscription) plus two HMAC checks.
//
// IMPORTANT ARCHITECTURE NOTE: Vuryfy's ₹99/month plan needs to charge
// automatically every month, so this uses Razorpay's SUBSCRIPTIONS API
// (Plan + Subscription objects, recurring billing, webhook-driven) rather
// than the Orders API ("Standard Checkout" one-time payment). A Razorpay
// Plan's amount is immutable once created — repricing an existing Vuryfy
// plan later means creating a NEW Razorpay Plan (null out a plans row's
// razorpay_plan_id so getOrCreateRazorpayPlanId() below creates a fresh one
// at the new price), not editing the old one. Existing subscribers stay on
// their original Razorpay Plan/price until individually migrated — this is
// a Razorpay platform constraint, not a Vuryfy design choice.

const RAZORPAY_API_BASE = "https://api.razorpay.com/v1";

function authHeader(): string {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET not configured.");
  }
  return "Basic " + Buffer.from(`${keyId}:${keySecret}`).toString("base64");
}

async function razorpayPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${RAZORPAY_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Razorpay API error ${res.status} on ${path}: ${text.slice(0, 500)}`);
  }
  return JSON.parse(text) as T;
}

interface RazorpayPlan {
  id: string;
}

export async function createRazorpayPlan(params: {
  planCode: string;
  displayName: string;
  priceInr: number;
}): Promise<string> {
  const plan = await razorpayPost<RazorpayPlan>("/plans", {
    period: "monthly",
    interval: 1,
    item: {
      name: `Vuryfy ${params.displayName}`,
      amount: params.priceInr * 100, // Razorpay amounts are always in paise
      currency: "INR",
    },
    notes: { vuryfy_plan_code: params.planCode },
  });
  return plan.id;
}

interface RazorpaySubscription {
  id: string;
}

// total_count is mandatory on Razorpay's Subscriptions API — there's no
// "unlimited" option. 1200 monthly cycles (100 years) is the usual
// workaround to approximate an indefinite subscription. Real cancellation
// is meant to happen via DELETE /v1/subscriptions/:id, which is NOT yet
// wired up anywhere in this app (public.subscriptions.cancel_at_period_end
// already exists as a column from 0001_init.sql but nothing calls Razorpay
// when it's set) — flagged as a "not yet done" open item, not silently
// skipped.
const INDEFINITE_TOTAL_COUNT = 1200;

export async function createRazorpaySubscription(params: {
  razorpayPlanId: string;
  userId: string;
  planCode: string;
}): Promise<string> {
  const sub = await razorpayPost<RazorpaySubscription>("/subscriptions", {
    plan_id: params.razorpayPlanId,
    customer_notify: 1,
    total_count: INDEFINITE_TOTAL_COUNT,
    notes: { vuryfy_user_id: params.userId, vuryfy_plan_code: params.planCode },
  });
  return sub.id;
}

// Client-side (Standard Checkout) signature check — Razorpay's documented
// algorithm for a SUBSCRIPTION checkout response is HMAC-SHA256(payment_id
// + "|" + subscription_id), a different field order from the Orders-API
// version most generic tutorials describe (order_id + "|" + payment_id).
// This confirms the checkout popup's response is genuine (not forged
// client-side) for fast UI feedback only — per this project's locked
// "AI/billing logic is decided by deterministic backend code only"
// principle (architecture-decisions.md, Part 19) and the explicit decision
// in claude/billing-engine-scoping-2026-11-24.md, this function must NEVER
// be the thing that marks a subscription paid/active. Only
// app/api/webhooks/razorpay/route.ts (a server-to-server call Razorpay
// itself signs, which a browser can't forge) is allowed to do that.
export function verifyCheckoutSignature(params: {
  razorpayPaymentId: string;
  razorpaySubscriptionId: string;
  razorpaySignature: string;
}): boolean {
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) return false;

  const payload = `${params.razorpayPaymentId}|${params.razorpaySubscriptionId}`;
  const expected = crypto.createHmac("sha256", keySecret).update(payload).digest("hex");

  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(params.razorpaySignature);
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

// Webhook signature check — a DIFFERENT secret from the one above, set
// separately in the Razorpay Dashboard when the webhook URL is configured
// (Settings → Webhooks), given to this app as RAZORPAY_WEBHOOK_SECRET.
// Algorithm: HMAC-SHA256(raw request body, webhook secret) — must be
// computed over the exact raw bytes Razorpay sent, before any JSON.parse,
// or a byte-for-byte-insignificant difference (key order, whitespace)
// breaks the check. See app/api/webhooks/razorpay/route.ts for why this is
// the only place allowed to flip a subscription to paid/active.
export function verifyWebhookSignature(rawBody: string, signature: string | null): boolean {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!webhookSecret || !signature) return false;

  const expected = crypto.createHmac("sha256", webhookSecret).update(rawBody).digest("hex");

  const expectedBuf = Buffer.from(expected);
  const signatureBuf = Buffer.from(signature);
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

// Looks up the cached Razorpay Plan id for a Vuryfy plan row, creating one
// on first use — no manual bootstrap step needed before launch. See the
// architecture note at the top of this file for why a reprice needs a
// fresh Razorpay Plan id rather than an edit.
export async function getOrCreateRazorpayPlanId(
  admin: SupabaseClient,
  plan: { code: string; display_name: string; price_inr: number; razorpay_plan_id: string | null }
): Promise<string> {
  if (plan.razorpay_plan_id) return plan.razorpay_plan_id;

  const razorpayPlanId = await createRazorpayPlan({
    planCode: plan.code,
    displayName: plan.display_name,
    priceInr: plan.price_inr,
  });

  const { error } = await admin.from("plans").update({ razorpay_plan_id: razorpayPlanId }).eq("code", plan.code);
  if (error) {
    // Non-fatal — worst case this creates a second, unused Razorpay Plan
    // object at the same price on a later uncached call, which is harmless
    // (no billing impact), not a failure to surface to the user. Logged so
    // it's still visible and fixable.
    console.error("[razorpay] failed to cache razorpay_plan_id on plans row:", error);
  }

  return razorpayPlanId;
}
