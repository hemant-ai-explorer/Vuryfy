import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Fetches ONE past verification by id, in the same response shape
// app/api/verify/route.ts returns for a fresh check — lets app/result/
// page.tsx render a past result the same way it renders a brand new one,
// whether the user got here from the new history list (app/saved/
// page.tsx) or from a WhatsApp-submitted check that has no sessionStorage
// entry to read from (see that page's fetch-by-id fallback, added Sept
// 18, 2026 alongside the WhatsApp submission MVP).
//
// Ownership check happens in application code (the admin client bypasses
// RLS) — same standing pattern as every other route in this codebase
// (Part 19): ".eq("user_id", user.id)" is part of the query itself, so
// there's no window where a fetched row could leak to the wrong
// requester.
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;

  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data: verification, error } = await admin
    .from("verifications")
    .select("*")
    .eq("id", id)
    .eq("user_id", user.id)
    .single();

  if (error || !verification) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const { data: balance } = await admin
    .from("credit_balances")
    .select("quick_checks_remaining, deep_investigations_remaining")
    .eq("user_id", user.id)
    .single();

  return NextResponse.json({
    id: verification.id,
    mode: verification.mode,
    claim: verification.claim_text,
    verdict: verification.verdict,
    confidence: verification.confidence,
    explanation: verification.summary,
    evidence: verification.key_evidence,
    sources: verification.sources,
    caveats: verification.caveats,
    cached: false,
    cached_at: null,
    credits: {
      quick_checks: balance?.quick_checks_remaining ?? 0,
      deep_investigations: balance?.deep_investigations_remaining ?? 0,
      total: (balance?.quick_checks_remaining ?? 0) + (balance?.deep_investigations_remaining ?? 0),
    },
  });
}
