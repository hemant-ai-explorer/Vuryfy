"use client";
import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { extractTextFromImage } from "@/lib/decode-image-text";
import { prepareImageForUpload, type PreparedImage } from "@/lib/prepare-image-upload";
import { useLanguage } from "@/app/providers/language-provider";
import { parseJsonResponse } from "@/lib/safe-json";
import { useElapsedSeconds } from "@/lib/use-elapsed-seconds";

// Image input — the next step in the locked media-type build order (text +
// link -> QR -> image -> audio/video). Offers up to two independent
// analyses of the same photo, but — Sept 15, 2026 — from a SINGLE set of
// buttons, not two. A photo can contain meaningful text, be itself the
// thing being judged, or both:
//
//   1. Text-in-image (lib/decode-image-text.ts, Tesseract.js, entirely
//      client-side): if the photo has readable text, it's extracted and
//      fact-checked (lib/quick-check.ts / lib/deep-investigation.ts).
//   2. Photo-as-claim (lib/image-analysis.ts, a real vision AI call): the
//      image is analyzed for visual signs of manipulation/AI generation,
//      optionally checked against a short user-provided context. Uses its
//      own honest, narrower verdict vocabulary (Clean/Suspicious/
//      Inconclusive) rather than True/False — see lib/image-analysis.ts.
//
// These originally shipped as two fully separate button pairs on one
// screen (one per analysis), mirroring how audio's transcript check and
// audio-authenticity check first shipped. Same complaint followed both
// times: two "Quick Check" buttons on one screen reads as confusing, not
// as two clearly different questions. Fixed the same way audio was fixed
// (see app/api/verify-audio-combined/route.ts): when OCR text was found,
// ONE Quick Check button and ONE Deep Investigation button now run BOTH
// analyses together via /api/verify-image-combined / /api/deep-image-
// combined, charging exactly 1 credit total, with both results shown on
// one result screen (see the `secondary` block in app/result/page.tsx).
// When no text was found in the photo, there's nothing to combine, so the
// photo-only buttons call /api/verify-image / /api/deep-image directly,
// unchanged.
//
// A photographed payment receipt (someone's "proof of payment" screenshot)
// is exactly why the combined route also runs the payment-receipt
// carve-out (lib/detect-payment-receipt.ts) on the OCR'd text before doing
// anything else — see that file and app/api/verify-image-combined/
// route.ts for the full rationale.
//
// Both OCR text extraction and the vision-upload prep run automatically,
// client-side, the moment a photo is chosen — no network call happens
// until the user explicitly presses one of the mode buttons below, same
// no-surprise-cost principle as every other confirm screen in the app.
//
// WhatsApp media-first flow (Part 13 rework, Sept 18, 2026) — see
// supabase/migrations/0017_whatsapp_submissions.sql and app/page.tsx's
// "continue from WhatsApp" banner. Arriving here via ?whatsapp=<id> means
// a photo was forwarded on WhatsApp and is waiting server-side; on mount
// we fetch its bytes from /api/whatsapp/pending/[id]/image, build a plain
// File from them, and hand it to the SAME handleFile() used for a normal
// file-picker choice — the OCR + downscale + combined-buttons flow below
// is completely unchanged, and doesn't know or care where the photo came
// from. Needs useSearchParams(), so this file now needs a Suspense
// boundary at build time — see app/verify/claim/page.tsx (rewritten in
// this same pass) for the identical pattern.
function ImageForm() {
  const router = useRouter();
  const supabase = createClient();
  const { t } = useLanguage();
  const searchParams = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const whatsappId = searchParams.get("whatsapp");

  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState("");
  const [ocrText, setOcrText] = useState<string | null>(null);
  const [prepared, setPrepared] = useState<PreparedImage | null>(null);
  const [context, setContext] = useState("");
  const [submitting, setSubmitting] = useState<
    "combined-quick" | "combined-deep" | "vision-quick" | "vision-deep" | null
  >(null);
  const [submitError, setSubmitError] = useState("");
  const [loadingWaImage, setLoadingWaImage] = useState(!!whatsappId);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.replace("/login");
    });
  }, [router, supabase]);

  async function handleFile(file: File) {
    setProcessing(true);
    setProcessError("");
    setOcrText(null);
    setPrepared(null);
    setSubmitError("");
    try {
      const [text, image] = await Promise.all([extractTextFromImage(file), prepareImageForUpload(file)]);
      setOcrText(text || null);
      setPrepared(image);
    } catch {
      setProcessError(t("qr.decodeErrorGeneric"));
    } finally {
      setProcessing(false);
    }
  }

  useEffect(() => {
    if (!whatsappId) return;
    setLoadingWaImage(true);
    fetch(`/api/whatsapp/pending/${whatsappId}/image`)
      .then((r) => {
        if (!r.ok) throw new Error("not found");
        return r.blob();
      })
      .then((blob) => {
        const file = new File([blob], "whatsapp-image.jpg", { type: blob.type || "image/jpeg" });
        return handleFile(file);
      })
      .catch(() => setProcessError(t("qr.decodeErrorGeneric")))
      .finally(() => setLoadingWaImage(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [whatsappId]);

  async function submitCombined(mode: "quick" | "deep") {
    if (!prepared || !ocrText) return;
    setSubmitting(mode === "quick" ? "combined-quick" : "combined-deep");
    setSubmitError("");
    try {
      const endpoint = mode === "quick" ? "/api/verify-image-combined" : "/api/deep-image-combined";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_base64: prepared.base64,
          mime_type: prepared.mimeType,
          ocr_text: ocrText,
          context: context.trim(),
        }),
      });
      const d = await parseJsonResponse(r);
      if (!r.ok) throw new Error(d.error || (mode === "quick" ? "Verification failed" : "Investigation failed"));
      sessionStorage.setItem("vuryfy_result", JSON.stringify({ ...d, return_to: "/verify/image" }));
      router.push(`/result?id=${d.id}`);
    } catch (e: any) {
      setSubmitError(e.message);
    } finally {
      setSubmitting(null);
    }
  }

  async function submitVision(mode: "quick" | "deep") {
    if (!prepared) return;
    setSubmitting(mode === "quick" ? "vision-quick" : "vision-deep");
    setSubmitError("");
    try {
      const endpoint = mode === "quick" ? "/api/verify-image" : "/api/deep-image";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          image_base64: prepared.base64,
          mime_type: prepared.mimeType,
          context: context.trim(),
        }),
      });
      const d = await parseJsonResponse(r);
      if (!r.ok) throw new Error(d.error || (mode === "quick" ? "Analysis failed" : "Investigation failed"));
      sessionStorage.setItem("vuryfy_result", JSON.stringify({ ...d, return_to: "/verify/image" }));
      router.push(`/result?id=${d.id}`);
    } catch (e: any) {
      setSubmitError(e.message);
    } finally {
      setSubmitting(null);
    }
  }

  function reset() {
    setOcrText(null);
    setPrepared(null);
    setContext("");
    setProcessError("");
    setSubmitError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const hasImage = !!prepared;
  const anySubmitting = !!submitting;
  const isCheckingCombined = submitting === "combined-quick" || submitting === "vision-quick";
  const isDeepCombined = submitting === "combined-deep" || submitting === "vision-deep";
  // Sept 20, 2026: "still working" progress indicator for Deep Investigation
  // — see lib/use-elapsed-seconds.ts.
  const deepElapsed = useElapsedSeconds(isDeepCombined);

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push("/")}>
          {t("nav.back")}
        </button>
        <div className="credits">{t("nav.credits")}</div>
      </nav>
      <section className="verify">
        <p className="eyebrow">{t("image.eyebrow")}</p>
        <h1>{t("image.heading")}</h1>
        <p className="sub">{t("image.sub")}</p>

        {!hasImage && (
          <>
            {loadingWaImage && <p className="hint">Loading your photo from WhatsApp…</p>}
            <input
              ref={fileInputRef}
              id="image-file"
              type="file"
              accept="image/*"
              capture="environment"
              className="qr-file-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
            <label htmlFor="image-file" className="primary-link">
              {processing ? t("status.reading") : t("qr.choosePhoto")}
            </label>
            {processError && <p className="error">{processError}</p>}
            <p className="hint">
              {t("image.hintQrText")} <Link href="/verify/qr">{t("image.hintQrLink")}</Link>
            </p>
            <p className="hint">
              {t("qr.hintAudioText")} <Link href="/verify/audio">{t("hint.checkIt")}</Link>
            </p>
            <p className="hint">
              {t("qr.hintVideoText")} <Link href="/verify/video">{t("hint.checkIt")}</Link>
            </p>
          </>
        )}

        {hasImage && ocrText && (
          <div className="qr-decoded">
            <span>{t("image.ocrFoundBadge")}</span>
            <p>{ocrText}</p>
            <p className="hint">{t("image.ocrFoundHint")}</p>
          </div>
        )}

        {hasImage && (
          <div className="qr-decoded">
            {!ocrText && <span>{t("image.analyzeBadge")}</span>}
            <p className="hint">{ocrText ? t("image.hintCombined") : t("image.hintVisionOnly")}</p>
            <textarea
              className="context-textarea"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder={t("image.contextPlaceholder")}
              maxLength={500}
            />
            <div className="result-actions">
              <button className="secondary" onClick={reset} disabled={anySubmitting}>
                {t("action.chooseAnother")}
              </button>
              <button
                className="secondary"
                onClick={() => (ocrText ? submitCombined("deep") : submitVision("deep"))}
                disabled={anySubmitting}
              >
                {isDeepCombined ? `${t("claim.investigating")} (${deepElapsed}s)` : t("claim.deepInvestigation")}
              </button>
              <button
                onClick={() => (ocrText ? submitCombined("quick") : submitVision("quick"))}
                disabled={anySubmitting}
              >
                {isCheckingCombined ? t("claim.checking") : t("claim.quickCheck")}
              </button>
            </div>
            {submitError && <p className="error">{submitError}</p>}
          </div>
        )}
      </section>
    </main>
  );
}

// useSearchParams() requires a Suspense boundary at build time — see
// app/verify/claim/page.tsx and app/result/page.tsx for the same pattern
// already used elsewhere in this app.
export default function VerifyImagePage() {
  return (
    <Suspense fallback={null}>
      <ImageForm />
    </Suspense>
  );
}
