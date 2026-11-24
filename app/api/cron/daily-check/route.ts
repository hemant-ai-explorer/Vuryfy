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

  const link = `${APP_URL}/today/${build.slug}`;

  // Which language the WhatsApp message itself is written in — a single
  // message can only be one language, unlike the /today page behind the
  // link, which offers all 9. Defaults to English; set
  // DAILY_CHECK_RECIPIENT_LANGUAGE (a Vuryfy language code, e.g. "hi") to
  // change it.
  const recipientLanguageRaw = process.env.DAILY_CHECK_RECIPIENT_LANGUAGE || "en";
  const recipientLanguage: Language = isSupportedLanguage(recipientLanguageRaw) ? recipientLanguageRaw : "en";
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
  const recipient = process.env.DAILY_CHECK_RECIPIENT_NUMBER;
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
