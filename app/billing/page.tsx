"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api-fetch";

// Billing engine, Phase 1a (Nov 24, 2026) — see
// claude/billing-engine-scoping-2026-11-24.md in the Vuryfy project for the
// full design. This REPLACES the previous app/billing/page.tsx entirely —
// that version called a FastAPI backend at http://localhost:8000 that
// doesn't exist anywhere in this Next.js app (leftover from an early
// prototype, dead code, never linked from any live flow). This page is the
// real destination app/api/verify and app/api/deep now redirect to the
// moment a user hits one of Correction #2's two usage triggers (see
// lib/billing-gate.ts), and is also where the month-end cron trigger
// (app/api/cron/billing-trigger/route.ts) should send a user the next time
// they open the app.
//
// Phase 1a is intentionally an HONEST STUB for the actual payment step —
// no gateway is wired up yet (Phase 1b, pending a real Razorpay account).
// This mirrors the same honesty convention already used for
// app/onboarding/payment/page.tsx's amber "Development mode" notice rather
// than pretending a button here does something it doesn't. The one thing
// this page gets right regardless of Phase 1b's timing: it correctly
// explains WHY the user is here (which trigger fired) and does not lose
// their account/usage state — both already-agreed Correction #2
// mitigations that don't require a payment gateway to implement.
//
// English-only strings, hardcoded rather than run through
// lib/translations.ts — same "flagged, known i18n gap" precedent already
// used for app/onboarding/payment/page.tsx and the WhatsApp UI panels,
// since the real payment screen (once Phase 1b lands) will likely look
// different enough from this stub that localizing this version first would
// be wasted work.

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

const TRIGGER_COPY: Record<Exclude<Trigger, null>, { heading: string; body: string }> = {
  quick_check_6: {
    heading: "You've used your 5 free Quick Checks.",
    body: "Your first month included 5 free Quick Checks. To keep checking, add a payment method and continue on the Starter plan — 30 Quick Checks + 2 Deep Investigations every month.",
  },
  deep_investigation_1: {
    heading: "Deep Investigation is a paid feature.",
    body: "Deep Investigation isn't part of the free first month. Add a payment method to run this Deep Investigation and continue on the Starter plan.",
  },
  month_end: {
    heading: "Your free first month has ended.",
    body: "You didn't use a 6th Quick Check or a Deep Investigation this month, so nothing was charged — but your free month is now over. Add a payment method to continue on the Starter plan.",
  },
};

export default function BillingPage() {
  return (
    <Suspense fallback={null}>
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

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push("/")}>
          ← Home
        </button>
        <div className="brand">Billing</div>
      </nav>

      <section className="hero billing">
        <p className="eyebrow">STARTER · ₹99/MONTH</p>

        {gated && copy ? (
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

        <div
          className="message"
          style={{
            marginTop: 16,
            marginBottom: 8,
            background: "#fffbeb",
            border: "1px solid #f59e0b",
            color: "#92400e",
            borderRadius: 8,
            padding: "10px 14px",
            fontSize: 14,
          }}
        >
          Payment setup is still being built. Your account and usage history are safe either way —
          nothing is lost by waiting, and we'll let you know the moment you can add a payment method here.
        </div>

        <button disabled>Add payment method — coming soon</button>

        {error && <p className="message">{error}</p>}
      </section>
    </main>
  );
}
