import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupportedLanguage } from "@/lib/translations";
import { normalizeTrustedContactPhone } from "@/lib/trusted-contact";

// User preferences — Phase 1 of the multilingual rollout (see
// lib/translations.ts and supabase/migrations/0011_user_preferences.sql).
// Originally just { language }, kept as its own small resource rather
// than folded into /api/me so it can grow into a general settings
// endpoint (the settings page's own header notes Credits & Subscription
// moving here eventually) without /api/me's shape changing underneath the
// home screen — the trusted-contact fields added Nov 20, 2026 (see below)
// are the first thing to actually grow into that.
//
// GET returns { language: "en" | "hi" | null } — null specifically means
// "no row yet", which app/providers/language-provider.tsx's hasPreference
// flag uses to decide whether to show the language-picker step. This is
// deliberately different from defaulting to "en" here, which would make a
// genuinely new user indistinguishable from someone who already chose
// English. Also returns trusted_contact_name/trusted_contact_phone (both
// null until set) — added for the digital-arrest Scam SOS feature, read
// by both the Settings panel (to prefill the form) and the
// /verify/digital-arrest page (to decide whether to show a working SOS
// button or a "set one up" prompt).
//
// POST optionally also accepts full_name (Sept 19, 2026, added for the new
// combined Name + Language + Phone signup screen — see app/login/page.tsx)
// and, since Nov 20, 2026, trusted_contact_name/trusted_contact_phone (the
// Settings panel for the Scam SOS feature). language stays REQUIRED
// whenever the caller is the original signup/settings language flow, but
// a caller that's only saving the trusted contact (the new Settings panel
// doesn't need to resend the language the user already has) can omit the
// "language" key from the body entirely — presence, not value, decides
// whether it's validated/updated, so an omitted key leaves the existing
// language untouched rather than being coerced into some default.
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
    .select("language, trusted_contact_name, trusted_contact_phone")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[preferences] lookup failed:", error);
    // Fail open to "no preference yet" rather than erroring the whole
    // page — the language provider treats this the same as a brand-new
    // user, which is the safe direction (worst case: asked again).
    return NextResponse.json({ language: null, trusted_contact_name: null, trusted_contact_phone: null });
  }

  return NextResponse.json({
    language: data?.language ?? null,
    trusted_contact_name: data?.trusted_contact_name ?? null,
    trusted_contact_phone: data?.trusted_contact_phone ?? null,
  });
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
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
  }

  const hasLanguage = Object.prototype.hasOwnProperty.call(body, "language");
  const language = body.language;
  const rawFullName = typeof body.full_name === "string" ? body.full_name.trim() : null;
  const fullName = rawFullName && rawFullName.length > 0 ? rawFullName.slice(0, 200) : null;

  // Nov 20, 2026: trusted-contact fields for the digital-arrest Scam SOS
  // feature's Settings panel. Keyed off presence, same as `hasLanguage`
  // above — the panel always sends both keys together (it's one form), so
  // in practice this is all-or-nothing, but checking presence rather than
  // truthiness means explicitly clearing the contact (empty strings) is
  // also a valid, distinct request from "didn't touch this section."
  const hasTrustedContact =
    Object.prototype.hasOwnProperty.call(body, "trusted_contact_name") ||
    Object.prototype.hasOwnProperty.call(body, "trusted_contact_phone");

  if (hasLanguage && !isSupportedLanguage(language)) {
    return NextResponse.json({ error: "Unsupported language." }, { status: 400 });
  }

  let normalizedPhone: string | null = null;
  let trimmedContactName: string | null = null;
  if (hasTrustedContact) {
    const rawName = typeof body.trusted_contact_name === "string" ? body.trusted_contact_name.trim() : "";
    const rawPhone = typeof body.trusted_contact_phone === "string" ? body.trusted_contact_phone.trim() : "";
    // Clearing is allowed (both fields blank -> both saved as null) so a
    // user can remove a trusted contact from Settings, not just add one.
    if (rawName.length === 0 && rawPhone.length === 0) {
      trimmedContactName = null;
      normalizedPhone = null;
    } else {
      if (rawName.length === 0) {
        return NextResponse.json({ error: "Enter a name for your trusted contact." }, { status: 400 });
      }
      normalizedPhone = normalizeTrustedContactPhone(rawPhone);
      if (!normalizedPhone) {
        return NextResponse.json({ error: "That doesn't look like a valid phone number." }, { status: 400 });
      }
      trimmedContactName = rawName.slice(0, 120);
    }
  }

  if (!hasLanguage && !hasTrustedContact && !fullName) {
    return NextResponse.json({ error: "Nothing to save." }, { status: 400 });
  }

  const admin = createAdminClient();
  const upsertPayload: Record<string, unknown> = {
    user_id: user.id,
    updated_at: new Date().toISOString(),
  };
  if (hasLanguage) upsertPayload.language = language;
  if (hasTrustedContact) {
    upsertPayload.trusted_contact_name = trimmedContactName;
    upsertPayload.trusted_contact_phone = normalizedPhone;
  }

  const { error } = await admin.from("user_preferences").upsert(upsertPayload, { onConflict: "user_id" });

  if (error) {
    console.error("[preferences] save failed:", error);
    return NextResponse.json({ error: "Could not save your preferences." }, { status: 500 });
  }

  if (fullName) {
    const { error: nameError } = await admin.from("profiles").update({ full_name: fullName }).eq("id", user.id);
    // Non-fatal — the language preference (the part every other caller of
    // this route relies on) is already saved above. A name-save failure
    // shouldn't block the signup flow from continuing.
    if (nameError) console.error("[preferences] full_name save failed:", nameError);
  }

  return NextResponse.json({
    language: hasLanguage ? language : undefined,
    full_name: fullName,
    trusted_contact_name: hasTrustedContact ? trimmedContactName : undefined,
    trusted_contact_phone: hasTrustedContact ? normalizedPhone : undefined,
  });
}
