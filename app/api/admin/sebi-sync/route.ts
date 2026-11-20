import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncSebiCategory, SEBI_CATEGORIES } from "@/lib/sebi-check";

// Route-level execution budget — paging through ~2,400 Research Analyst +
// ~1,082 Investment Adviser records (96 + 44 pages, ~400ms apart) takes a
// few minutes. 300 is comfortably under Vercel's Pro-plan max (900s);
// bump the Vercel plan/limit if this ever needs to run on Hobby.
export const maxDuration = 300;

// SEBI intermediary-registry sync — Nov 20, 2026. See lib/sebi-check.ts's
// header for the full rationale and claude/scam-feature-sebi-check-
// 2026-11-20.md (Vuryfy project notes) for the feasibility writeup this
// was built from.
//
// Not user-facing — this is triggered manually for now (curl/Postman with
// the shared secret below) while the feature is being tested on `test`.
// Once it's confirmed working end-to-end, the natural next step is a
// Vercel Cron Job (vercel.json) hitting this route on a schedule (e.g.
// nightly) instead of a manual trigger — not wired up yet, deliberately,
// since this is the first real run and worth watching manually before
// automating.
//
// Auth: a shared secret header, NOT a signed-in-user check — this isn't
// something any Vuryfy user should ever be able to trigger themselves
// (it's a slow, SEBI-facing bulk operation, not a per-user action). Set
// SEBI_SYNC_SECRET in Vercel env vars (Preview AND Production — use a
// different value in each, same convention as every other secret in this
// project) before calling this.
export async function POST(request: Request) {
  const secret = process.env.SEBI_SYNC_SECRET;
  const provided = request.headers.get("x-sebi-sync-secret");

  if (!secret) {
    console.error("[sebi-sync] SEBI_SYNC_SECRET is not set — refusing to run (would otherwise be an unauthenticated public endpoint).");
    return NextResponse.json({ error: "Not configured." }, { status: 503 });
  }
  if (provided !== secret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const admin = createAdminClient();
  const results = [];
  const errors: string[] = [];

  for (const categoryKey of Object.keys(SEBI_CATEGORIES) as (keyof typeof SEBI_CATEGORIES)[]) {
    try {
      const result = await syncSebiCategory(admin, categoryKey);
      results.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[sebi-sync] category "${categoryKey}" failed:`, err);
      errors.push(`${categoryKey}: ${message}`);
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    results,
    errors,
    finished_at: new Date().toISOString(),
  });
}
