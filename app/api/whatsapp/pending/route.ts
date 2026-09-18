import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Returns the signed-in user's single most recent unconsumed WhatsApp
// submission, if any — polled by app/page.tsx to show a "continue from
// WhatsApp" banner. See supabase/migrations/0017_whatsapp_submissions.sql.
// Deliberately returns only ONE item (oldest-first would be more "fair"
// but most-recent-first matches what a user forwarding several things in
// a row actually expects to see first) — a queue of many pending items is
// a real gap worth revisiting if usage shows people forwarding a batch at
// once, but out of scope for this pass.
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
    .from("whatsapp_submissions")
    .select("id, input_type, claim_text, created_at")
    .eq("user_id", user.id)
    .is("consumed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error("[whatsapp/pending] query failed:", error);
    return NextResponse.json({ pending: null });
  }

  if (!data) {
    return NextResponse.json({ pending: null });
  }

  return NextResponse.json({
    pending: {
      id: data.id,
      input_type: data.input_type,
      preview: data.input_type === "text" ? (data.claim_text || "").slice(0, 80) : null,
      created_at: data.created_at,
    },
  });
}
