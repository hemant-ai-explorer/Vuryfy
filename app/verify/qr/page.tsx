"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import Link from "next/link";
import { decodeQrFromFile } from "@/lib/decode-qr";
import { detectPaymentLink, type PaymentLinkInfo } from "@/lib/detect-payment-link";
import { useLanguage } from "@/app/providers/language-provider";
import { parseJsonResponse } from "@/lib/safe-json";
import { useElapsedSeconds } from "@/lib/use-elapsed-seconds";

// QR Quick Check — the next step in the locked media-type build order
// (text + link, then QR, then image, then audio/video). The QR image is
// decoded entirely client-side (see lib/decode-qr.ts) and only the
// decoded text is ever sent to the server, through the exact same
// /api/verify path a typed claim uses — just with input_type: "qr"
// instead of "text"/"link". No new backend pipeline, no image
// upload/storage: this reuses everything Quick Check already has.
//
// Payment QR codes (UPI upi://pay?... links, etc.) are a deliberate
// exception, added the same day after testing against a real UPI QR: they
// never reach /api/verify (or /api/deep) at all. See lib/detect-payment-link.ts
// for why — neither pipeline has a way to confirm who controls a payment
// ID, so running one through either produces a misleading low-confidence
// result for legitimate and fraudulent payees alike. Detected payment
// links get an informational card instead — payee name/ID surfaced
// plainly with a caution note, no verdict, no credit charged, for either
// mode.
//
// Decoded (non-payment) claims offer BOTH Quick Check and Deep
// Investigation from the same screen, rather than QR having its own
// mode-specific entry point. This is a deliberate standing pattern (Sept
// 2026): whatever a claim's source — typed, QR, and any future input type
// (image, audio/video) — the two verification modes should stay two
// buttons on one confirm screen, not two separate capture flows. It keeps
// the payment-QR guard, the decode/extract step, and any per-input-type
// UI in exactly one place per input type, while both /api/verify and
// /api/deep stay reachable from it.
//
// Payee look-alike detection (added Sept 15, 2026, prompted by a real
// near-miss the user reported — see app/api/check-payee/route.ts and
// migration 0007 for the full rationale): every detected payment QR's
// payee name + UPI ID is checked against the user's own scan history via
// the free /api/check-payee route, and every scan is recorded regardless
// of whether the user goes on to investigate it. A name that's near-
// identical to one already seen, but under a DIFFERENT UPI ID, is a
// common impersonation pattern this doesn't claim to resolve (it never
// says which of the two is the real one) — only surfaces for the user to
// check before paying.
//
// Sept 23, 2026: that warning used to render immediately on this
// pre-choice screen, for free, before Quick Check/Deep Investigation was
// chosen. Per explicit direction, it no longer does — like the payee's
// identity, a known-impersonation match is now only shown as part of the
// credit-charged QC/DI result (see app/api/verify-payee/route.ts,
// app/api/deep-payee/route.ts, and app/result/page.tsx's payee_reputation
// branch). The free /api/check-payee call here still runs and still
// records this scan into history — that part is unchanged and stays free
// — it just no longer decides what's shown on screen.
//
// Payee reputation investigation (added Sept 15, 2026, prompted by "what
// if I want Deep Investigation on this payment QR?"): the payment-QR
// carve-out above is correct that NEITHER pipeline can confirm who
// controls a payment ID or that a transaction happened — that's still
// true here. But a genuinely different, answerable question exists: does
// this payee's NAME or UPI ID have any public reputation (scam reports,
// complaints, a legitimate business footprint)? That's an ordinary
// evidence-grounded web search, same as any other claim, just constructed
// from the payee's identity rather than typed by the user — see
// app/api/verify-payee/route.ts and app/api/deep-payee/route.ts. Offered
// as its own Quick Check/Deep Investigation pair, separate from the
// payment-info card's "Scan another" action, and only for UPI payment
// links (there's no payee identity to search for a bare payment-link URL
// like paypal.me).
export default function VerifyQrPage() {
  const router = useRouter();
  const supabase = createClient();
  const { t } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [decoding, setDecoding] = useState(false);
  const [decoded, setDecoded] = useState<string | null>(null);
  const [paymentInfo, setPaymentInfo] = useState<PaymentLinkInfo | null>(null);
  const [decodeError, setDecodeError] = useState("");
  const [submitting, setSubmitting] = useState<"quick" | "deep" | null>(null);
  const [submitError, setSubmitError] = useState("");
  const [payeeChecking, setPayeeChecking] = useState<"quick" | "deep" | null>(null);
  const [payeeCheckError, setPayeeCheckError] = useState("");
  // Sept 20, 2026: "still working" progress indicators for both Deep
  // Investigation buttons on this screen — see lib/use-elapsed-seconds.ts.
  const deepElapsed = useElapsedSeconds(submitting === "deep");
  const payeeDeepElapsed = useElapsedSeconds(payeeChecking === "deep");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.replace("/login");
    });
  }, [router, supabase]);

  async function handleFile(file: File) {
    setDecoding(true);
    setDecodeError("");
    setDecoded(null);
    setPaymentInfo(null);
    setPayeeCheckError("");
    try {
      const result = await decodeQrFromFile(file);
      if (!result) {
        setDecodeError(t("qr.decodeErrorNotFound"));
        return;
      }
      const payment = detectPaymentLink(result);
      if (payment) {
        setPaymentInfo(payment);
        if (payment.payeeId) {
          // Fire-and-forget: this only records the scan into history for
          // future look-alike comparisons (see the header comment above).
          // Its similarMatch result is intentionally ignored here — that's
          // now only ever shown after a paid QC/DI, via
          // app/api/verify-payee|deep-payee's own fresh lookup.
          fetch("/api/check-payee", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ upi_id: payment.payeeId, payee_name: payment.payeeName ?? "" }),
          }).catch(() => {
            // Bonus recording only — never let a failure here block the
            // payment-info card the user actually needs to see.
          });
        }
      } else {
        setDecoded(result);
      }
    } catch {
      setDecodeError(t("qr.decodeErrorGeneric"));
    } finally {
      setDecoding(false);
    }
  }

  async function confirm(mode: "quick" | "deep") {
    if (!decoded) return;
    setSubmitting(mode);
    setSubmitError("");
    try {
      const endpoint = mode === "quick" ? "/api/verify" : "/api/deep";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim: decoded, input_type: "qr" }),
      });
      const d = await parseJsonResponse(r);
      if (!r.ok) throw new Error(d.error || (mode === "quick" ? "Verification failed" : "Investigation failed"));
      // return_to: "verify another" on the result page needs to know this
      // came from the QR upload screen, not the generic text claim form it
      // falls back to otherwise (see the Result type's return_to comment in
      // app/result/page.tsx). Mirrors investigatePayee() below, which
      // already set this for payment-QR payee checks.
      sessionStorage.setItem("vuryfy_result", JSON.stringify({ ...d, return_to: "/verify/qr" }));
      router.push(`/result?id=${d.id}`);
    } catch (e: any) {
      setSubmitError(e.message);
    } finally {
      setSubmitting(null);
    }
  }

  async function investigatePayee(mode: "quick" | "deep") {
    if (!paymentInfo?.payeeId) return;
    setPayeeChecking(mode);
    setPayeeCheckError("");
    try {
      const endpoint = mode === "quick" ? "/api/verify-payee" : "/api/deep-payee";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ payee_name: paymentInfo.payeeName ?? "", upi_id: paymentInfo.payeeId }),
      });
      const d = await parseJsonResponse(r);
      if (!r.ok) throw new Error(d.error || (mode === "quick" ? "Investigation failed" : "Investigation failed"));
      sessionStorage.setItem("vuryfy_result", JSON.stringify({ ...d, return_to: "/verify/qr" }));
      router.push(`/result?id=${d.id}`);
    } catch (e: any) {
      setPayeeCheckError(e.message);
    } finally {
      setPayeeChecking(null);
    }
  }

  function reset() {
    setDecoded(null);
    setPaymentInfo(null);
    setDecodeError("");
    setSubmitError("");
    setPayeeCheckError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push("/")}>
          {t("nav.back")}
        </button>
        <div className="credits">{t("nav.credits")}</div>
      </nav>
      <section className="verify">
        <p className="eyebrow">{t("qr.eyebrow")}</p>
        <h1>{t("qr.heading")}</h1>
        <p className="sub">{t("qr.sub")}</p>

        {!decoded && !paymentInfo && (
          <>
            <input
              ref={fileInputRef}
              id="qr-file"
              type="file"
              accept="image/*"
              capture="environment"
              className="qr-file-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
            <label htmlFor="qr-file" className="primary-link">
              {decoding ? t("status.reading") : t("qr.choosePhoto")}
            </label>
            {decodeError && <p className="error">{decodeError}</p>}
            <p className="hint">
              {t("qr.hintPhotoText")} <Link href="/verify/image">{t("hint.checkIt")}</Link>
            </p>
            <p className="hint">
              {t("qr.hintAudioText")} <Link href="/verify/audio">{t("hint.checkIt")}</Link>
            </p>
            <p className="hint">
              {t("qr.hintVideoText")} <Link href="/verify/video">{t("hint.checkIt")}</Link>
            </p>
          </>
        )}

        {paymentInfo && (
          <div className="qr-payment">
            {/* Sept 17, 2026, updated Sept 23, 2026: this card deliberately
                does NOT reveal the payee's name/UPI ID, or whether it's a
                known look-alike/impersonation match, here — none of that
                shows before the user has picked Quick Check or Deep
                Investigation and a credit has been charged. Both identity
                and any impersonation warning now show only on the result
                page (app/result/page.tsx's payee_reputation branch), after
                QC/DI is chosen. This card only shows a category label
                ("this is a payment QR code") plus what the paid check will
                do. */}
            <span>{t("qr.paymentBadge")}</span>

            {paymentInfo.kind === "upi" && paymentInfo.payeeId ? (
              <div className="qr-decoded">
                <p className="hint">{t("qr.investigateHint")}</p>
                <div className="result-actions">
                  <button
                    className="secondary"
                    onClick={() => investigatePayee("deep")}
                    disabled={!!payeeChecking}
                  >
                    {payeeChecking === "deep"
                      ? `${t("claim.investigating")} (${payeeDeepElapsed}s)`
                      : t("claim.deepInvestigation")}
                  </button>
                  <button onClick={() => investigatePayee("quick")} disabled={!!payeeChecking}>
                    {payeeChecking === "quick" ? t("claim.checking") : t("claim.quickCheck")}
                  </button>
                </div>
                {payeeCheckError && <p className="error">{payeeCheckError}</p>}
              </div>
            ) : (
              // Non-UPI payment link (paypal.me, etc.) — no payee name/ID
              // to investigate at all, so there's nothing to offer besides
              // scanning another code.
              <p className="hint">{t("qr.paymentLinkHint")}</p>
            )}

            <div className="result-actions">
              <button className="secondary" onClick={reset}>
                {t("qr.scanAnother")}
              </button>
            </div>
          </div>
        )}

        {decoded && (
          <div className="qr-decoded">
            <span>{t("qr.decodedBadge")}</span>
            <p>{decoded}</p>
            <p className="hint">{t("qr.decodedHint")}</p>
            <div className="result-actions">
              <button className="secondary" onClick={reset} disabled={!!submitting}>
                {t("qr.scanAnother")}
              </button>
              <button className="secondary" onClick={() => confirm("deep")} disabled={!!submitting}>
                {submitting === "deep" ? `${t("claim.investigating")} (${deepElapsed}s)` : t("claim.deepInvestigation")}
              </button>
              <button onClick={() => confirm("quick")} disabled={!!submitting}>
                {submitting === "quick" ? t("claim.checking") : t("claim.quickCheck")}
              </button>
            </div>
            {submitError && <p className="error">{submitError}</p>}
          </div>
        )}
      </section>
    </main>
  );
}
