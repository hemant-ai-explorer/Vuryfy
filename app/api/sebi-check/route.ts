import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { lookupSebiIntermediary } from "@/lib/sebi-check";
import { track } from "@/lib/analytics";

// SEBI registration check — Nov 20, 2026. See lib/sebi-check.ts's header
// for the full rationale.
//
// Deliberately FREE and uncredited, unlike every other verification type
// in this app (explicit product decision, Nov 20 2026): after the sync
// job populates sebi_intermediaries, each lookup only queries Vuryfy's
// own cached table — no per-call external cost like Decentro's ₹1-2/hit
// for the VPA-registered-name feature, so there's no cost reason to meter
// it, and making it free strengthens the "before you trust this, verify
// it" positioning. Still requires sign-in, same as every other route
// here, but makes no call to decrement_quick_check/decrement_deep_check
// and writes nothing to credit_transactions.
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const name: string = (body?.name ?? "").trim().slice(0, 200);
  const regNo: string = (body?.reg_no ?? "").trim().slice(0, 50);

  if (!name && !regNo) {
    return NextResponse.json({ error: "Enter a name or SEBI registration number." }, { status: 400 });
  }

  const admin = createAdminClient();

  track(user.id, "verification_submitted", { mode: "free_tool", input_type: "sebi_check" });

  const result = await lookupSebiIntermediary(admin, { name, regNo });

  track(user.id, "verification_completed", {
    mode: "free_tool",
    input_type: "sebi_check",
    match_count: result.matches.length,
  });

  return NextResponse.json({
    type: "sebi_check",
    query: { name: name || null, reg_no: regNo || null },
    matches: result.matches,
    // null means the sync job has never run yet — the UI should say so
    // plainly rather than implying a check that didn't actually happen.
    synced_at: result.syncedAt,
  });
}
