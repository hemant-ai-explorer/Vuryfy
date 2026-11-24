"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api-fetch";

// Stub "choose your plan" step — Sept 19, 2026.
//
// ORPHANED as of Nov 24, 2026 — nothing in the app links here anymore.
// app/login/page.tsx's signup flow used to route here after OTP verify;
// it now grants the Starter plan's intro allowance silently (see that
// file's header comment) and goes straight to "/" instead, per the locked
// Correction #2 spec in marketing-site-2026-09-19.md ("just phone +
// language" at signup, no plan-choice screen). Left in place, unlinked,
// as a reference for whoever builds the real plan-choice + payment screen
// that's supposed to appear at the actual trigger moment (6th Quick Check,
// 1st Deep Investigation, or start of month 2) — that screen will look a
// lot like this one, just reachable from a different place and with a
// real payment step added. Delete once that real screen exists, or sooner
// if it's confusing to leave around.
//
// Original Sept 19, 2026 note, still accurate about what this page itself
// does: last step of the signup flow at the time (Name + Language + Phone
// → OTP → this page — see architecture-decisions-addendum-2026-09-19.md's
// "Signup flow redesign, built" entry). Per the user's explicit choice,
// this is a clearly-labeled development-mode stub rather than a real
// Razorpay checkout (no payment gateway exists anywhere in this codebase
// yet — see the same addendum) — picking a plan calls /api/subscribe,
// which grants the plan's intro credit allowance immediately, as if
// payment had already gone through.
//
// Only Starter (₹99) is shown as of Nov 24, 2026 — user's explicit
// decision: "for starting i just want one plan." Power (₹199) is hidden,
// not deleted (supabase/migrations/0028_single_plan_launch.sql sets its
// is_active flag to false on public.plans rather than removing the row),
// so re-enabling it later is a data change, not a rebuild. This page is
// already orphaned (see its header note above), so this edit is really
// just keeping the reference stub honest for whoever builds the real
// plan-choice + payment screen later — it shouldn't reintroduce a second
// plan without that also being a deliberate decision at the time. The
// Instagram/Facebook Premium variants from the Sept 19 addendum remain a
// separate, explicitly deferred piece of work either way.
//
// Auth-gated the same way app/settings/page.tsx is: a client-side
// supabase.auth.getUser() check that bounces to /login if there's no
// session, rather than a server component, to match that existing
// convention in this app.
//
// English-only strings, hardcoded rather than run through lib/translations.ts
// — same "flagged, known i18n gap" precedent already used for the WhatsApp
// UI panels (see lib/whatsapp.ts) — since this whole page is a temporary
// stub that a real payment integration will replace.
type PlanCode = "plan_99" | "plan_299";

const PLANS: {
  code: PlanCode;
  name: string;
  priceInr: number;
  headline: string;
  detail: string;
}[] = [
  {
    code: "plan_99",
    name: "Starter",
    priceInr: 99,
    headline: "30 Quick Checks + 2 Deep Investigations / month",
    detail: "5 free Quick Checks to start, then the full monthly allowance from month 2 (no rollover).",
  },
  // Power (plan_299, ₹199) deliberately left out — see the header comment
  // above. Its is_active flag is false in the database; add it back here
  // if that ever changes.
];

export default function OnboardingPaymentPage() {
  const router = useRouter();
  const supabase = createClient();
  const [checkingAuth, setCheckingAuth] = useState(true);
  const [selecting, setSelecting] = useState<PlanCode | null>(null);
  const [message, setMessage] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        router.replace("/login");
        return;
      }
      setCheckingAuth(false);
    });
  }, [router, supabase]);

  async function choose(planCode: PlanCode) {
    setSelecting(planCode);
    setMessage("");
    try {
      const res = await apiFetch("/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan_code: planCode }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setMessage(body?.error || "Something went wrong starting your plan. Please try again.");
        setSelecting(null);
        return;
      }
      router.push("/");
      router.refresh();
    } catch (err) {
      console.error("[onboarding/payment] subscribe failed:", err);
      setMessage("Something went wrong starting your plan. Please try again.");
      setSelecting(null);
    }
  }

  if (checkingAuth) return null;

  return (
    <main className="shell narrow">
      <nav>
        <div className="brand">Vuryfy</div>
      </nav>
      <section className="hero">
        <p className="eyebrow">CHOOSE YOUR PLAN</p>
        <h1>One more step.</h1>
        <p className="sub">Pick a plan to activate your account.</p>

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
          Development mode — no real payment gateway is connected yet. Choosing a plan below activates it
          immediately, free of charge.
        </div>

        <div style={{ display: "grid", gap: 16, marginTop: 16, width: "100%" }}>
          {PLANS.map((plan) => (
            <div
              key={plan.code}
              className="panel"
              style={{ width: "100%", display: "flex", flexDirection: "column", gap: 8 }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <h2 style={{ margin: 0 }}>{plan.name}</h2>
                <span style={{ fontWeight: 600 }}>₹{plan.priceInr}/month</span>
              </div>
              <p style={{ margin: 0, fontWeight: 500 }}>{plan.headline}</p>
              <p className="hint" style={{ margin: 0 }}>
                {plan.detail}
              </p>
              <button disabled={selecting !== null} onClick={() => choose(plan.code)}>
                {selecting === plan.code ? "Activating…" : `Choose ${plan.name}`}
              </button>
            </div>
          ))}
        </div>

        {message && <p className="message">{message}</p>}
      </section>
    </main>
  );
}
