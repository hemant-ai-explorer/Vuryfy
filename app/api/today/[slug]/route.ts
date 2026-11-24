import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { isSupportedLanguage } from "@/lib/translations";

// Public Daily Check detail route — Nov 21, 2026. Deliberately NO auth
// check at all, unlike every other /api/verifications-style route in
// this app: a forwarded WhatsApp link (see lib/daily-check.ts) may land
// on someone who has never opened Vuryfy, so this has to work for a
// genuinely anonymous visitor. That's also exactly why this content
// lives in its own daily_checks table instead of reusing `verifications`
// (which holds real per-user results behind auth) — see
// supabase/migrations/0026_daily_checks.sql's header.
//
// RLS on daily_checks already allows anon/authenticated SELECT where
// published_at <= now() (same migration), so this could go through the
// anon client directly — using the admin client here instead only for
// consistency with every other route in this codebase, which all read
// through it; there is no private data in this table to protect either
// way.
export async function GET(request: Request, context: { params: Promise<{ slug: string }> }) {
  const { slug } = await context.params;
  const { searchParams } = new URL(request.url);
  const requestedLang = searchParams.get("lang");
  const lang = isSupportedLanguage(requestedLang) ? requestedLang : "en";

  const admin = createAdminClient();
  const { data: row, error } = await admin
    .from("daily_checks")
    .select("slug, claim, verdict, confidence, headline, summary, teaser, caveats, sources, published_at")
    .eq("slug", slug)
    .lte("published_at", new Date().toISOString())
    .maybeSingle();

  if (error) {
    console.error("[api/today] lookup failed:", error);
    return NextResponse.json({ error: "Could not load this check." }, { status: 500 });
  }
  if (!row) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const headlineMap = (row.headline ?? {}) as Record<string, string>;
  const summaryMap = (row.summary ?? {}) as Record<string, string>;
  const teaserMap = (row.teaser ?? {}) as Record<string, string>;
  const caveatsMap = (row.caveats ?? {}) as Record<string, string[]>;

  return NextResponse.json({
    slug: row.slug,
    claim: row.claim,
    verdict: row.verdict,
    confidence: row.confidence,
    headline: headlineMap[lang] ?? headlineMap.en ?? "",
    summary: summaryMap[lang] ?? summaryMap.en ?? "",
    teaser: teaserMap[lang] ?? teaserMap.en ?? "",
    caveats: caveatsMap[lang] ?? caveatsMap.en ?? [],
    sources: row.sources ?? [],
    published_at: row.published_at,
    language: lang,
  });
}
