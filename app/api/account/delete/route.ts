import { NextResponse } from "next/server";
import { createClient as createServerSupabase } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { track } from "@/lib/analytics";

// Account deletion — Sept 20, 2026. Implements Part 15's locked user right:
// "delete account (triggers deletion/anonymization of associated personal
// data, subject to legally required retention for billing/fraud/legal/
// financial/security/dispute-resolution records, which are kept separate
// from user-generated content wherever possible)". Was never built until
// now — see frontend/app/settings/page.tsx for the confirming UI.
//
// What actually deletes the user's data, and how:
//   1. Storage cleanup (best-effort, non-fatal) — temp-video-uploads and
//      temp-whatsapp-uploads both key objects by `{user_id}/...` (see
//      lib/video-file-pipeline.ts, app/api/whatsapp/webhook/route.ts) but
//      have no FK tie to auth.users at all, so nothing else will ever clean
//      these up for a deleted user.
//   2. Anonymize credit_transactions (the billing/audit ledger) by setting
//      user_id to null on this user's rows, BEFORE deleting the auth user —
//      this table is deliberately retained rather than cascade-deleted, per
//      the locked spec above, mirroring the content_moderation_flags
//      ON DELETE SET NULL pattern. Requires supabase/migrations/
//      0020_account_deletion_support.sql (drops the column's NOT NULL) to
//      already be applied — run that migration before this route can work.
//   3. The actual irreversible step, done last so 1-2 can be safely retried
//      if something upstream fails: admin.auth.admin.deleteUser(). Every
//      other per-user table (profiles, subscriptions, credit_balances,
//      verifications and its cache rows, user_preferences,
//      payment_payees_seen, whatsapp_link_codes, whatsapp_submissions)
//      cascades automatically via existing ON DELETE CASCADE foreign keys —
//      no code needed for those. content_moderation_flags also needs no
//      code here: it already has its own ON DELETE SET NULL, so a flagged-
//      content record survives account deletion by design.
export async function POST() {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const admin = createAdminClient();
  const userId = user.id;

  // 1. Storage cleanup — best-effort. A failure here (e.g. the user simply
  // never uploaded anything, so the "folder" doesn't exist) must never
  // block the actual account deletion below.
  for (const bucket of ["temp-video-uploads", "temp-whatsapp-uploads"]) {
    try {
      const { data: files, error: listError } = await admin.storage.from(bucket).list(userId);
      if (listError) {
        console.error(`[account/delete] storage list failed for ${bucket}:`, listError);
        continue;
      }
      if (files && files.length > 0) {
        const paths = files.map((f) => `${userId}/${f.name}`);
        const { error: removeError } = await admin.storage.from(bucket).remove(paths);
        if (removeError) {
          console.error(`[account/delete] storage remove failed for ${bucket}:`, removeError);
        }
      }
    } catch (err) {
      console.error(`[account/delete] storage cleanup threw for ${bucket}:`, err);
    }
  }

  // 2. Anonymize the billing ledger before the cascade below would
  // otherwise destroy it. Non-fatal on failure, same reasoning as the
  // storage cleanup — this row set has already served its audit purpose
  // for past checks either way, and we don't want a transient DB error
  // here to leave the account undeletable.
  const { error: anonymizeError } = await admin
    .from("credit_transactions")
    .update({ user_id: null })
    .eq("user_id", userId);
  if (anonymizeError) {
    console.error("[account/delete] credit_transactions anonymize failed:", anonymizeError);
  }

  // 3. The irreversible step. If this fails, steps 1-2 having already run
  // is fine to repeat on a retry (removing already-removed storage objects,
  // or re-anonymizing already-null rows, are both no-ops).
  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) {
    console.error("[account/delete] auth.admin.deleteUser failed:", deleteError);
    return NextResponse.json(
      {
        error: "Try Again",
        ...(process.env.NODE_ENV !== "production"
          ? { debug: { message: deleteError.message } }
          : {}),
      },
      { status: 502 }
    );
  }

  // Analytics (Part 23, Sept 21, 2026) — fired only once deletion actually
  // succeeded, using the userId captured before deleteUser() ran (the
  // distinctId doesn't need to reference a still-live row). See
  // lib/analytics.ts's header for the privacy rules this follows
  // (pseudonymous ID only, no other user data attached).
  track(userId, "user_account_deleted", {});

  return NextResponse.json({ ok: true });
}
