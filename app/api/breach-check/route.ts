import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { checkEmailBreaches, checkPasswordBreach } from "@/lib/breach-check";
import { track } from "@/lib/analytics";

// Email/password breach check — Nov 24, 2026. See lib/breach-check.ts's
// header for the full rationale and data source.
//
// Deliberately FREE and uncredited, same product decision and reasoning as
// the SEBI check (app/api/sebi-check/route.ts) and digital-arrest
// checklist: a "verify before you trust" trust builder, not a credited
// verification with a stored verdict, and the marginal cost is near-zero
// (XposedOrNot's free tier, no new vendor contract). Still requires
// sign-in like every other route here, but writes nothing to
// credit_transactions and makes no call to
// decrement_quick_check/decrement_deep_check.
//
// Two independent check types in one route (`type: "email" | "password"`)
// rather than two separate routes, since they share the same auth/
// analytics wrapper — but the client always submits ONE type per request,
// never both together, so an email and a password a user is checking are
// never paired in a single request/log line, even conceptually.
export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const type = body?.type === "password" ? "password" : body?.type === "email" ? "email" : null;

  if (!type) {
    return NextResponse.json({ error: 'Specify type: "email" or "password".' }, { status: 400 });
  }

  if (type === "email") {
    const email = typeof body?.email === "string" ? body.email.trim().slice(0, 320) : "";
    if (!email || !email.includes("@")) {
      return NextResponse.json({ error: "Enter a valid email address." }, { status: 400 });
    }

    track(user.id, "verification_submitted", { mode: "free_tool", input_type: "breach_check_email" });
    const result = await checkEmailBreaches(email);

    if (result.unavailable) {
      track(user.id, "verification_failed", { mode: "free_tool", input_type: "breach_check_email" });
      return NextResponse.json(
        { error: "Breach check is temporarily unavailable — please try again shortly." },
        { status: 503 }
      );
    }

    track(user.id, "verification_completed", {
      mode: "free_tool",
      input_type: "breach_check_email",
      found: result.found,
      breach_count: result.breaches.length,
    });

    return NextResponse.json({ type: "email", found: result.found, breaches: result.breaches });
  }

  // type === "password"
  const password = typeof body?.password === "string" ? body.password : "";
  if (!password) {
    return NextResponse.json({ error: "Enter a password to check." }, { status: 400 });
  }

  track(user.id, "verification_submitted", { mode: "free_tool", input_type: "breach_check_password" });
  const result = await checkPasswordBreach(password);

  if (result.unavailable) {
    track(user.id, "verification_failed", { mode: "free_tool", input_type: "breach_check_password" });
    return NextResponse.json(
      { error: "Breach check is temporarily unavailable — please try again shortly." },
      { status: 503 }
    );
  }

  track(user.id, "verification_completed", {
    mode: "free_tool",
    input_type: "breach_check_password",
    found: result.found,
  });

  return NextResponse.json({ type: "password", found: result.found, count: result.count });
}
