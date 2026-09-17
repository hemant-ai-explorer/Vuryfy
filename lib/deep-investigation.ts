import { search, type SearchResult } from "@/lib/search-gateway";
import { callStructured } from "@/lib/ai-gateway";
import { normalizeClaim, type QuickCheckEvidence } from "@/lib/quick-check";
import { translate, LANGUAGE_NAMES, type Language } from "@/lib/translations";

// Deep Investigation pipeline (Part 11 routing logic + Part 26.5, LOCKED
// shape carried over from the old FastAPI reference implementation):
// cheap model (decompose) -> search/evidence collection (per sub-question,
// in parallel) -> reasoning-tier model (synthesize + contradiction
// analysis) -> verdict.
//
// Architecture note (Sept 14, 2026): the previously-open question of how
// to run a long-lived job on Vercel's serverless functions turned out not
// to apply here. Investigated a background-job/polling architecture (the
// old FastAPI reference used BackgroundTasks + a status-polling endpoint,
// and Vercel's Fluid Compute now gives Hobby-plan functions a 300s
// duration budget, confirmed enabled on this project, which would have
// made an after()-based background job workable with no new
// infrastructure) -- but the user wants Deep Investigation to complete in
// well under 30 seconds, not minutes. A 2-AI-call, parallel-search pipeline
// comfortably fits that target, so Deep Investigation runs as a single
// synchronous request/response, exactly like Quick Check's shape (see
// app/api/deep/route.ts) -- no job table, no polling, no background
// execution. This also means the schema/job-model plumbing the old
// reference implementation had (DeepInvestigation job rows with
// status/current_step/progress) was deliberately NOT carried over; only
// the final result shape was.
//
// Evidence grounding (Part 19, same anti-hallucination safeguard as
// quick-check.ts): the reasoning model never handles real URLs, only
// numeric ids into the retrieved evidence pool; any id outside that pool
// is silently dropped rather than trusted.
//
// "Scam" verdict (Sept 2026 addition): same fifth verdict added to
// quick-check.ts, added here too so Deep Investigation results get the
// same distinct red warning treatment (app/result/page.tsx) instead of
// blending a scam link into a plain "False". Same grounding rule applies
// unchanged, including the Sept 2026 tightening (see quick-check.ts for
// the full story): the evidence must specifically name or identify this
// exact link/domain/entity, not just the same general scam category or
// brand — testing surfaced a fabricated PayPal-phishing-style domain
// getting a confident "Scam" from generic "how PayPal phishing works"
// evidence alone, with nothing about that specific domain.

// Sept 15, 2026: bumped v1 -> v2 — same reasoning as video-analysis.ts's
// identical bump on VIDEO_DEEP_ENGINE_VERSION this same day: the model
// behind "reasoning" tier changed (ai-gateway.ts's modelForTier), and
// leaving this unchanged would keep serving pre-change cached verdicts
// out of the exact-match cache indefinitely, since cache entries are keyed
// on this string (see verification-cache.ts).
//
// Sept 17, 2026: bumped v2 -> v3 — added an explicit rule to
// SYNTHESIS_SYSTEM_PROMPT for self-referential claims ("this recording was
// made using X"), mirroring the same fix just made to quick-check.ts's
// SYSTEM_PROMPT (see that file's ENGINE_VERSION comment for the full
// story). Deep Investigation was already reaching the right answer on
// this claim shape in practice (correctly "Unverified" rather than a
// false "True"), but only as an emergent property of the reasoning-tier
// model's judgment, not because the prompt said so explicitly — the same
// kind of implicit-not-explicit gap that let quick-check.ts drift into a
// real mistake on the identical claim. Making the rule explicit here too
// is a preventive fix, not a response to an observed DI failure, but it
// can shift verdicts on other borderline self-referential claims, so it
// gets the same version bump discipline as any other prompt change that
// can change verdict outcomes.
export const DEEP_ENGINE_VERSION = "v3-gemini-tavily-deep";

// Sept 15, 2026: added same day as the engine_version bump above, after a
// live 503 on this exact call surfaced a gap — modelForTier's "reasoning"
// tier moved every Deep Investigation pipeline onto gemini-3.8-flash, but
// the fallback-model safety net (see ai-gateway.ts's StructuredCallParams
// header) had only ever been wired into video Deep Investigation, the one
// call with a documented history of 503s. Text Deep Investigation shares
// the same underlying model now and was just as exposed, with only the
// bare 2-retry default and no fallback — this closes that gap. Same
// fallback chain as video-analysis.ts's VIDEO_DEEP_FALLBACK_MODELS.
const SYNTHESIS_FALLBACK_MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"];

export interface DeepInvestigationResult {
  verdict: string;
  confidence: number;
  summary: string;
  key_evidence: QuickCheckEvidence[];
  sources: { title: string; url: string }[];
  caveats: string[];
  engine_version: string;
}

const VALID_VERDICTS = ["True", "False", "Misleading", "Unverified", "Scam"];
const MAX_SUB_QUESTIONS = 4;
const MAX_EVIDENCE_SOURCES = 12;

const DECOMPOSE_SCHEMA = {
  type: "object",
  properties: {
    sub_questions: { type: "array", items: { type: "string" } },
  },
  required: ["sub_questions"],
};

const SYNTHESIS_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: VALID_VERDICTS },
    confidence: { type: "integer" },
    summary: { type: "string" },
    contradiction_level: { type: "string", enum: ["none", "low", "medium", "high"] },
    cited_evidence_ids: { type: "array", items: { type: "integer" } },
    missing_information: { type: "array", items: { type: "string" } },
    caveats: { type: "array", items: { type: "string" } },
  },
  required: [
    "verdict",
    "confidence",
    "summary",
    "contradiction_level",
    "cited_evidence_ids",
    "missing_information",
    "caveats",
  ],
};

interface DecomposeOutput {
  sub_questions: string[];
}

interface SynthesisOutput {
  verdict: string;
  confidence: number;
  summary: string;
  contradiction_level: string;
  cited_evidence_ids: number[];
  missing_information: string[];
  caveats: string[];
}

const DECOMPOSE_SYSTEM_PROMPT = `You are Vuryfy's Deep Investigation engine. Given a claim, break it down into 1-${MAX_SUB_QUESTIONS} focused sub-questions that, if each were answered with evidence, would let someone determine whether the claim is true, false, or misleading. Each sub-question should be a specific, searchable question — not just a restatement of the claim. If the claim is already simple and doesn't benefit from decomposition, return a single sub-question that is the core factual question being asked.
Respond with only the requested JSON — no extra commentary, no markdown.`;

const SYNTHESIS_SYSTEM_PROMPT = `You are Vuryfy's Deep Investigation engine, performing a thorough, multi-angle verification of a claim. You are given the claim, the sub-questions this investigation broke it into, and a numbered list of evidence excerpts retrieved across all of those sub-questions. Your job:
- Decide a verdict: "True", "False", "Misleading", "Unverified", or "Scam".
- Use "Scam" only when the evidence specifically names or identifies THIS claim's exact link, domain, or entity as a scam, phishing site, or fraud operation — a report, blocklist entry, news article, or complaint that is actually about this specific link/domain/entity, found across the sub-questions this investigation searched, not merely about the same general category or brand. Evidence that only describes how this type of scam usually works in general (e.g. a generic guide to phishing tactics, or an article about scams impersonating the same brand without naming this exact domain) is NOT sufficient on its own — that case is "Unverified", not "Scam", even if the claim's own wording sounds exactly like a textbook phishing attempt. Never choose "Scam" from the link or claim merely looking suspicious, unfamiliar, unofficial, or brand-adjacent with no evidence specifically about it — a confident false accusation is worse than an unresolved one.
- For anything that is simply incorrect information but not a deliberate scam/fraud attempt, use "False" or "Misleading" as appropriate, not "Scam".
- Some claims assert something about themselves or about the specific item being checked — e.g. "this recording/photo/document was made using X," "this was verified/certified by Y," "this comes from Z." Evidence that only confirms X/Y/Z is real, legitimate, or capable of that action is NOT sufficient to call such a claim "True" — that only shows the claim is plausible, not that THIS specific instance actually is what it claims to be. Only mark such a claim "True" if the evidence specifically confirms this exact instance (a report, record, or verification specifically about this item) — not merely that the named tool, organization, or service exists and does that kind of thing in general. Otherwise, use "Unverified". This is the same standard already required above for "Scam": evidence about the general category is never evidence about this specific case.
- You may ONLY use the numbered evidence provided below — never rely on outside knowledge, and never invent a source. Weigh evidence across ALL sub-questions, not just one.
- contradiction_level should reflect how much the retrieved evidence disagrees with itself (some sources supporting the claim, others contradicting it). High contradiction should generally push toward "Misleading" or "Unverified" rather than a confident True/False.
- confidence is 0-100 and must reflect how well the evidence actually supports the verdict — weak, single-source, or contradictory evidence should never produce a high confidence score.
- cited_evidence_ids must contain ONLY the bracketed numbers of evidence you actually relied on. Never include a number that wasn't given to you.
- missing_information should list what additional evidence would strengthen this verdict, if anything is missing.
- caveats should list any important limitations, nuances, or context a reader should know even after the verdict (for example: the figure changes over time, sources disagree on specifics but agree on the general claim, the claim is technically true but misleading in context). Leave empty if there are none.
- summary should be 2-4 concise sentences a general reader can understand, explaining the verdict and the reasoning behind it in plain language — more thorough than a one-line Quick Check summary, since this is a Deep Investigation.
Respond with only the requested JSON — no extra commentary, no markdown.`;

function buildEvidenceBlock(results: SearchResult[]): string {
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\nSource: ${r.source}\nURL: ${r.url}\nExcerpt: ${r.snippet}`)
    .join("\n\n");
}

// Output localization — same principle and same rationale as
// lib/quick-check.ts's identical helper: research/evidence stay in
// English, only the free-text `summary` and `caveats` fields this model
// produces get localized via a system-prompt instruction. The decompose
// step's sub-questions are deliberately left in English regardless of
// language, since they're only ever used internally to drive search
// queries and are never shown to the user.
function languageInstruction(language: Language): string {
  if (language === "en") return "";
  return `\n\nWrite the "summary" field and every string inside "caveats" in natural, fluent ${LANGUAGE_NAMES[language]}. Do not translate the claim itself, evidence titles, source names, or URLs — leave those exactly as given.`;
}

export async function runDeepInvestigation(
  claimRaw: string,
  language: Language = "en"
): Promise<DeepInvestigationResult> {
  const claim = normalizeClaim(claimRaw);

  // Step 1: decompose into sub-questions (cheap tier). Falls back to
  // treating the whole claim as a single sub-question if the model
  // returns nothing usable — decomposition failing outright should never
  // block the investigation.
  let subQuestions: string[] = [claim];
  try {
    const { data } = await callStructured<DecomposeOutput>({
      tier: "cheap",
      systemPrompt: DECOMPOSE_SYSTEM_PROMPT,
      userPrompt: `Claim to investigate:\n"${claim}"`,
      responseSchema: DECOMPOSE_SCHEMA,
      callSite: "deep-investigation.decompose",
    });
    const cleaned = Array.isArray(data.sub_questions)
      ? data.sub_questions.filter((q) => typeof q === "string" && q.trim().length > 0).slice(0, MAX_SUB_QUESTIONS)
      : [];
    if (cleaned.length > 0) subQuestions = cleaned;
  } catch (err) {
    console.error("[deep-investigation] decompose step failed, falling back to single-question search:", err);
  }

  // Step 2: search each sub-question in parallel, merge + dedupe by URL,
  // cap total evidence pool size (keeps the synthesis prompt bounded and
  // the whole pipeline fast). A sub-question whose search fails just
  // contributes no evidence rather than failing the whole investigation.
  const perQuestionResults = await Promise.all(
    subQuestions.map((q) =>
      search(q, "deep-investigation.search", { maxResults: 5 }).catch((err) => {
        console.error("[deep-investigation] search failed for sub-question:", q, err);
        return [] as SearchResult[];
      })
    )
  );

  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  outer: for (const results of perQuestionResults) {
    for (const r of results) {
      if (!r.url || seen.has(r.url)) continue;
      seen.add(r.url);
      merged.push(r);
      if (merged.length >= MAX_EVIDENCE_SOURCES) break outer;
    }
  }

  const sources = merged.map((r) => ({ title: r.title, url: r.url }));

  // Evidence threshold, same principle as Quick Check (Part 26.4): don't
  // manufacture a confident verdict from nothing.
  if (merged.length === 0) {
    return {
      verdict: "Unverified",
      confidence: 0,
      summary: translate(language, "pipeline.noEvidenceDeep"),
      key_evidence: [],
      sources: [],
      caveats: [],
      engine_version: DEEP_ENGINE_VERSION,
    };
  }

  // Step 3: reasoning-tier synthesis across all collected evidence.
  const evidenceBlock = buildEvidenceBlock(merged);
  const questionsBlock = subQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n");
  const userPrompt = `Claim to investigate:\n"${claim}"\n\nSub-questions this investigation broke the claim into:\n${questionsBlock}\n\nEvidence:\n${evidenceBlock}`;

  const { data } = await callStructured<SynthesisOutput>({
    tier: "reasoning",
    systemPrompt: SYNTHESIS_SYSTEM_PROMPT + languageInstruction(language),
    userPrompt,
    responseSchema: SYNTHESIS_SCHEMA,
    fallbackModels: SYNTHESIS_FALLBACK_MODELS,
    callSite: "deep-investigation.synthesis",
  });

  // Code-enforced grounding (Part 19): only trust cited ids that actually
  // point into the retrieved evidence pool.
  const citedIds = Array.isArray(data.cited_evidence_ids) ? data.cited_evidence_ids : [];
  const keyEvidence: QuickCheckEvidence[] = citedIds
    .filter((id) => Number.isInteger(id) && id >= 1 && id <= merged.length)
    .map((id) => {
      const r = merged[id - 1];
      return { title: r.title, url: r.url, publisher: r.source, snippet: r.snippet };
    });

  const verdict = VALID_VERDICTS.includes(data.verdict) ? data.verdict : "Unverified";
  const confidence = Number.isFinite(data.confidence) ? Math.max(0, Math.min(100, Math.round(data.confidence))) : 0;
  const summary =
    typeof data.summary === "string" && data.summary.trim()
      ? data.summary.trim()
      : translate(language, "pipeline.noEvidenceDeep");
  const caveats = Array.isArray(data.caveats) ? data.caveats.filter((c) => typeof c === "string" && c.trim().length > 0) : [];

  return {
    verdict,
    confidence,
    summary,
    key_evidence: keyEvidence,
    sources,
    caveats,
    engine_version: DEEP_ENGINE_VERSION,
  };
}
