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
import { useCreditsTotal } from "@/lib/use-credits";
import { apiFetch } from "@/lib/api-fetch";
import { isNativePlatform, pickNativePhoto } from "@/lib/native-camera";
import { scanQrCodeNative } from "@/lib/native-qr-scan";

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
  // Nov 27, 2026: the real bank-verified registered-name lookup (Decentro
  // VerifyPay) that used to live behind a separate "Quick Check +
  // Registered Name — 2 credits" button has been removed from this screen
  // entirely — see the removal note near investigatePayee() and the
  // payee-actions JSX below for why. payeeChecking is back to a plain
  // two-state union.
  const [payeeChecking, setPayeeChecking] = useState<"quick" | "deep" | null>(null);
  const [payeeCheckError, setPayeeCheckError] = useState("");
  // Sept 20, 2026: "still working" progress indicators for both Deep
  // Investigation buttons on this screen — see lib/use-elapsed-seconds.ts.
  const deepElapsed = useElapsedSeconds(submitting === "deep");
  const payeeDeepElapsed = useElapsedSeconds(payeeChecking === "deep");
  // Sept 29, 2026: same "still working" indicator, now also on both Quick
  // Check buttons (see app/verify/image/page.tsx's identical addition for
  // the rationale — a real user report that Quick Check felt stuck with no
  // feedback at all).
  const quickElapsed = useElapsedSeconds(submitting === "quick");
  const payeeQuickElapsed = useElapsedSeconds(payeeChecking === "quick");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.replace("/login");
    });
  }, [router, supabase]);

  // Nov 27, 2026: shared by both decode paths — a photo decoded via
  // lib/decode-qr.ts, and a live scan's already-decoded text (see
  // handleLiveScan below) — so the payment-link/payee-history logic below
  // only lives in one place regardless of how the text was obtained.
  async function processDecodedText(result: string) {
    const payment = detectPaymentLink(result);
    if (payment) {
      setPaymentInfo(payment);
      if (payment.payeeId) {
        // Fire-and-forget: this only records the scan into history for
        // future look-alike comparisons (see the header comment above).
        // Its similarMatch result is intentionally ignored here — that's
        // now only ever shown after a paid QC/DI, via
        // app/api/verify-payee|deep-payee's own fresh lookup.
        apiFetch("/api/check-payee", {
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
  }

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
      await processDecodedText(result);
    } catch {
      setDecodeError(t("qr.decodeErrorGeneric"));
    } finally {
      setDecoding(false);
    }
  }

  // Nov 27, 2026: live point-and-scan QR scanning — see
  // lib/native-qr-scan.ts's header. The native scanner already hands back
  // decoded TEXT (no photo to run through lib/decode-qr.ts), so this calls
  // processDecodedText() directly instead of handleFile(). A null result
  // means the user backed out of the scanner — silent no-op, same as
  // lib/native-camera.ts's pickNativePhoto() convention.
  async function handleLiveScan() {
    setDecoding(true);
    setDecodeError("");
    setDecoded(null);
    setPaymentInfo(null);
    setPayeeCheckError("");
    try {
      const result = await scanQrCodeNative();
      if (result) await processDecodedText(result);
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
      const r = await apiFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim: decoded, input_type: "qr" }),
      });
      const d = await parseJsonResponse(r);
      if (!r.ok) {
        // Billing engine (Nov 25, 2026) — a 402 here means billing is
        // blocking this check, whether from a fresh trigger or the
        // generic "out of credits" case. Send the user to the payment
        // screen either way instead of a dead-end error.
        if (r.status === 402) {
          const redirectPath = d.redirect || "/billing";
          const q = d.trigger ? `?trigger=${encodeURIComponent(d.trigger)}` : "";
          router.push(`${redirectPath}${q}`);
          return;
        }
        throw new Error(d.error || (mode === "quick" ? "Verification failed" : "Investigation failed"));
      }
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

  // Nov 27, 2026: the "Quick Check + Registered Name" 2-credit opt-in
  // (`include_registered_name: true`) has been removed from this screen —
  // see the removal note near the payee-actions JSX below for the full
  // reason (Decentro's VerifyPay, the only backend ever wired up for this,
  // is blocked for Vuryfy as an unregulated entity — see
  // business-ops-2026-10-21.md — so that 2-credit button was silently
  // charging double credits for a lookup that could never succeed). The
  // route (app/api/verify-payee/route.ts) still accepts the flag so the
  // backend/billing logic doesn't need touching if a vendor ever works
  // out — this screen just never sends it anymore.
  async function investigatePayee(mode: "quick" | "deep") {
    if (!paymentInfo?.payeeId) return;
    setPayeeChecking(mode);
    setPayeeCheckError("");
    try {
      const endpoint = mode === "quick" ? "/api/verify-payee" : "/api/deep-payee";
      const r = await apiFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payee_name: paymentInfo.payeeName ?? "",
          upi_id: paymentInfo.payeeId,
        }),
      });
      const d = await parseJsonResponse(r);
      if (!r.ok) {
        if (r.status === 402) {
          const redirectPath = d.redirect || "/billing";
          const q = d.trigger ? `?trigger=${encodeURIComponent(d.trigger)}` : "";
          router.push(`${redirectPath}${q}`);
          return;
        }
        throw new Error(d.error || "Investigation failed");
      }
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

  // Nov 27, 2026: native camera/photo-library access — see
  // lib/native-camera.ts's header. Feeds the SAME handleFile() the file
  // input's onChange already uses, so QR decoding downstream is unchanged.
  async function handleNativePick() {
    const file = await pickNativePhoto();
    if (file) await handleFile(file);
  }

  // Nov 25, 2026: live credit count in the nav bar, matching the home
  // screen — see lib/use-credits.ts's header.
  const creditsTotal = useCreditsTotal();

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push("/")}>
          {t("nav.back")}
        </button>
        <div className="credits">
          {t("nav.credits")} · {creditsTotal ?? "…"}
        </div>
      </nav>
      <section className="verify">
        <p className="eyebrow">{t("qr.eyebrow")}</p>
        <h1>{t("qr.heading")}</h1>
        <p className="sub">{t("qr.sub")}</p>

        {!decoded && !paymentInfo && (
          <>
            {/* Sept 28, 2026: capture="environment" removed — same real-device
                bug as app/verify/image/page.tsx's identical input (see its
                comment): forced camera-only capture, no "Photo Library"
                option in the picker. */}
            {/* Nov 27, 2026: same native-camera gap as the Image verify
                screen (see lib/native-camera.ts's header) — a plain file
                input only offers a gallery picker on Android inside the
                Capacitor app, no camera option, so the native build uses
                @capacitor/camera's native prompt instead. Web is unchanged. */}
            {/* Nov 27, 2026: live point-and-scan added alongside the photo
                option (see lib/native-qr-scan.ts's header) — this is the
                primary action now, since it's faster than taking a photo
                and works the instant a code is in frame; "Choose a photo"
                stays as a fallback for a code already saved as an image
                (e.g. a screenshot) rather than one physically in front of
                the camera. */}
            {isNativePlatform() ? (
              <>
                <button
                  type="button"
                  className="primary-link"
                  onClick={handleLiveScan}
                  disabled={decoding}
                >
                  {decoding ? t("status.reading") : t("qr.scanLive")}
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={handleNativePick}
                  disabled={decoding}
                >
                  {t("qr.choosePhoto")}
                </button>
              </>
            ) : (
              <>
                <input
                  ref={fileInputRef}
                  id="qr-file"
                  type="file"
                  accept="image/*"
                  className="qr-file-input"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleFile(file);
                  }}
                />
                <label htmlFor="qr-file" className="primary-link">
                  {decoding ? t("status.reading") : t("qr.choosePhoto")}
                </label>
              </>
            )}
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
                {/* Sept 23, 2026: two distinct buttons, QC → DI, each with
                    its own caption underneath stating exactly what that
                    option shows — replaces the earlier single lead-in
                    sentence (removed) and checkbox (removed before that).
                    Both are styled identically (neither uses "secondary")
                    since they're two equally-weighted paid options here,
                    unlike the plain claim confirm screen where Quick Check
                    is the default action and Deep Investigation/Scan
                    another are visually secondary.

                    Nov 27, 2026: REMOVED the third "Quick Check +
                    Registered Name — 2 credits" button that used to sit
                    between these two. Per business-ops-2026-10-21.md, every
                    vendor researched for the real bank-verified
                    registered-name lookup (Decentro's VerifyPay, then
                    Signzy, then Cashfree) turned out to require Vuryfy to
                    be an RBI/SEBI-regulated entity, which it isn't — so
                    that lookup can never actually resolve right now. The
                    2-credit button was charging users double credits for a
                    check that silently always came back empty
                    (verifyRegisteredName() → {available:false} on missing
                    provider config, see lib/vpa-registered-name.ts).
                    Removed rather than left up, since a button that can
                    never deliver what it's priced for is worse than no
                    button. Deep Investigation's caption below was also
                    reworded for the same reason — it used to promise the
                    verified registered name "at no extra cost," which was
                    equally never going to be true. The backend route
                    (app/api/verify-payee/route.ts) still accepts
                    include_registered_name unused, so nothing needs to
                    change there if a vendor ever works out. */}
                <div className="result-actions payee-actions">
                  <div className="payee-action">
                    <button onClick={() => investigatePayee("quick")} disabled={!!payeeChecking}>
                      {payeeChecking === "quick" ? `${t("claim.checking")} (${payeeQuickElapsed}s)` : t("claim.quickCheck")}
                    </button>
                    <p className="hint">{t("qr.quickCheckCaption")}</p>
                  </div>
                  <div className="payee-action">
                    <button onClick={() => investigatePayee("deep")} disabled={!!payeeChecking}>
                      {payeeChecking === "deep"
                        ? `${t("claim.investigating")} (${payeeDeepElapsed}s)`
                        : t("claim.deepInvestigation")}
                    </button>
                    <p className="hint">{t("qr.deepIncludesNameHint")}</p>
                  </div>
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
            {/* Sept 23, 2026: Quick Check first, Deep Investigation second,
                both styled identically (neither uses "secondary") — a
                standing convention now applied across every feature's
                QC/DI pair. "Scan another" moves after them since it isn't
                part of that pair. */}
            <div className="result-actions">
              <button onClick={() => confirm("quick")} disabled={!!submitting}>
                {submitting === "quick" ? `${t("claim.checking")} (${quickElapsed}s)` : t("claim.quickCheck")}
              </button>
              <button onClick={() => confirm("deep")} disabled={!!submitting}>
                {submitting === "deep" ? `${t("claim.investigating")} (${deepElapsed}s)` : t("claim.deepInvestigation")}
              </button>
              <button className="secondary" onClick={reset} disabled={!!submitting}>
                {t("qr.scanAnother")}
              </button>
            </div>
            {submitError && <p className="error">{submitError}</p>}
          </div>
        )}
      </section>
    </main>
  );
}
