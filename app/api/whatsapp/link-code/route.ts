import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateLinkCode } from "@/lib/whatsapp";

// Generates a one-time code + wa.me deep link that starts a WhatsApp link
// session (Part 13 rework) — see supabase/migrations/0017_whatsapp_
// submissions.sql for the full design. Once linked, the phone can forward
// text/a link OR a photo as separate messages; no mode/type needs to be
// chosen up front anymore, since the app decides Quick Check vs Deep
// Investigation later, per submission. Called from app/verify/claim/
// page.tsx and app/verify/image/page.tsx's "Get a WhatsApp link" step.
export const maxDuration = 30;

const CODE_TTL_MINUTES = 15;
// Guards against the astronomically rare case of generating a code that
// collides with another still-active one (the partial unique index on
// whatsapp_link_codes(code) where consumed_at is null enforces this at
// the DB level — this loop just retries past a collision instead of
// failing the request outright).
const MAX_GENERATE_ATTEMPTS = 5;

export async function POST(request: Request) {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const whatsappNumber = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER;
  if (!whatsappNumber) {
    console.error("[whatsapp/link-code] NEXT_PUBLIC_WHATSAPP_NUMBER is not set");
    return NextResponse.json({ error: "WhatsApp submission isn't set up yet." }, { status: 500 });
  }

  const admin = createAdminClient();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000).toISOString();

  let code = "";
  let inserted = false;
  for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS && !inserted; attempt++) {
    code = generateLinkCode();
    const { error } = await admin.from("whatsapp_link_codes").insert({
      user_id: user.id,
      code,
      expires_at: expiresAt,
    });
    if (!error) {
      inserted = true;
    } else if (error.code !== "23505") {
      // Anything other than a unique-constraint collision is a real
      // failure, not just bad luck — stop retrying and surface it.
      console.error("[whatsapp/link-code] insert failed:", error);
      return NextResponse.json(
        { error: "Couldn't generate a WhatsApp link. Please try again." },
        { status: 500 }
      );
    }
  }

  if (!inserted) {
    console.error("[whatsapp/link-code] exhausted retries generating a unique code");
    return NextResponse.json(
      { error: "Couldn't generate a WhatsApp link. Please try again." },
      { status: 500 }
    );
  }

  const waLink = `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(code)}`;

  return NextResponse.json({ code, wa_link: waLink, expires_at: expiresAt });
}
