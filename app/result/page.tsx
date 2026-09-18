"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useLanguage } from "@/app/providers/language-provider";
import { translateVerdict } from "@/lib/translations";
import { parseJsonResponse } from "@/lib/safe-json";

type PaymentReceiptInfo = {
  amount?: string;
  fromName?: string;
  toName?: string;
  transactionId?: string;
  appUsed?: string;
  date?: string;
  raw: string;
};

type PaymentRequestInfo = {
  payeeName?: string;
  payeeId?: string;
  raw: string;
};

type Result = {
  id: string | null;
  mode?: "quick" | "deep";
  verdict: string;
  confidence: number;
  explanation: string;
  claim: string;
  evidence: { title: string; url: string; publisher?: string; snippet?: string }[];
  caveats: string[];
  credits: { total: number; quick_checks: number; deep_investigations: number };
  // Payment-receipt carve-out (Sept 15, 2026, see lib/detect-payment-
  // receipt.ts): when /api/verify or /api/deep detects the claim is shaped
  // like a private payment receipt, they short-circuit before running any
  // verdict pipeline and return this shape instead — no verdict/confidence
  // exist on this response, so `type` is checked before any of the normal
  // verdict fields are touched. Mirrors the informational (non-verdict)
  // treatment payment QR codes already get on the QR page, just reachable
  // from any text-shaped input (typed claims, QR text, OCR'd photos,
  // audio transcripts) since that's where a receipt can turn up.
  // Payment-REQUEST carve-out (Sept 15, 2026, see lib/detect-payment-
  // request.ts): sibling of payment_receipt above, for text/OCR shaped
  // like a "scan to pay" identity card (name + UPI ID, no completed
  // transaction) rather than a completed-payment confirmation — the same
  // informational, non-verdict treatment, just a different source shape
  // (most commonly a photographed/OCR'd screenshot of someone's own QR
  // display screen).
  type?: "verification" | "payment_receipt" | "payment_request" | "payee_reputation";
  receipt?: PaymentReceiptInfo | null;
  payment_request?: PaymentRequestInfo | null;
  // Payee-reputation carve-out (Sept 17, 2026, see app/api/verify-payee/
  // route.ts and app/api/deep-payee/route.ts): a payee-reputation result
  // (from the QR payment card, or from investigating a payment_request
  // card below) leads with the payee's own identity rather than the raw
  // True/False/Misleading/Unverified verdict word, which read as
  // confusing/alarming for what's really an identity/reputation lookup.
  // `payee` carries the name/UPI ID being displayed; `verdict` (below)
  // still decides whether the dedicated Scam alert shows.
  payee?: { name: string | null; upiId: string } | null;
  // Second verdict block (added for audio's combined Quick Check/Deep
  // Investigation, Sept 14, 2026 — see app/api/verify-audio-combined/
  // route.ts): when a single button press runs two independent pipelines
  // under one credit charge, this carries the second result so both show
  // on one result screen instead of forcing a second, separate check.
  // Absent on every other result type.
  secondary?: {
    id: string;
    eyebrow: string;
    verdict: string;
    confidence: number;
    explanation: string;
    caveats?: string[];
  } | null;
  // Client-side routing hint only, not something the API returns — set by
  // the page that submitted the check (added for the image page, Sept
  // 2026) so "verify another" can send the user back to the right form
  // even when that isn't simply /verify or /deep. Absent on every other
  // result, which falls back to the mode-based logic below unchanged.
  return_to?: string;
};

function ResultView() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t, language } = useLanguage();
  const [r, setR] = useState<Result | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [payeeChecking, setPayeeChecking] = useState<"quick" | "deep" | null>(null);
  const [payeeCheckError, setPayeeCheckError] = useState("");

  // Sept 18, 2026: added the fetch-by-id fallback alongside the WhatsApp
  // submission MVP and the new history list (app/saved/page.tsx) — a past
  // verification opened from either of those has no sessionStorage entry
  // to read (sessionStorage only ever holds the result of the check the
  // browser tab just submitted interactively), so this falls back to
  // GET /api/verifications/[id] whenever sessionStorage comes up empty
  // but a ?id= is present. See that route for the response-shape
  // contract, deliberately matched to what /api/verify already returns so
  // no rendering code below needs to know which path a result came from.
  useEffect(() => {
    const x = sessionStorage.getItem("vuryfy_result");
    if (x) {
      setR(JSON.parse(x));
      return;
    }
    const id = searchParams.get("id");
    if (!id) {
      router.replace("/");
      return;
    }
    fetch(`/api/verifications/${id}`)
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((d) => setR(d))
      .catch(() => setNotFound(true));
  }, [router, searchParams]);

  if (notFound) {
    return (
      <main className="shell narrow">
        <section className="hero">
          <h1>Verification not found.</h1>
          <p className="sub">This result doesn&apos;t exist, or isn&apos;t yours to view.</p>
        </section>
      </main>
    );
  }

  if (!r) return null;

  // Reuses app/api/verify-payee and app/api/deep-payee (see
  // app/verify/qr/page.tsx for the original of this pattern, added for a
  // QR-decoded payment link). Available here too since a payment_request
  // card carries the same payee name/UPI ID a QR-decoded one does — the
  // question "does this payee have any public reputation" is answerable
  // either way. Swaps the displayed result in place rather than
  // navigating, since we're already on /result.
  async function investigatePayee(mode: "quick" | "deep") {
    if (!r?.payment_request?.payeeId) return;
    setPayeeChecking(mode);
    setPayeeCheckError("");
    try {
      const endpoint = mode === "quick" ? "/api/verify-payee" : "/api/deep-payee";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payee_name: r.payment_request.payeeName ?? "",
          upi_id: r.payment_request.payeeId,
        }),
      });
      const d = await parseJsonResponse(res);
      if (!res.ok) throw new Error(d.error || "Investigation failed");
      const next = { ...d, return_to: r.return_to };
      sessionStorage.setItem("vuryfy_result", JSON.stringify(next));
      setR(next);
    } catch (e: any) {
      setPayeeCheckError(e.message);
    } finally {
      setPayeeChecking(null);
    }
  }

  // mode is absent on results saved before this field existed (an old
  // sessionStorage entry surviving a hard refresh) — quick is the correct
  // fallback since Deep Investigation didn't exist before mode was added.
  const isDeep = r.mode === "deep";
  const newCheckHref = r.return_to || (isDeep ? "/deep" : "/verify");

  if (r.type === "payment_receipt") {
    return (
      <main className="shell narrow">
        <nav>
          <button className="back" onClick={() => router.push(newCheckHref)}>
            {t("nav.newCheck")}
          </button>
          <div className="credits">
            {t("nav.creditsPrefix")}
            {r.credits.total}
          </div>
        </nav>
        <section className="result">
          <p className="eyebrow">{t("result.receiptEyebrow")}</p>
          <div className="qr-payment">
            <span>{t("result.receiptBadge")}</span>
            <h3>{r.receipt?.amount ? `₹${r.receipt.amount}` : t("result.receiptAmountUnclear")}</h3>
            {r.receipt?.fromName && (
              <p className="payee-id">
                {t("result.receiptFrom")}
                {r.receipt.fromName}
              </p>
            )}
            {r.receipt?.toName && (
              <p className="payee-id">
                {t("result.receiptTo")}
                {r.receipt.toName}
              </p>
            )}
            {r.receipt?.appUsed && (
              <p className="payee-id">
                {t("result.receiptVia")}
                {r.receipt.appUsed}
              </p>
            )}
            {r.receipt?.transactionId && (
              <p className="payee-id">
                {t("result.receiptTxnId")}
                {r.receipt.transactionId}
              </p>
            )}
            {r.receipt?.date && (
              <p className="payee-id">
                {t("result.receiptDate")}
                {r.receipt.date}
              </p>
            )}
            <p className="caution">{t("result.receiptCaution")}</p>
          </div>
          <div className="claim">
            <span>{t("result.whatWeRead")}</span>
            <p>{r.claim}</p>
          </div>
          <div className="result-actions">
            <button className="secondary" onClick={() => router.push(newCheckHref)}>
              {t("result.checkAnother")}
            </button>
          </div>
        </section>
      </main>
    );
  }

  if (r.type === "payment_request") {
    return (
      <main className="shell narrow">
        <nav>
          <button className="back" onClick={() => router.push(newCheckHref)}>
            {t("nav.newCheck")}
          </button>
          <div className="credits">
            {t("nav.creditsPrefix")}
            {r.credits.total}
          </div>
        </nav>
        <section className="result">
          <p className="eyebrow">{t("result.requestEyebrow")}</p>
          <div className="qr-payment">
            <span>{t("result.requestBadge")}</span>
            <h3>{r.payment_request?.payeeName || t("payee.unnamed")}</h3>
            {r.payment_request?.payeeId && <p className="payee-id">{r.payment_request.payeeId}</p>}
            <p className="caution">{t("result.requestCaution")}</p>
          </div>

          {r.payment_request?.payeeId && (
            <div className="qr-decoded" style={{ marginTop: 20 }}>
              <span>{t("payee.investigateEyebrow")}</span>
              <p className="hint">{t("result.investigateHint")}</p>
              <div className="result-actions">
                <button
                  className="secondary"
                  onClick={() => investigatePayee("deep")}
                  disabled={!!payeeChecking}
                >
                  {payeeChecking === "deep" ? t("claim.investigating") : t("claim.deepInvestigation")}
                </button>
                <button onClick={() => investigatePayee("quick")} disabled={!!payeeChecking}>
                  {payeeChecking === "quick" ? t("claim.checking") : t("claim.quickCheck")}
                </button>
              </div>
              {payeeCheckError && <p className="error">{payeeCheckError}</p>}
            </div>
          )}

          <div className="claim">
            <span>{t("result.whatWeRead")}</span>
            <p>{r.claim}</p>
          </div>
          <div className="result-actions">
            <button className="secondary" onClick={() => router.push(newCheckHref)}>
              {t("result.checkAnother")}
            </button>
          </div>
        </section>
      </main>
    );
  }

  // "Scam" verdict (Sept 2026 addition, see lib/quick-check.ts and
  // lib/deep-investigation.ts): gets its own red warning card instead of
  // blending into the plain verdict text every other verdict uses, so a
  // scam link doesn't read as just another "False". Applies to any claim
  // through either pipeline, not just QR-sourced ones.
  const isScam = r.verdict === "Scam";

  // Payee-reputation carve-out (Sept 17, 2026, see the `Result` type's
  // comment above and app/api/verify-payee/route.ts): rendered before the
  // generic verdict branch below, since a payee-reputation result also has
  // `verdict`/`confidence` set and would otherwise fall through into it.
  // Non-scam outcomes never show the raw verdict word (True/False/
  // Misleading/Unverified) — they lead with the payee's own name/ID, same
  // as the free QR-decode preview, with a plain "no reports found" status
  // line instead. A "Scam" verdict still gets the existing dedicated red
  // warning card, just shown alongside the payee's identity rather than
  // replacing it, so it's clear which payee the alert is about.
  if (r.type === "payee_reputation") {
    return (
      <main className="shell narrow">
        <nav>
          <button className="back" onClick={() => router.push(newCheckHref)}>
            {t("nav.newCheck")}
          </button>
          <div className="credits">
            {t("nav.creditsPrefix")}
            {r.credits.total}
          </div>
        </nav>
        <section className="result">
          <p className="eyebrow">{isDeep ? t("result.deepResultEyebrow") : t("result.quickResultEyebrow")}</p>
          <div className="qr-payment">
            <span>{t("result.payeeBadge")}</span>
            <h3>{r.payee?.name || t("payee.unnamed")}</h3>
            {r.payee?.upiId && <p className="payee-id">{r.payee.upiId}</p>}
          </div>
          {isScam ? (
            <div className="scam-warning">
              <span>{t("result.scamWarning")}</span>
              <div className="confidence">
                {t("result.confidencePrefix")}
                {r.confidence}%
              </div>
              <p className="caution">{t("result.scamCaution")}</p>
            </div>
          ) : (
            <>
              <p className="hint">{t("result.payeeClear")}</p>
              <div className="confidence">
                {t("result.confidencePrefix")}
                {r.confidence}%
              </div>
            </>
          )}
          <div className="explanation">
            <span>{t("result.whyLabel")}</span>
            <p>{r.explanation}</p>
          </div>
          {r.evidence?.length > 0 && (
            <div className="evidence">
              <span>{t("result.evidenceLabel")}</span>
              {r.evidence.map((e, i) => (
                <a key={i} href={e.url} target="_blank" rel="noreferrer">
                  <strong>{e.title}</strong>
                  <small>{e.url}</small>
                </a>
              ))}
            </div>
          )}
          {r.caveats?.length > 0 && (
            <div className="caveats">
              <span>{t("result.notesLabel")}</span>
              {r.caveats.map((c, i) => (
                <p key={i}>{c}</p>
              ))}
            </div>
          )}
          <div className="result-actions">
            <button
              onClick={() =>
                navigator.clipboard?.writeText(
                  (r.payee?.name ? `${r.payee.name} — ${r.payee.upiId}` : r.payee?.upiId || r.claim) +
                    "\n\n" +
                    (isScam ? "SCAM" : t("result.payeeClear")) +
                    "\n" +
                    r.explanation
                )
              }
            >
              {t("result.shareResult")}
            </button>
            <button className="secondary" onClick={() => router.push(newCheckHref)}>
              {t("result.verifyAnother")}
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push(newCheckHref)}>
          {t("nav.newCheck")}
        </button>
        <div className="credits">
          {t("nav.creditsPrefix")}
          {r.credits.total}
        </div>
      </nav>
      <section className="result">
        <p className="eyebrow">{isDeep ? t("result.deepResultEyebrow") : t("result.quickResultEyebrow")}</p>
        {isScam ? (
          <div className="scam-warning">
            <span>{t("result.scamWarning")}</span>
            <div className="verdict">{translateVerdict(language, "Scam")}</div>
            <div className="confidence">
              {t("result.confidencePrefix")}
              {r.confidence}%
            </div>
            <p className="caution">{t("result.scamCaution")}</p>
          </div>
        ) : (
          <>
            <div className="verdict">{translateVerdict(language, r.verdict)}</div>
            <div className="confidence">
              {t("result.confidencePrefix")}
              {r.confidence}%
            </div>
          </>
        )}
        <div className="claim">
          <span>{t("result.claimLabel")}</span>
          <p>{r.claim}</p>
        </div>
        <div className="explanation">
          <span>{t("result.whyLabel")}</span>
          <p>{r.explanation}</p>
        </div>
        {r.evidence?.length > 0 && (
          <div className="evidence">
            <span>{t("result.evidenceLabel")}</span>
            {r.evidence.map((e, i) => (
              <a key={i} href={e.url} target="_blank" rel="noreferrer">
                <strong>{e.title}</strong>
                <small>{e.url}</small>
              </a>
            ))}
          </div>
        )}
        {r.caveats?.length > 0 && (
          <div className="caveats">
            <span>{t("result.notesLabel")}</span>
            {r.caveats.map((c, i) => (
              <p key={i}>{c}</p>
            ))}
          </div>
        )}
        {r.secondary && (
          <>
            <hr style={{ margin: "28px 0", border: "none", borderTop: "1px solid #e5e5e5" }} />
            <p className="eyebrow">{r.secondary.eyebrow}</p>
            <div className="verdict">{translateVerdict(language, r.secondary.verdict)}</div>
            <div className="confidence">
              {t("result.confidencePrefix")}
              {r.secondary.confidence}%
            </div>
            <div className="explanation">
              <span>{t("result.whyLabel")}</span>
              <p>{r.secondary.explanation}</p>
            </div>
            {r.secondary.caveats && r.secondary.caveats.length > 0 && (
              <div className="caveats">
                <span>{t("result.notesLabel")}</span>
                {r.secondary.caveats.map((c, i) => (
                  <p key={i}>{c}</p>
                ))}
              </div>
            )}
          </>
        )}
        <div className="result-actions">
          <button
            onClick={() =>
              navigator.clipboard?.writeText(r.claim + "\n\n" + r.verdict + "\n" + r.explanation)
            }
          >
            {t("result.shareResult")}
          </button>
          <button className="secondary" onClick={() => router.push(newCheckHref)}>
            {t("result.verifyAnother")}
          </button>
        </div>
      </section>
    </main>
  );
}

// useSearchParams() requires a Suspense boundary at build time (same
// convention as app/login/page.tsx and app/verify/claim/page.tsx) —
// added here alongside the fetch-by-id fallback above, since this page
// previously never read from the URL at all.
export default function ResultPage() {
  return (
    <Suspense fallback={null}>
      <ResultView />
    </Suspense>
  );
}
