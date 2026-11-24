import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { buildDailyCheck } from "@/lib/daily-check";
import { sendWhatsAppMessage, DAILY_CHECK_WHATSAPP_SEND_ENABLED } from "@/lib/whatsapp";
import { isSupportedLanguage, type Language } from "@/lib/translations";

// Daily Check cron route — Nov 21, 2026. See lib/daily-check.ts's header
// for the full pipeline (topic discovery -> Deep Investigation -> per-
// language localization) and supabase/migrations/0026_daily_checks.sql
// for the table this writes to.
//
// Wired up as a real Vercel Cron Job from day one (vercel.json), unlike
// app/api/admin/sebi-sync/route.ts's "manual for now, cron it later once
// watched by hand" approach — this route is meant to run completely
// unattended every day, and its own fail-closed design (see
// buildDailyCheck()) is exactly the safety net that makes that
// reasonable: a bad day produces a skip, never a bad publish.
//
// Budget: topic search (a few parallel Tavily calls) + the full Deep
// Investigation pipeline (itself targets well under 30s) + one
// localization call, comfortably under Vercel's Hobby-plan Cron timeout.
export const maxDuration = 120;

const APP_URL = process.env.NEXT_PUBLIC_APP_URL || "https://app.vuryfy.com";

// Auth: a shared secret, NOT a signed-in-user check — same convention as
// app/api/admin/sebi-sync/route.ts, but checked as `Authorization: Bearer
// <CRON_SECRET>`, matching Vercel Cron's own documented convention of
// sending that exact header (set CRON_SECRET as a Vercel env var — both
// Preview and Production, different values, same as every other secret
// in this project) so vercel.json's scheduled trigger needs no extra
// configuration beyond the env var. For manual/curl testing before cron
// is confirmed working, send the same header by hand.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const provided = request.headers.get("authorization");

  if (!secret) {
    console.error("[daily-check] CRON_SECRET is not set — refusing to run (would otherwise be an unauthenticated public endpoint that burns AI/search spend on demand).");
    return NextResponse.json({ error: "Not configured." }, { status: 503 });
  }
  if (provided !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const build = await buildDailyCheck();
  if (!build) {
    return NextResponse.json({ ok: true, skipped: true, reason: "No credible real topic found today." });
  }

  const admin = createAdminClient();
  const { error: insertError } = await admin.from("daily_checks").insert({
    slug: build.slug,
    claim: build.claim,
    verdict: build.verdict,
    confidence: build.confidence,
    headline: build.headline,
    summary: build.summary,
    teaser: build.teaser,
    caveats: build.caveats,
    sources: build.sources,
  });

  if (insertError) {
    console.error("[daily-check] insert failed:", insertError);
    return NextResponse.json({ ok: false, error: "Could not save today's check." }, { status: 500 });
  }

  // Which real Vuryfy phone number (if any) receives the WhatsApp push —
  // currently always the same single test number while sending stays
  // disabled pending WhatsApp template approval.
  const recipient = process.env.DAILY_CHECK_RECIPIENT_NUMBER;

  // Which language the WhatsApp message itself is written in — a single
  // message can only be one language, unlike the /today page behind the
  // link, which offers all 9. Nov 24, 2026: this now follows the
  // recipient's own Vuryfy account language — the same user_preferences
  // row Settings and the signup language picker read/write (see
  // app/providers/language-provider.tsx and supabase/migrations/0011_
  // user_preferences.sql) — rather than a separate hardcoded env var.
  // That only works today because `recipient` is one real Vuryfy account
  // (Hemant's own, for testing), not a genuine subscriber list; a future
  // per-user broadcast would do this same per-recipient lookup for each
  // one individually. Falls back to DAILY_CHECK_RECIPIENT_LANGUAGE (or
  // "en") when the recipient isn't a real Vuryfy account, or that account
  // has never saved a language preference.
  let recipientLanguage: Language = "en";
  const envFallback = process.env.DAILY_CHECK_RECIPIENT_LANGUAGE || "en";
  if (isSupportedLanguage(envFallback)) recipientLanguage = envFallback;
  if (recipient) {
    try {
      const { data: profile } = await admin.from("profiles").select("id").eq("phone", recipient).maybeSingle();
      if (profile) {
        const { data: pref } = await admin
          .from("user_preferences")
          .select("language")
          .eq("user_id", profile.id)
          .maybeSingle();
        if (pref && isSupportedLanguage(pref.language)) {
          recipientLanguage = pref.language;
        }
      }
    } catch (err) {
      console.error("[daily-check] recipient language lookup failed — using fallback:", err);
    }
  }

  // Carries the same ?lang= so tapping through opens the /today page in
  // the exact language the WhatsApp message was sent in, rather than
  // whatever the viewer's signed-in account defaults to (the page prefers
  // a ?lang= query param over the account's own setting — see
  // app/today/[slug]/page.tsx's DailyCheckView comment).
  const link = `${APP_URL}/today/${build.slug}?lang=${recipientLanguage}`;

  const headline = build.headline[recipientLanguage] ?? build.headline.en;
  const teaser = build.teaser[recipientLanguage] ?? build.teaser.en;
  // Nov 24, 2026 revision: the message carries only the headline + a
  // short teaser line, never the full write-up. Putting the complete
  // explanation in the WhatsApp message (the old behavior) answered the
  // question right there and gave the reader no reason to tap through —
  // the teaser is a deliberate curiosity gap; the full "summary" only
  // ever appears on the /today page behind the link.
  const messageBody = `${headline}\n\n${teaser}\n\n${link}`;

  let sendResult: { ok: boolean; error?: string } = {
    ok: false,
    error: "Sending is disabled (DAILY_CHECK_WHATSAPP_SEND_ENABLED is false in lib/whatsapp.ts).",
  };
  if (DAILY_CHECK_WHATSAPP_SEND_ENABLED) {
    if (!recipient) {
      sendResult = { ok: false, error: "DAILY_CHECK_RECIPIENT_NUMBER is not set." };
    } else {
      sendResult = await sendWhatsAppMessage({
        to: recipient,
        body: messageBody,
        templateVariables: { "1": headline, "2": teaser, "3": link },
      });
    }
    if (!sendResult.ok) {
      console.error("[daily-check] WhatsApp send failed:", sendResult.error);
    }
  }

  return NextResponse.json({
    ok: true,
    slug: build.slug,
    verdict: build.verdict,
    confidence: build.confidence,
    link,
    whatsapp_sent: sendResult.ok,
    whatsapp_error: sendResult.error,
  });
}
