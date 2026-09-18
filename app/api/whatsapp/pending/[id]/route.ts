import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Fetches one pending WhatsApp submission's metadata — used by
// app/verify/claim/page.tsx (for input_type "text") to pre-fill the
// claim textarea. For input_type "image" this only returns metadata; the
// actual bytes come from the sibling [id]/image route, which is also
// where an image submission gets marked consumed. A text submission is
// marked consumed here, since this one response delivers everything the
// app needs for it.
//
// Next.js 15: dynamic route params are a Promise — see app/api/
// verifications/[id]/route.ts for the same pattern already used in this
// app.
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
  const { data, error } = await admin
    .from("whatsapp_submissions")
    .select("id, user_id, input_type, claim_text, consumed_at")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error || !data) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (data.input_type === "text" && !data.consumed_at) {
    await admin.from("whatsapp_submissions").update({ consumed_at: new Date().toISOString() }).eq("id", id);
  }

  return NextResponse.json({
    id: data.id,
    input_type: data.input_type,
    claim_text: data.claim_text,
  });
}
