// SEBI intermediary registration check — Nov 20, 2026.
//
// Added directly off the "what other feature can help people from being
// scammed" discussion: I4C/NCRP data shows investment/trading scams are
// ~76-77% of all reported cyber-fraud losses in India, far ahead of every
// other category, and the primary trust hook these scams use is a fake
// "SEBI-registered research analyst/investment adviser" claim. This file
// lets a user check whether a name or registration number is genuinely
// SEBI-registered.
//
// Unlike lib/vpa-registered-name.ts (the UPI-payee-name feature), this
// needs NO vendor relationship and NO RBI/SEBI/IRDAI license for Vuryfy
// itself — it reads SEBI's own public registry directly. That registry
// has no official public API, so this calls an internal AJAX endpoint
// SEBI's own search page (sebi.gov.in/.../search-intm.html) uses,
// reverse-engineered Nov 20, 2026 via the browser's network tab — see
// claude/scam-feature-sebi-check-2026-11-20.md (Vuryfy project notes) for
// the full feasibility writeup. This is NOT a documented/contractual API:
// it could change without notice, so syncSebiCategory() is written to
// fail loudly (not silently) if SEBI's response shape changes.
//
// Architecture: a nightly-ish sync (triggered via
// app/api/admin/sebi-sync/route.ts) pages through SEBI's registry and
// upserts into the local `sebi_intermediaries` table
// (supabase/migrations/0024_sebi_intermediaries.sql). User-facing lookups
// (app/api/sebi-check/route.ts) query that local table only — never a
// live SEBI call per user request, both for latency and so Vuryfy's own
// traffic never hammers SEBI's site on every user check.
//
// Categories: SEBI's registration-number prefix self-identifies the
// category (INA = Investment Adviser, INH = Research Analyst, INZ =
// Stockbroker). Only Investment Adviser (intmId 13) and Research Analyst
// (intmId 14) are wired up for now — the two categories fake "SEBI
// registered" trading-tip scams actually impersonate. Stockbroker
// segments (intmId 30/31/32/37/38) use the identical endpoint/response
// shape and could be added the same way later.

import type { SupabaseClient } from "@supabase/supabase-js";

const SEBI_SEARCH_URL = "https://www.sebi.gov.in/sebiweb/ajax/department/getsearchintminfo.jsp";
const SEBI_DEPT_ID = "14"; // MIRSD — constant across all categories tested.
const PAGE_SIZE = 25; // confirmed from SEBI's own response, not configurable on our side.

export const SEBI_CATEGORIES = {
  investment_adviser: { intmId: "13", label: "Investment Adviser" },
  research_analyst: { intmId: "14", label: "Research Analyst" },
} as const;

type CategoryKey = keyof typeof SEBI_CATEGORIES;

interface ParsedRecord {
  name: string;
  regNo: string;
  category: string;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  address: string | null;
  phone: string | null;
  email: string | null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#64;/g, "@")
    .replace(/&#46;/g, ".")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .trim();
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
}

// Parses SEBI's raw HTML-fragment response into field maps, one per
// result card. Deliberately tolerant of field order and which fields are
// present (Investment Adviser cards include Phone/Email, Research
// Analyst cards don't) — keys it on the <span>FieldName</span> label SEBI
// itself renders rather than position, so a markup change that adds/drops
// a field doesn't silently misalign the rest.
function parseRecords(html: string, categoryLabel: string): ParsedRecord[] {
  const blocks = html.split("<div class='fixed-table-body card-table'>").slice(1);
  const records: ParsedRecord[] = [];

  const fieldRe = /<div class='title'><span>([^<]+)<\/span><\/div>\s*<div class='value[^']*'>([\s\S]*?)<\/div>\s*<\/div>/g;

  for (const block of blocks) {
    const fields: Record<string, string> = {};
    let m: RegExpExecArray | null;
    fieldRe.lastIndex = 0;
    while ((m = fieldRe.exec(block))) {
      fields[m[1].trim()] = stripTags(m[2]);
    }

    const name = fields["Name"];
    const regNo = fields["Registration No."];
    if (!name || !regNo) continue; // malformed card — skip rather than insert a half-record.

    let validFrom: string | null = null;
    let validTo: string | null = null;
    let isActive = true;
    const dateField = fields["Date"];
    if (dateField) {
      const parts = dateField.split(/\s+to\s+/i);
      validFrom = parts[0]?.trim() || null;
      const end = parts[1]?.trim();
      if (end && end.toUpperCase() !== "NA") {
        validTo = end;
        isActive = false;
      }
    }

    records.push({
      name,
      regNo,
      category: fields["Type"] || categoryLabel,
      validFrom,
      validTo,
      isActive,
      address: fields["Address"] || null,
      phone: fields["Phone"] || null,
      email: fields["Email"] || null,
    });
  }

  return records;
}

async function fetchPage(intmId: string, nextValue: number, next: "s" | "n"): Promise<string> {
  const body = new URLSearchParams({
    nextValue: String(nextValue),
    next,
    fromDate: "",
    toDate: "",
    deptId: SEBI_DEPT_ID,
    intmId,
    name: "",
    regNo: "",
    exchanges: "",
    affiliated: "",
  });

  const response = await fetch(SEBI_SEARCH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      // Nov 20, 2026 follow-up: a plain server-side fetch (no Referer/
      // Origin, no page-load cookies) got HTTP 530 from SEBI's edge even
      // though every parameter was identical to a request made by a real
      // browser tab on sebi.gov.in itself, which succeeded. That strongly
      // points to a WAF/bot rule keyed on Referer/Origin rather than on
      // this being a non-browser client per se — so these two headers,
      // matching what a real page load on SEBI's own search page would
      // send, are load-bearing, not cosmetic. If SEBI's edge rules change
      // again, this is the first place to look.
      "accept": "text/html, */*; q=0.01",
      "accept-language": "en-US,en;q=0.9",
      // Deliberately the bare homepage, not a guessed search-page URL —
      // this is the exact Referer value verified to work during live
      // testing (a same-origin fetch from https://www.sebi.gov.in/
      // itself), not an assumption about which page the WAF expects.
      "referer": "https://www.sebi.gov.in/",
      "origin": "https://www.sebi.gov.in",
      "x-requested-with": "XMLHttpRequest",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(20_000),
  });

  if (!response.ok) {
    throw new Error(`SEBI search returned HTTP ${response.status}`);
  }
  return await response.text();
}

export interface SyncResult {
  category: string;
  totalRecords: number;
  pagesFetched: number;
  upserted: number;
}

// Pages through one full SEBI category and upserts every record into
// sebi_intermediaries. Deliberately sequential (not parallel) and
// throttled between pages — basic etiquette toward a government server
// that offered no documented rate limit, not an attempt to be fast.
//
// Pagination mechanics (reverse-engineered, confirmed Nov 20 2026): page
// 1 is next="s" (nextValue is ignored by SEBI's own JS in this case, sent
// as 1 here for clarity); every page after that is next="n" with
// nextValue = (pageNumber - 1). Confirmed non-overlapping, sequential
// 25-record pages against real data before this was written.
export async function syncSebiCategory(
  admin: SupabaseClient,
  categoryKey: CategoryKey
): Promise<SyncResult> {
  const { intmId, label } = SEBI_CATEGORIES[categoryKey];

  const firstPageHtml = await fetchPage(intmId, 1, "s");
  const totalMatch = firstPageHtml.match(/(\d+)\s+to\s+(\d+)\s+of\s+(\d+)\s+records/);
  const noRecords = /No record\(s\) available/i.test(firstPageHtml);

  if (noRecords) {
    console.error(`[sebi-check] sync for ${label}: SEBI returned "No record(s) available" for an unfiltered category query — this is almost certainly a sign SEBI's page/params changed, not that the category is genuinely empty. Aborting this category's sync without touching existing cached rows.`);
    return { category: label, totalRecords: 0, pagesFetched: 0, upserted: 0 };
  }

  if (!totalMatch) {
    throw new Error(
      `[sebi-check] sync for ${label}: couldn't find the "X to Y of Z records" marker in SEBI's response — the page format likely changed. Aborting without touching existing cached rows. First 500 chars: ${firstPageHtml.slice(0, 500)}`
    );
  }

  const totalRecords = parseInt(totalMatch[3], 10);
  const totalPages = Math.ceil(totalRecords / PAGE_SIZE);

  let upserted = 0;
  let pagesFetched = 0;
  let allRecords: ParsedRecord[] = parseRecords(firstPageHtml, label);
  pagesFetched = 1;

  for (let page = 2; page <= totalPages; page++) {
    // Gentle pacing — not a documented requirement, just not hammering a
    // government server that has no published rate limit.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const html = await fetchPage(intmId, page - 1, "n");
    const records = parseRecords(html, label);
    if (records.length === 0) {
      console.error(`[sebi-check] sync for ${label}: page ${page} parsed to 0 records (expected up to ${PAGE_SIZE}) — stopping early rather than risking a bad/empty upsert loop. Synced ${allRecords.length}/${totalRecords} so far.`);
      break;
    }
    allRecords = allRecords.concat(records);
    pagesFetched++;
  }

  // Upsert in batches rather than one giant call.
  const BATCH = 200;
  for (let i = 0; i < allRecords.length; i += BATCH) {
    const batch = allRecords.slice(i, i + BATCH).map((r) => ({
      reg_no: r.regNo,
      name: r.name,
      category: r.category,
      valid_from: r.validFrom,
      valid_to: r.validTo,
      is_active: r.isActive,
      address: r.address,
      phone: r.phone,
      email: r.email,
      synced_at: new Date().toISOString(),
    }));
    const { error } = await admin.from("sebi_intermediaries").upsert(batch, { onConflict: "reg_no" });
    if (error) {
      console.error(`[sebi-check] sync for ${label}: upsert failed for batch starting at index ${i}:`, error);
    } else {
      upserted += batch.length;
    }
  }

  return { category: label, totalRecords, pagesFetched, upserted };
}

export interface SebiLookupMatch {
  regNo: string;
  name: string;
  category: string;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  address: string | null;
  phone: string | null;
  email: string | null;
  syncedAt: string;
}

export interface SebiLookupResult {
  matches: SebiLookupMatch[];
  syncedAt: string | null; // null means the local table is completely empty (sync never ran).
}

// Looks up the LOCAL cached table only — see file header for why this is
// deliberately not a live SEBI call. Exact registration-number search
// takes priority; falls back to a case-insensitive partial name match
// (capped at 10 results) when no regNo is given.
export async function lookupSebiIntermediary(
  admin: SupabaseClient,
  query: { name?: string; regNo?: string }
): Promise<SebiLookupResult> {
  const regNo = query.regNo?.trim().toUpperCase();
  const name = query.name?.trim();

  let rows: any[] = [];
  if (regNo) {
    const { data } = await admin.from("sebi_intermediaries").select("*").eq("reg_no", regNo).limit(1);
    rows = data || [];
  } else if (name) {
    const { data } = await admin
      .from("sebi_intermediaries")
      .select("*")
      .ilike("name", `%${name}%`)
      .order("is_active", { ascending: false })
      .limit(10);
    rows = data || [];
  }

  // Freshness signal independent of whether THIS query matched anything —
  // lets the UI say "as of our last sync on [date]" even on a miss.
  const { data: mostRecent } = await admin
    .from("sebi_intermediaries")
    .select("synced_at")
    .order("synced_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return {
    matches: rows.map((r) => ({
      regNo: r.reg_no,
      name: r.name,
      category: r.category,
      validFrom: r.valid_from,
      validTo: r.valid_to,
      isActive: r.is_active,
      address: r.address,
      phone: r.phone,
      email: r.email,
      syncedAt: r.synced_at,
    })),
    syncedAt: mostRecent?.synced_at || null,
  };
}
