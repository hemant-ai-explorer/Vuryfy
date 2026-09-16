import { search, type SearchResult } from "@/lib/search-gateway";
import { callStructured } from "@/lib/ai-gateway";
import { translate, LANGUAGE_NAMES, type Language } from "@/lib/translations";

// Quick Check pipeline (Part 26.4, LOCKED): normalize -> search -> evaluate
// evidence -> verdict. AI call count is 0 or 1 here (0 if search returns
// nothing worth reasoning over, 1 otherwise) — deliberately thin for V1;
// the multi-call complexity classification/escalation logic Part 26.4
// describes is deferred until there's real usage data to justify it.
//
// Evidence grounding (Part 19, LOCKED — "the reasoning model may only cite
// sources the Research Engine actually retrieved; if evidence it wants
// isn't present, it must mark it as missing rather than filling the gap"):
// the model never handles real URLs. It refers to evidence only by the
// numeric id we assign to each retrieved source, and code resolves ids
// back to the real, retrieved source objects afterward — any id outside
// the retrieved set is silently dropped rather than trusted. This is the
// code-enforced half of the anti-hallucination safeguard Part 19 calls
// for; the system prompt below is the other half.
//
// normalizeClaim and ENGINE_VERSION are exported (Sept 14, 2026 addition)
// so app/api/verify/route.ts and lib/verification-cache.ts can compute the
// exact same exact-match cache key this module uses internally, without
// duplicating the normalization logic.
//
// "Scam" verdict (Sept 2026 addition): added as a fifth verdict alongside
// True/False/Misleading/Unverified specifically so a link found to be a
// phishing site, fraud operation, or scam is surfaced distinctly from a
// merely-incorrect claim — the result page gives "Scam" its own red
// warning card (see app/result/page.tsx) rather than blending it into a
// plain "False". This applies to any claim through this pipeline, not
// just QR-sourced links — QR just happens to decode into links often, and
// a scam link is a scam link regardless of how it was submitted.
//
// Same grounding rule as every other verdict (Part 19): the model may
// ONLY pick "Scam" when the retrieved evidence itself specifically names
// or identifies THIS exact link/domain/entity — a scam/phishing report,
// a fraud-database entry, news coverage, a pattern of user complaints
// about it by name — never from the domain merely "looking suspicious"
// with no supporting evidence. That mirrors the lesson from the real UPI
// QR test earlier in this project: an unverifiable heuristic guess about
// legitimacy causes exactly the reputational harm this system exists to
// avoid. A claim with no scam-specific evidence falls back to Unverified,
// same as always — a brand-new phishing link with zero web footprint yet
// won't be caught by an evidence-grounded system, and that's an accepted
// limitation, not a bug.
//
// Prompt tightened Sept 2026 after test-branch testing surfaced a real
// false-positive: a fabricated domain like
// "secure-paypal-verification-account-limited.tk" got a confident "Scam"
// verdict even though no retrieved evidence mentioned that domain at
// all — the model inferred it from generic "how PayPal phishing scams
// work" articles plus the claim text's own brand-adjacent, threatening
// wording. That's exactly the same category of unverifiable-heuristic
// harm the grounding rule exists to prevent, just reached a different
// way, so the instruction below now explicitly requires the evidence to
// be about this specific link/domain/entity, not merely the same general
// scam category or brand.

export interface QuickCheckEvidence {
  title: string;
  url: string;
  publisher?: string;
  snippet?: string;
}

export interface QuickCheckResult {
  verdict: string;
  confidence: number;
  summary: string;
  key_evidence: QuickCheckEvidence[];
  sources: { title: string; url: string }[];
  engine_version: string;
}

export const ENGINE_VERSION = "v1-gemini-tavily";
const VALID_VERDICTS = ["True", "False", "Misleading", "Unverified", "Scam"];

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VALID_VERDICTS },
    confidence: { type: "integer" },
    summary: { type: "string" },
    contradiction_level: { type: "string", enum: ["none", "low", "medium", "high"] },
    cited_evidence_ids: { type: "array", items: { type: "integer" } },
    missing_information: { type: "array", items: { type: "string" } },
  },
  required: [
    "verdict",
    "confidence",
    "summary",
    "contradiction_level",
    "cited_evidence_ids",
    "missing_information",
  ],
};

interface VerdictOutput {
  verdict: string;
  confidence: number;
  summary: string;
  contradiction_level: string;
  cited_evidence_ids: number[];
  missing_information: string[];
}

const SYSTEM_PROMPT = `You are Vuryfy's claim-verification engine. You are given a claim and a numbered list of evidence excerpts retrieved by a search system. Your job:
- Decide a verdict: "True", "False", "Misleading", "Unverified", or "Scam".
- Use "Scam" only when the evidence specifically names or identifies THIS claim's exact link, domain, or entity as a scam, phishing site, or fraud operation — a report, blocklist entry, news article, or complaint that is actually about this specific link/domain/entity, not merely about the same general category or brand. Evidence that only describes how this type of scam usually works in general (e.g. a generic guide to phishing tactics, or an article about scams impersonating the same brand without naming this exact domain) is NOT sufficient on its own — that case is "Unverified", not "Scam", even if the claim's own wording sounds exactly like a textbook phishing attempt. Never choose "Scam" from the link or claim merely looking suspicious, unfamiliar, unofficial, or brand-adjacent with no evidence specifically about it — a confident false accusation is worse than an unresolved one.
- For anything that is simply incorrect information but not a deliberate scam/fraud attempt, use "False" or "Misleading" as appropriate, not "Scam".
- You may ONLY use the numbered evidence provided below — never rely on outside knowledge, and never invent a source. If the evidence is thin, outdated, or contradicts itself, prefer "Unverified" over guessing.
- confidence is 0-100 and must reflect how well the evidence actually supports the verdict — weak or single-source evidence should never produce a high confidence score.
- cited_evidence_ids must contain ONLY the bracketed numbers of evidence you actually relied on. Never include a number that wasn't given to you.
- missing_information should list what additional evidence would be needed to verify this claim more confidently, if anything is missing.
- summary should be 1-3 concise sentences a general reader can understand, explaining the verdict in plain language.
Respond with only the requested JSON — no extra commentary, no markdown.`;

// Output localization — Phase 1 of Part 11's locked multilingual design
// (Sept 16, 2026, see lib/translations.ts's header for the full rationale
// and current language coverage). Research and evidence retrieval stay
// entirely in English regardless of the user's language (Part 11: "user
// language -> canonical internal claim representation -> verification
// (language-independent evidence engine) -> localized output") — only the
// free-text `summary` field this model produces gets localized, via a
// plain instruction appended to the system prompt rather than a second
// translation pass, so there's no extra AI call or extra latency for this.
// Evidence titles/snippets/URLs are never touched — those are direct
// excerpts from real sources and translating them would misrepresent what
// was actually found.
function languageInstruction(language: Language): string {
  if (language === "en") return "";
  return `\n\nWrite the "summary" field in natural, fluent ${LANGUAGE_NAMES[language]}. Do not translate the claim itself, evidence titles, source names, or URLs — leave those exactly as given.`;
}

export function normalizeClaim(raw: string): string {
  return raw.trim().replace(/\s+/g, " ").slice(0, 2000);
}

function buildEvidenceBlock(results: SearchResult[]): string {
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\nSource: ${r.source}\nURL: ${r.url}\nExcerpt: ${r.snippet}`)
    .join("\n\n");
}

export async function runQuickCheck(claimRaw: string, language: Language = "en"): Promise<QuickCheckResult> {
  const claim = normalizeClaim(claimRaw);

  const results = await search(claim, { maxResults: 6 });
  const sources = results.map((r) => ({ title: r.title, url: r.url }));

  // Evidence threshold (Part 26.4, LOCKED): don't manufacture a confident
  // verdict from nothing. Zero search results -> skip the AI call entirely
  // (saves a call) and return a clearly-labeled insufficient-evidence
  // result rather than letting the model guess without grounding.
  if (results.length === 0) {
    return {
      verdict: "Unverified",
      confidence: 0,
      summary: translate(language, "pipeline.noEvidenceQuick"),
      key_evidence: [],
      sources: [],
      engine_version: ENGINE_VERSION,
    };
  }

  const userPrompt = `Claim to verify:\n"${claim}"\n\nEvidence:\n${buildEvidenceBlock(results)}`;

  const { data } = await callStructured<VerdictOutput>({
    tier: "cheap",
    systemPrompt: SYSTEM_PROMPT + languageInstruction(language),
    userPrompt,
    responseSchema: VERDICT_SCHEMA,
  });

  const citedIds = Array.isArray(data.cited_evidence_ids) ? data.cited_evidence_ids : [];
  const keyEvidence: QuickCheckEvidence[] = citedIds
    .filter((id) => Number.isInteger(id) && id >= 1 && id <= results.length)
    .map((id) => {
      const r = results[id - 1];
      return { title: r.title, url: r.url, publisher: r.source, snippet: r.snippet };
    });

  const verdict = VALID_VERDICTS.includes(data.verdict) ? data.verdict : "Unverified";
  const confidence = Number.isFinite(data.confidence) ? Math.max(0, Math.min(100, Math.round(data.confidence))) : 0;
  const summary =
    typeof data.summary === "string" && data.summary.trim()
      ? data.summary.trim()
      : translate(language, "pipeline.noEvidenceQuick");

  return {
    verdict,
    confidence,
    summary,
    key_evidence: keyEvidence,
    sources,
    engine_version: ENGINE_VERSION,
  };
}
