import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Returns the signed-in user's credit balance + subscription, for the
// home screen. No free/trial bucket — per the locked pricing decision, a
// user with no subscription has no credit_balances row and sees zeros.
export async function GET() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const admin = createAdminClient();

  const [{ data: balance, error: balanceError }, { data: subscription, error: subError }] = await Promise.all([
    admin
      .from("credit_balances")
      .select("quick_checks_remaining, deep_investigations_remaining")
      .eq("user_id", user.id)
      .maybeSingle(),
    admin
      .from("subscriptions")
      .select("plan_code, status, cancel_at_period_end, current_period_end, payment_required, last_trigger")
      .eq("user_id", user.id)
      .eq("status", "active")
      .maybeSingle(),
  ]);

  if (balanceError) console.error("[me] credit_balances query failed:", balanceError);
  if (subError) console.error("[me] subscriptions query failed:", subError);

  const quick = balance?.quick_checks_remaining ?? 0;
  const deep = balance?.deep_investigations_remaining ?? 0;

  return NextResponse.json({
    credits: {
      quick_checks: quick,
      deep_investigations: deep,
      total: quick + deep,
    },
    subscription: subscription
      ? {
          plan: subscription.plan_code,
          status: subscription.status,
          cancel_at_period_end: subscription.cancel_at_period_end,
          current_period_end: subscription.current_period_end,
          // Billing engine, Phase 1a (Nov 24, 2026) — see lib/billing-gate.ts.
          payment_required: subscription.payment_required ?? false,
          last_trigger: subscription.last_trigger ?? null,
        }
      : null,
    // TEMP DEBUG — remove once the credits-showing-0 mismatch is resolved.
    // Exposes which auth user this session actually resolves to, so we can
    // compare against whichever row we're granting credits to in SQL.
    ...(process.env.NODE_ENV !== "production"
      ? {
          debug: {
            user_id: user.id,
            phone: user.phone,
            had_balance_row: !!balance,
            balance_error: balanceError
              ? { message: balanceError.message, code: balanceError.code, hint: balanceError.hint }
              : null,
          },
        }
      : {}),
  });
}
