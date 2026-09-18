import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

// Streams a pending WhatsApp image submission's bytes back to the app —
// app/verify/image/page.tsx fetches this, turns it into a File, and feeds
// it into the SAME client-side handleFile() pipeline (OCR + downscale)
// that a normal file-picker upload uses, so nothing about the existing
// image-verification flow needed to change. Marks the submission consumed
// and deletes the temp-whatsapp-uploads object after a successful read —
// same "never persists" media-retention principle as every other input
// type in this app (Part 15) and the same pattern as the video temp-
// storage cleanup (lib/video-file-pipeline.ts).
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
    .select("id, user_id, input_type, storage_path, mime_type")
    .eq("id", id)
    .eq("user_id", user.id)
    .maybeSingle();

  if (error || !data || data.input_type !== "image" || !data.storage_path) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const { data: blob, error: downloadError } = await admin.storage
    .from("temp-whatsapp-uploads")
    .download(data.storage_path);

  if (downloadError || !blob) {
    console.error("[whatsapp/pending/image] storage download failed:", downloadError);
    return NextResponse.json({ error: "That photo could not be found." }, { status: 404 });
  }

  const bytes = await blob.arrayBuffer();

  await admin.from("whatsapp_submissions").update({ consumed_at: new Date().toISOString() }).eq("id", id);
  const { error: removeError } = await admin.storage.from("temp-whatsapp-uploads").remove([data.storage_path]);
  if (removeError) {
    console.error("[whatsapp/pending/image] failed to delete storage object:", removeError);
  }

  return new NextResponse(bytes, {
    headers: {
      "Content-Type": data.mime_type || "image/jpeg",
      "Cache-Control": "no-store",
    },
  });
}
