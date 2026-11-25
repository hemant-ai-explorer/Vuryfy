import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Billing-trigger cron — Nov 24, 2026. Handles the third of Correction #2's
// two-trigger spec (marketing-site-2026-09-19.md): if a user never hit the
// 6th-Quick-Check / 1st-Deep-Investigation triggers (see lib/billing-gate.ts
// for those two), they're still charged automatically the moment their
// intro month ends. This route is what fires that time-based trigger —
// lib/billing-gate.ts only runs inside a live verify/deep request, so it
// has no way to notice a month boundary passing with no requests at all.
//
// Wired as a real Vercel Cron Job from day one (vercel.json), same
// convention as app/api/cron/daily-check/route.ts: a shared-secret bearer
// token (CRON_SECRET — same env var, reused rather than a second secret),
// checked the same way. Runs once a day; a user's intro month ending a few
// hours later than their exact signup instant is an acceptable slop for a
// billing *prompt* (no money has moved either way yet — Phase 1b is what
// actually charges anyone), not a correctness bug.
//
// Phase 1a scope: this only marks payment_required = true, exactly like
// lib/billing-gate.ts's two request-time triggers. It does not talk to a
// payment gateway — that's Phase 1b.
export const maxDuration = 30;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization");

  if (!secret) {
    console.error(
      "[billing-trigger] CRON_SECRET is not set — refusing to run (would otherwise be an unauthenticated public endpoint that re-gates arbitrary users on demand)."
    );
    return NextResponse.json({ error: "Not configured." }, { status: 503 });
  }
  if (provided !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const admin = createAdminClient();

  // Every active, still-in-intro-month subscription whose period has
  // already ended and that hasn't already been gated by one of the two
  // usage triggers. is_intro_month only flips to false once a real payment
  // actually lands (Phase 1b), so this correctly keeps re-selecting the
  // same not-yet-paid users every day until Phase 1b resolves them one way
  // or another — that's intended, not a bug to fix here.
  const { data: dueSubscriptions, error: selectError } = await admin
    .from("subscriptions")
    .select("id, user_id")
    .eq("status", "active")
    .eq("is_intro_month", true)
    .eq("payment_required", false)
    .lte("current_period_end", new Date().toISOString());

  if (selectError) {
    console.error("[billing-trigger] subscription lookup failed:", selectError);
    return NextResponse.json({ error: "Could not look up due subscriptions." }, { status: 500 });
  }

  if (!dueSubscriptions || dueSubscriptions.length === 0) {
    return NextResponse.json({ ok: true, gated: 0 });
  }

  const ids = dueSubscriptions.map((s) => s.id);
  const { error: updateError } = await admin
    .from("subscriptions")
    .update({
      payment_required: true,
      last_trigger: "month_end",
      last_trigger_at: new Date().toISOString(),
    })
    .in("id", ids);

  if (updateError) {
    console.error("[billing-trigger] failed to mark payment_required:", updateError);
    return NextResponse.json({ error: "Found due subscriptions but could not gate them." }, { status: 500 });
  }

  return NextResponse.json({ ok: true, gated: ids.length });
}
