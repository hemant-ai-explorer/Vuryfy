import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupportedLanguage } from "@/lib/translations";

// User preferences — Phase 1 of the multilingual rollout (see
// lib/translations.ts and supabase/migrations/0011_user_preferences.sql).
// Currently just { language }, but kept as its own small resource rather
// than folded into /api/me so it can grow into a general settings
// endpoint (the settings page's own header notes Credits & Subscription
// moving here eventually) without /api/me's shape changing underneath the
// home screen.
//
// GET returns { language: "en" | "hi" | null } — null specifically means
// "no row yet", which app/providers/language-provider.tsx's hasPreference
// flag uses to decide whether to show the language-picker step. This is
// deliberately different from defaulting to "en" here, which would make a
// genuinely new user indistinguishable from someone who already chose
// English.
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
    .from("user_preferences")
    .select("language")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[preferences] lookup failed:", error);
    // Fail open to "no preference yet" rather than erroring the whole
    // page — the language provider treats this the same as a brand-new
    // user, which is the safe direction (worst case: asked again).
    return NextResponse.json({ language: null });
  }

  return NextResponse.json({ language: data?.language ?? null });
}

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const language = body?.language;

  if (!isSupportedLanguage(language)) {
    return NextResponse.json({ error: "Unsupported language." }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("user_preferences")
    .upsert({ user_id: user.id, language, updated_at: new Date().toISOString() }, { onConflict: "user_id" });

  if (error) {
    console.error("[preferences] save failed:", error);
    return NextResponse.json({ error: "Could not save your language preference." }, { status: 500 });
  }

  return NextResponse.json({ language });
}
