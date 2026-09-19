import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Stub subscribe endpoint — Sept 19, 2026, built alongside the new
// app/onboarding/payment/page.tsx plan-picker (see
// architecture-decisions-addendum-2026-09-19.md's "Signup flow redesign,
// built" entry). No payment gateway is wired up yet (Razorpay is the
// intended one — see 0001_init.sql's comment), so this endpoint grants the
// plan's *intro* allowance immediately on selection, as if payment had
// already succeeded, so the rest of the app (credit_balances, /api/me,
// decrement_quick_check) has real data to work against while that
// integration is still pending. Replace the unconditional grant below with
// an actual payment-confirmation step once Razorpay is in place.
//
// Only the two plans currently shown on the stub page are accepted — the
// not-yet-functional Instagram/Facebook Premium variants (see the same
// addendum doc) aren't purchasable anywhere yet, so this route doesn't
// need to know about them.
const ALLOWED_PLAN_CODES = ["plan_99", "plan_299"];

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const planCode = typeof body?.plan_code === "string" ? body.plan_code : null;

  if (!planCode || !ALLOWED_PLAN_CODES.includes(planCode)) {
    return NextResponse.json({ error: "Unknown plan." }, { status: 400 });
  }

  const admin = createAdminClient();

  const { data: plan, error: planError } = await admin
    .from("plans")
    .select("code, display_name, price_inr, intro_quick_checks, intro_deep_investigations, is_active")
    .eq("code", planCode)
    .maybeSingle();

  if (planError || !plan || !plan.is_active) {
    return NextResponse.json({ error: "Unknown plan." }, { status: 400 });
  }

  // Idempotent: a user re-visiting /onboarding/payment (back button, refresh,
  // a second signup on the same account somehow) shouldn't get a second
  // subscription row or a second credit grant on top of an already-active one.
  const { data: existing, error: existingError } = await admin
    .from("subscriptions")
    .select("id, plan_code, status")
    .eq("user_id", user.id)
    .eq("status", "active")
    .maybeSingle();

  if (existingError) {
    console.error("[subscribe] existing-subscription lookup failed:", existingError);
    return NextResponse.json({ error: "Could not start your subscription." }, { status: 500 });
  }

  if (existing) {
    return NextResponse.json({ plan_code: existing.plan_code, already_subscribed: true });
  }

  const { error: subError } = await admin.from("subscriptions").insert({
    user_id: user.id,
    plan_code: plan.code,
  });

  if (subError) {
    console.error("[subscribe] subscription insert failed:", subError);
    return NextResponse.json({ error: "Could not start your subscription." }, { status: 500 });
  }

  const { error: balanceError } = await admin.from("credit_balances").upsert(
    {
      user_id: user.id,
      quick_checks_remaining: plan.intro_quick_checks,
      deep_investigations_remaining: plan.intro_deep_investigations,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );

  if (balanceError) {
    console.error("[subscribe] credit balance upsert failed:", balanceError);
    return NextResponse.json({ error: "Could not start your subscription." }, { status: 500 });
  }

  // Ledger entries for the grant — see 0001_init.sql's comment: "Every
  // balance change must have a corresponding row here."
  const grants: { credit_type: "quick_check" | "deep_investigation"; amount: number }[] = [];
  if (plan.intro_quick_checks > 0) grants.push({ credit_type: "quick_check", amount: plan.intro_quick_checks });
  if (plan.intro_deep_investigations > 0)
    grants.push({ credit_type: "deep_investigation", amount: plan.intro_deep_investigations });

  if (grants.length > 0) {
    const { error: txError } = await admin.from("credit_transactions").insert(
      grants.map((g) => ({
        user_id: user.id,
        credit_type: g.credit_type,
        amount: g.amount,
        reason: "plan_signup_grant",
      }))
    );
    // Non-fatal — the balance itself (what the app actually reads from) is
    // already correct above; a missing ledger row is a bookkeeping gap to
    // fix, not a reason to fail the user's signup.
    if (txError) console.error("[subscribe] credit transaction log failed:", txError);
  }

  return NextResponse.json({ plan_code: plan.code, already_subscribed: false });
}
