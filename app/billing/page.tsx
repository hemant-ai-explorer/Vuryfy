"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Script from "next/script";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api-fetch";

// Billing engine — Phase 1a (Nov 24, 2026) stub REPLACED by Phase 1b's real
// Razorpay wiring (Nov 25, 2026). See
// claude/billing-engine-scoping-2026-11-24.md in the Vuryfy project. The
// "Subscribe" button below calls app/api/billing/create-subscription,
// opens Razorpay's Standard Checkout modal against the returned
// subscription_id, and on success calls app/api/billing/verify-payment for
// a fast (non-authoritative) confirmation message — the actual
// activation/credit-grant happens separately via
// app/api/webhooks/razorpay/route.ts, which can land a few seconds after
// the modal closes. This page does not wait for that; it tells the user
// payment was received and to check back, rather than pretending it knows
// the final state immediately.
//
// Known gap, not fixed in this pass: the "STARTER · ₹49/MONTH" eyebrow
// below is still a hardcoded string (same as the Phase 1a stub it
// replaces), not read from the real plan price. Updated once already
// (₹99 → ₹49, Nov 25 2026, alongside supabase/migrations/
// 0031_starter_plan_49.sql) — a live example of exactly the manual-update
// risk this comment warns about. If plans.price_inr is ever changed
// again, this label needs another manual update too until it's wired to
// a real plan-info fetch.
//
// English-only strings, same precedent as the Phase 1a stub this replaces.

type Trigger = "quick_check_6" | "deep_investigation_1" | "month_end" | null;

interface MeResponse {
  credits: { quick_checks: number; deep_investigations: number; total: number };
  subscription: {
    plan: string;
    status: string;
    payment_required: boolean;
    last_trigger: Trigger;
  } | null;
}

interface CreateSubscriptionResponse {
  razorpay_subscription_id: string;
  razorpay_key_id: string;
  display_name: string;
  price_inr: number;
}

interface RazorpayCheckoutSuccess {
  razorpay_payment_id: string;
  razorpay_subscription_id: string;
  razorpay_signature: string;
}

declare global {
  interface Window {
    Razorpay: new (options: Record<string, unknown>) => {
      open: () => void;
      on: (event: string, handler: (response: unknown) => void) => void;
    };
  }
}

const TRIGGER_COPY: Record<Exclude<Trigger, null>, { heading: string; body: string }> = {
  quick_check_6: {
    heading: "You've used your 5 free Quick Checks.",
    body: "Your first month included 5 free Quick Checks. To keep checking, subscribe to continue on the Starter plan — 30 Quick Checks + 2 Deep Investigations every month.",
  },
  deep_investigation_1: {
    heading: "Deep Investigation is a paid feature.",
    body: "Deep Investigation isn't part of the free first month. Subscribe to run this Deep Investigation and continue on the Starter plan.",
  },
  month_end: {
    heading: "Your free first month has ended.",
    body: "You didn't use a 6th Quick Check or a Deep Investigation this month, so nothing was charged — but your free month is now over. Subscribe to continue on the Starter plan.",
  },
};

export default function BillingPage() {
  return (
    <Suspense fallback={null}>
      <Script src="https://checkout.razorpay.com/v1/checkout.js" strategy="lazyOnload" />
      <BillingPageInner />
    </Suspense>
  );
}

function BillingPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = createClient();

  const [loading, setLoading] = useState(true);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState("");
  const [paying, setPaying] = useState(false);
  const [paymentReceived, setPaymentReceived] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        router.replace("/login");
        return;
      }
      apiFetch("/api/me")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setMe(d))
        .catch(() => setError("Couldn't load your account. Please try again."))
        .finally(() => setLoading(false));
    });
  }, [router, supabase]);

  if (loading) return null;

  // Trigger precedence: a trigger just carried via the redirect's query
  // param (the two request-time triggers in lib/billing-gate.ts) wins if
  // present and valid; otherwise fall back to whatever's actually stored on
  // the subscription (covers someone navigating here directly, or arriving
  // via the month-end cron trigger, which never passes a query param).
  const queryTrigger = searchParams.get("trigger");
  const trigger: Trigger =
    queryTrigger === "quick_check_6" || queryTrigger === "deep_investigation_1" || queryTrigger === "month_end"
      ? queryTrigger
      : me?.subscription?.last_trigger ?? null;

  const gated = me?.subscription?.payment_required === true;
  const copy = trigger ? TRIGGER_COPY[trigger] : null;

  async function handleSubscribe() {
    setError("");
    setPaying(true);
    try {
      const res = await apiFetch("/api/billing/create-subscription", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error ?? "Could not start checkout. Please try again.");
        setPaying(false);
        return;
      }
      const data: CreateSubscriptionResponse = await res.json();

      const rzp = new window.Razorpay({
        key: data.razorpay_key_id,
        subscription_id: data.razorpay_subscription_id,
        name: "Vuryfy",
        description: `${data.display_name} — monthly subscription`,
        theme: { color: "#2563eb" },
        handler: async (response: unknown) => {
          // Nov 25, 2026: clear any stale error from an earlier failed
          // attempt in this same checkout session (Razorpay's modal lets
          // the user retry with a different card/method after a
          // payment.failed event below) — without this, a failed-then-
          // retried-successfully flow showed "Payment received" AND the
          // old "payment didn't go through" message at the same time.
          setError("");
          const checkoutResponse = response as RazorpayCheckoutSuccess;
          try {
            const verifyRes = await apiFetch("/api/billing/verify-payment", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(checkoutResponse),
            });
            if (verifyRes.ok) {
              setPaymentReceived(true);
            } else {
              setError(
                "Payment went through, but we couldn't confirm it here. If your plan doesn't activate within a few minutes, contact support."
              );
            }
          } catch {
            setError(
              "Payment went through, but we couldn't confirm it here. If your plan doesn't activate within a few minutes, contact support."
            );
          } finally {
            setPaying(false);
          }
        },
        modal: {
          ondismiss: () => setPaying(false),
        },
      });

      rzp.on("payment.failed", () => {
        setError("The payment didn't go through. You can try again.");
        setPaying(false);
      });

      rzp.open();
    } catch (err) {
      console.error("[billing] checkout failed to start:", err);
      setError("Could not start checkout. Please try again.");
      setPaying(false);
    }
  }

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push("/")}>
          ← Home
        </button>
        <div className="brand">Billing</div>
      </nav>

      <section className="hero billing">
        <p className="eyebrow">STARTER · ₹49/MONTH</p>

        {paymentReceived ? (
          <>
            <h1>Payment received.</h1>
            <p className="sub">
              Your plan is being activated — this usually takes a few seconds. You can head back home now;
              your new credits will be there once it's done.
            </p>
          </>
        ) : gated && copy ? (
          <>
            <h1>{copy.heading}</h1>
            <p className="sub">{copy.body}</p>
          </>
        ) : (
          <>
            <h1>Your account is in good standing.</h1>
            <p className="sub">
              {me?.subscription
                ? "No payment is due right now."
                : "We couldn't find an active subscription for your account."}
            </p>
          </>
        )}

        {!paymentReceived && (
          <button onClick={handleSubscribe} disabled={paying}>
            {paying ? "Opening checkout…" : "Subscribe — ₹49/month"}
          </button>
        )}

        {error && <p className="message">{error}</p>}
      </section>
    </main>
  );
}
