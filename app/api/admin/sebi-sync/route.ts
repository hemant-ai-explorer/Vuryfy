import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncSebiCategory, SEBI_CATEGORIES } from "@/lib/sebi-check";

// Route-level execution budget. Nov 20, 2026: extended from the original
// 2 categories (Investment Adviser + Research Analyst, ~3,476 records) to
// 8, adding 6 stockbroker segments (~16,450 more records) — prompted by
// "Zerodha" (a completely legitimate, well-known broker) returning "No
// match" against the old 2-category-only cache. Looping all 8 in one
// call would be ~797 pages at ~400ms apart plus fetch latency — likely
// 10+ minutes, well past any Vercel timeout. So `category` (see below)
// lets a caller sync ONE category per request; the worst single category
// (equity segment stockbrokers, ~208 pages) stays comfortably under 300s
// even on its own. 300 is still comfortably under Vercel's Pro-plan max
// (900s) for a single category; bump the Vercel plan/limit if a future
// category is ever large enough to need more.
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
// automating. When that happens, it should be one Cron entry PER
// category (see `category` below), not one entry looping all 8 — same
// reasoning as the maxDuration comment above.
//
// Optional `?category=<key>` query param (a key from SEBI_CATEGORIES,
// e.g. `stockbroker_equity`) syncs just that one category. Omit it to
// loop every category in one call — convenient for local testing (no
// server-side timeout there), but NOT how this should be called once
// deployed behind Vercel's execution limit; see the maxDuration comment.
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

  const { searchParams } = new URL(request.url);
  const requestedCategory = searchParams.get("category");
  if (requestedCategory && !(requestedCategory in SEBI_CATEGORIES)) {
    return NextResponse.json(
      { error: `Unknown category "${requestedCategory}". Valid keys: ${Object.keys(SEBI_CATEGORIES).join(", ")}` },
      { status: 400 }
    );
  }
  const categoryKeys = (
    requestedCategory
      ? [requestedCategory]
      : (Object.keys(SEBI_CATEGORIES) as string[])
  ) as (keyof typeof SEBI_CATEGORIES)[];

  const admin = createAdminClient();
  const results = [];
  const errors: string[] = [];

  for (const categoryKey of categoryKeys) {
    try {
      const result = await syncSebiCategory(admin, categoryKey);
      results.push(result);
      // A category can "succeed" (no thrown error) while still dropping
      // rows — e.g. one or more upsert batches failed partway through.
      // Surface that here too, not just in server logs, so a caller can't
      // mistake ok:true for "every record landed."
      if (result.failedBatches > 0) {
        errors.push(
          `${categoryKey}: ${result.failedBatches} batch(es) failed to upsert — only ${result.upserted}/${result.totalRecords} records saved. Check server logs for the underlying Postgres error.`
        );
      }
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
