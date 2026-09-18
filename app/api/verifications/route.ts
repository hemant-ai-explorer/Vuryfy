import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Lists the signed-in user's past verifications, newest first — powers
// the history screen (app/saved/page.tsx). Sept 18, 2026: added alongside
// the WhatsApp submission MVP, since a WhatsApp-submitted result has no
// browser tab to redirect to and needs somewhere to land — but this list
// is generally useful regardless of submission method; every check ever
// run through the app shows up here, not just WhatsApp ones.
export async function GET() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("verifications")
    .select("id, mode, input_type, claim_text, verdict, confidence, created_at")
    .eq("user_id", user.id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    console.error("[verifications list] query failed:", error);
    return NextResponse.json({ error: "Couldn't load your history." }, { status: 500 });
  }

  return NextResponse.json({
    items: (data || []).map((v) => ({
      id: v.id,
      mode: v.mode,
      input_type: v.input_type,
      claim: v.claim_text,
      verdict: v.verdict,
      confidence: v.confidence,
      created_at: v.created_at,
    })),
  });
}
