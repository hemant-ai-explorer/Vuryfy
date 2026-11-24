import crypto from "crypto";
import { search, type SearchResult } from "@/lib/search-gateway";
import { callStructured } from "@/lib/ai-gateway";
import { runDeepInvestigation } from "@/lib/deep-investigation";
import { SUPPORTED_LANGUAGES, LANGUAGE_NAMES, type Language } from "@/lib/translations";

// SUPPORTED_LANGUAGES is an array of {code, label, nativeLabel} (see
// lib/translations.ts) — this file only ever needs the bare codes.
const LANGUAGE_CODES: Language[] = SUPPORTED_LANGUAGES.map((l) => l.code);

// Spelled out explicitly for the localization prompt below rather than
// relying on the model already knowing what every one of these codes
// means — cheap insurance against e.g. "mr" being misread as something
// other than Marathi.
const LANGUAGE_CODE_LEGEND = LANGUAGE_CODES.map((code) => `${code} = ${LANGUAGE_NAMES[code]}`).join(", ");

// Daily Check pipeline — Nov 21, 2026. See
// supabase/migrations/0026_daily_checks.sql's header for the full
// rationale. Two deliberate design choices, both direct extensions of
// this app's existing anti-hallucination principles (Part 19) rather
// than anything new:
//
// 1. Topic discovery is a real search step, never an LLM asked "what's
//    trending" from its own knowledge — the same "search decides what
//    the model sees, the model never free-associates evidence" rule
//    Part 11 already locked for every other pipeline in this app. A
//    second AI call then has to point at a SPECIFIC item actually
//    present in those real search results, or it must say so isn't
//    found — see pickCredibleTopic() below.
//
// 2. "Write a one-paragraph article" is not a separate generation step
//    at all — it's the summary field the existing, evidence-grounded
//    runDeepInvestigation() pipeline already produces for any claim
//    submitted by a real user. Reusing it means the daily content is
//    cited and grounded by construction, and it means this file adds
//    zero new verdict/evidence logic to maintain.
//
// Fails closed throughout: if a credible topic can't be found, or the
// investigation itself comes back with no real evidence behind it,
// buildDailyCheck() returns null and the caller (app/api/cron/daily-
// check/route.ts) simply skips publishing that day — never forces out a
// weak or invented entry to keep a streak alive. This is the one rule
// the user was explicit about: "if it can't find a credible real topic
// then skip it."

export interface DailyCheckBuild {
  slug: string;
  claim: string;
  verdict: string;
  confidence: number;
  headline: Record<string, string>;
  summary: Record<string, string>;
  teaser: Record<string, string>;
  caveats: Record<string, string[]>;
  sources: { title: string; url: string }[];
}

const TOPIC_SEARCH_QUERIES = [
  "viral scam WhatsApp forward India this week",
  "fraud alert trending India news today",
  "fact check viral claim India today",
  "new UPI payment scam India reported",
];

interface TopicCandidate {
  found: boolean;
  claim: string | null;
  reason: string;
}

const TOPIC_SCHEMA = {
  type: "object",
  properties: {
    found: { type: "boolean" },
    claim: { type: "string" },
    reason: { type: "string" },
  },
  required: ["found", "claim", "reason"],
};

const TOPIC_SYSTEM_PROMPT = `You are choosing today's topic for Vuryfy's "Daily Check" — one real, currently-circulating scam or misinformation claim that Vuryfy will investigate and publish. You are given a numbered list of real web search results from today's queries.

Your job: find ONE specific, nameable claim that is clearly attested in the search results below — a particular scam pattern, a particular viral forward, a particular fraudulent scheme — not a vague category ("scams happen on WhatsApp"). It must be something a reader could meaningfully fact-check, phrased as a single plain claim sentence (the way a user would type it into Vuryfy themselves), e.g. "A message claiming SBI is giving ₹50,000 to every account holder for Republic Day is circulating on WhatsApp."

If NONE of the search results below actually name a specific, checkable claim — only generic chatter, old/stale items, or nothing relevant — set found to false and claim to null. Do not invent a plausible-sounding scam that isn't actually supported by the search results; it is completely fine, and expected some days, to find nothing. Explain your decision briefly in "reason" either way.`;

function buildTopicPrompt(results: SearchResult[]): string {
  if (results.length === 0) {
    return "No search results were returned at all today.";
  }
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\nSource: ${r.source}\nPublished: ${r.published_at ?? "unknown"}\nExcerpt: ${r.snippet}`)
    .join("\n\n");
}

async function pickCredibleTopic(): Promise<string | null> {
  const perQueryResults = await Promise.all(
    TOPIC_SEARCH_QUERIES.map((q) =>
      search(q, "daily-check.topic-search", { maxResults: 6 }).catch((err) => {
        console.error("[daily-check] topic search failed for query:", q, err);
        return [] as SearchResult[];
      })
    )
  );

  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const results of perQueryResults) {
    for (const r of results) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      merged.push(r);
    }
  }

  if (merged.length === 0) {
    console.log("[daily-check] no search results at all today — skipping.");
    return null;
  }

  try {
    const { data } = await callStructured<TopicCandidate>({
      tier: "cheap",
      systemPrompt: TOPIC_SYSTEM_PROMPT,
      userPrompt: buildTopicPrompt(merged),
      responseSchema: TOPIC_SCHEMA,
      callSite: "daily-check.pick-topic",
    });
    if (!data.found || typeof data.claim !== "string" || !data.claim.trim()) {
      console.log("[daily-check] no credible topic found today:", data.reason);
      return null;
    }
    return data.claim.trim();
  } catch (err) {
    console.error("[daily-check] topic-selection call failed — skipping today:", err);
    return null;
  }
}

interface LocalizedEntry {
  headline: string;
  summary: string;
  teaser: string;
  caveats: string[];
}

function localizationSchema() {
  const properties: Record<string, unknown> = {};
  for (const lang of LANGUAGE_CODES) {
    properties[lang] = {
      type: "object",
      properties: {
        headline: { type: "string" },
        summary: { type: "string" },
        teaser: { type: "string" },
        caveats: { type: "array", items: { type: "string" } },
      },
      required: ["headline", "summary", "teaser", "caveats"],
    };
  }
  return {
    type: "object",
    properties,
    required: [...LANGUAGE_CODES],
  };
}

function buildLocalizeSystemPrompt(): string {
  return `You are preparing Vuryfy's published Daily Check for display in 9 languages. You are given a claim that Vuryfy's Deep Investigation engine already investigated, plus the verdict, confidence, English explanation, and English caveats it already produced from real evidence. Do NOT change the verdict, do NOT add any new claim or evidence beyond what is given — your only job is to adapt, translate, and (for "teaser" only) condense.

For EACH of these language codes — ${LANGUAGE_CODE_LEGEND} — produce:
- "headline": one short, plain, accurate sentence (well under 100 characters) in that language, naming what was checked and the verdict. This is what gets sent as a WhatsApp message header, so it must be immediately clear on its own, with no jargon.
- "summary": the given English explanation, naturally and fluently adapted into that language (same meaning and level of detail — not shortened, not embellished). This is shown in full on the /today page, never in the WhatsApp message itself.
- "teaser": ONE short line (under 140 characters) in that language that gives someone a real reason to tap through and read the full explanation — e.g. why this matters, how widely it's spreading, or what's at stake if someone believes it. This is what actually gets sent as the WhatsApp message's second line, so it must NOT explain the reasoning or summarize the evidence (that would remove any reason to click the link) and must NOT just restate the headline's verdict. Think of it as a hook, not an answer.
- "caveats": the given English caveats list, translated into that language in the same order. Return an empty array if the given caveats list is empty.

For "en" itself, "summary" and "caveats" should carry the given English text through essentially unchanged (fix only obvious grammar if needed) — you still need to write its "headline" and "teaser".`;
}

function buildSlug(claim: string): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const base = claim
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join("-");
  const shortHash = crypto.createHash("sha1").update(claim).digest("hex").slice(0, 6);
  return `${date}-${base || "check"}-${shortHash}`.slice(0, 120);
}

// Main entry point. Returns null (never throws for an expected "nothing
// credible today" outcome) when the pipeline should skip publishing.
export async function buildDailyCheck(): Promise<DailyCheckBuild | null> {
  const claim = await pickCredibleTopic();
  if (!claim) return null;

  let investigation;
  try {
    investigation = await runDeepInvestigation(claim, "en");
  } catch (err) {
    console.error("[daily-check] Deep Investigation failed — skipping today:", err);
    return null;
  }

  // Same "don't manufacture a verdict from nothing" guard Deep
  // Investigation already applies internally (see its own zero-evidence
  // early return) — belt-and-suspenders here specifically because this
  // path publishes without any human reviewing it first, unlike every
  // normal user-submitted investigation.
  if (!investigation.sources || investigation.sources.length === 0) {
    console.log("[daily-check] Deep Investigation found no real evidence for today's topic — skipping.");
    return null;
  }

  let localized: Record<string, LocalizedEntry>;
  try {
    const { data } = await callStructured<Record<string, LocalizedEntry>>({
      tier: "cheap",
      systemPrompt: buildLocalizeSystemPrompt(),
      userPrompt: `Claim: "${claim}"\nVerdict: ${investigation.verdict}\nConfidence: ${investigation.confidence}\nEnglish explanation: ${investigation.summary}\nEnglish caveats: ${JSON.stringify(investigation.caveats)}`,
      responseSchema: localizationSchema(),
      callSite: "daily-check.localize",
    });
    localized = data;
  } catch (err) {
    console.error("[daily-check] localization call failed — skipping today:", err);
    return null;
  }

  const headline: Record<string, string> = {};
  const summary: Record<string, string> = {};
  const teaser: Record<string, string> = {};
  const caveats: Record<string, string[]> = {};
  for (const lang of LANGUAGE_CODES) {
    const entry = localized[lang];
    if (!entry || typeof entry.headline !== "string" || typeof entry.summary !== "string" || typeof entry.teaser !== "string") {
      console.error(`[daily-check] localization missing/malformed for "${lang}" — skipping today rather than publishing a partial entry.`);
      return null;
    }
    headline[lang] = entry.headline.trim();
    summary[lang] = entry.summary.trim();
    teaser[lang] = entry.teaser.trim();
    caveats[lang] = Array.isArray(entry.caveats) ? entry.caveats.filter((c) => typeof c === "string" && c.trim()) : [];
  }

  return {
    slug: buildSlug(claim),
    claim,
    verdict: investigation.verdict,
    confidence: investigation.confidence,
    headline,
    summary,
    teaser,
    caveats,
    sources: investigation.sources,
  };
}
