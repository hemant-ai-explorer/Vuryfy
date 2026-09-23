"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { prepareAudioForUpload, type PreparedAudio } from "@/lib/prepare-audio-upload";
import { useLanguage } from "@/app/providers/language-provider";
import { parseJsonResponse } from "@/lib/safe-json";
import { useElapsedSeconds } from "@/lib/use-elapsed-seconds";

// Audio input — first half of the last step in the locked media-type build
// order (text + link -> QR -> image -> audio/video), audio shipping ahead
// of video per the user's explicit sequencing call (video is significantly
// more complex — frame extraction, scene detection, per-frame OCR — so
// audio ships and gets fully tested on its own first).
//
// Originally shipped (Sept 14, 2026) with transcript fact-checking and
// audio-authenticity analysis as two fully independent sub-paths, each
// with its own Quick Check / Deep Investigation buttons — so a recording
// with speech showed FOUR buttons on one screen, two labeled "Quick
// Check". User feedback the same day: confusing, and not what was wanted.
// Reworked so that whenever a transcript exists, there is exactly ONE
// Quick Check button and ONE Deep Investigation button, each of which
// combines both analyses (fact-checking what's said and listening to the
// recording itself, via /api/verify-audio-combined or
// /api/deep-audio-combined, which run both pipelines under a single,
// explicitly-chosen 1-credit charge — see that route's header for the
// credit-cost decision) and shows both verdicts on one result screen (see
// app/result/page.tsx's `secondary` field). When no speech is found,
// there's nothing to combine, so the original audio-only authenticity
// check (its own single Quick Check / Deep Investigation pair, via
// /api/verify-audio and /api/deep-audio) is used unchanged.
//
// Unlike image input, transcription itself requires a network call (no
// free client-side speech-to-text exists — see prepare-audio-upload.ts),
// so choosing a file triggers a brief "Transcribing…" step before the
// transcript block appears. No credit is charged until a Quick Check or
// Deep Investigation button is explicitly pressed — same no-surprise-cost
// principle as every other confirm screen in this app.
export default function VerifyAudioPage() {
  const router = useRouter();
  const supabase = createClient();
  const { t } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState("");
  const [prepared, setPrepared] = useState<PreparedAudio | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [noSpeechFound, setNoSpeechFound] = useState(false);
  const [context, setContext] = useState("");
  const [submitting, setSubmitting] = useState<
    "combined-quick" | "combined-deep" | "audio-quick" | "audio-deep" | null
  >(null);
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.replace("/login");
    });
  }, [router, supabase]);

  async function handleFile(file: File) {
    setProcessing(true);
    setProcessError("");
    setTranscript(null);
    setNoSpeechFound(false);
    setSubmitError("");
    try {
      const audio = await prepareAudioForUpload(file);
      setPrepared(audio);

      const r = await fetch("/api/transcribe-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio_base64: audio.base64, mime_type: audio.mimeType }),
      });
      const d = await parseJsonResponse(r);
      if (!r.ok) throw new Error(d.error || "Transcription failed");
      if (d.transcript) {
        setTranscript(d.transcript);
      } else {
        setNoSpeechFound(true);
      }
    } catch (e: any) {
      setProcessError(e.message || t("audio.processError"));
    } finally {
      setProcessing(false);
    }
  }

  // Combined check — runs both the transcript fact-check and the audio
  // authenticity listen-through from one button, one credit charge (see
  // this page's header comment and app/api/verify-audio-combined/route.ts).
  async function submitCombined(mode: "quick" | "deep") {
    if (!transcript || !prepared) return;
    setSubmitting(mode === "quick" ? "combined-quick" : "combined-deep");
    setSubmitError("");
    try {
      const endpoint = mode === "quick" ? "/api/verify-audio-combined" : "/api/deep-audio-combined";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio_base64: prepared.base64,
          mime_type: prepared.mimeType,
          transcript,
          context: context.trim(),
        }),
      });
      const d = await parseJsonResponse(r);
      if (!r.ok) throw new Error(d.error || (mode === "quick" ? "Check failed" : "Investigation failed"));
      sessionStorage.setItem("vuryfy_result", JSON.stringify({ ...d, return_to: "/verify/audio" }));
      router.push(`/result?id=${d.id}`);
    } catch (e: any) {
      setSubmitError(e.message);
    } finally {
      setSubmitting(null);
    }
  }

  // Audio-only check — used only when no speech was found, so there's
  // nothing to combine with.
  async function submitAudio(mode: "quick" | "deep") {
    if (!prepared) return;
    setSubmitting(mode === "quick" ? "audio-quick" : "audio-deep");
    setSubmitError("");
    try {
      const endpoint = mode === "quick" ? "/api/verify-audio" : "/api/deep-audio";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          audio_base64: prepared.base64,
          mime_type: prepared.mimeType,
          context: context.trim(),
        }),
      });
      const d = await parseJsonResponse(r);
      if (!r.ok) throw new Error(d.error || (mode === "quick" ? "Analysis failed" : "Investigation failed"));
      sessionStorage.setItem("vuryfy_result", JSON.stringify({ ...d, return_to: "/verify/audio" }));
      router.push(`/result?id=${d.id}`);
    } catch (e: any) {
      setSubmitError(e.message);
    } finally {
      setSubmitting(null);
    }
  }

  function reset() {
    setPrepared(null);
    setTranscript(null);
    setNoSpeechFound(false);
    setContext("");
    setProcessError("");
    setSubmitError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const hasAudio = !!prepared;
  const anySubmitting = !!submitting;
  // Sept 20, 2026: "still working" progress indicator for Deep Investigation
  // — see lib/use-elapsed-seconds.ts.
  const deepElapsed = useElapsedSeconds(submitting === "combined-deep" || submitting === "audio-deep");

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push("/")}>
          {t("nav.back")}
        </button>
        <div className="credits">{t("nav.credits")}</div>
      </nav>
      <section className="verify">
        <p className="eyebrow">{t("audio.eyebrow")}</p>
        <h1>{t("audio.heading")}</h1>
        <p className="sub">{t("audio.sub")}</p>

        {!hasAudio && (
          <>
            <input
              ref={fileInputRef}
              id="audio-file"
              type="file"
              accept="audio/*"
              className="qr-file-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
            <label htmlFor="audio-file" className="primary-link">
              {processing ? t("status.processing") : t("audio.chooseFile")}
            </label>
            {processError && <p className="error">{processError}</p>}
            <p className="hint">
              {t("audio.hintPhotoText")} <Link href="/verify/image">{t("hint.checkIt")}</Link>
            </p>
            <p className="hint">
              {t("audio.hintVideoText")} <Link href="/verify/video">{t("hint.checkIt")}</Link>
            </p>
          </>
        )}

        {hasAudio && processing && <p className="hint">{t("status.transcribing")}</p>}

        {hasAudio && !processing && transcript && (
          <div className="qr-decoded">
            <span>{t("transcript.badge")}</span>
            <textarea
              className="context-textarea"
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              maxLength={10000}
            />
            <p className="hint">{t("audio.transcriptHint")}</p>
            <p className="hint">{t("audio.combinedHint")}</p>
            {/* Sept 23, 2026: Quick Check first, Deep Investigation second,
                both styled identically (neither uses "secondary") — a
                standing convention now applied across every feature's
                QC/DI pair. "Choose Another" moves after them since it
                isn't part of that pair. */}
            <div className="result-actions">
              <button onClick={() => submitCombined("quick")} disabled={anySubmitting}>
                {submitting === "combined-quick" ? t("claim.checking") : t("claim.quickCheck")}
              </button>
              <button onClick={() => submitCombined("deep")} disabled={anySubmitting}>
                {submitting === "combined-deep"
                  ? `${t("claim.investigating")} (${deepElapsed}s)`
                  : t("claim.deepInvestigation")}
              </button>
              <button className="secondary" onClick={reset} disabled={anySubmitting}>
                {t("action.chooseAnother")}
              </button>
            </div>
            {submitError && <p className="error">{submitError}</p>}
          </div>
        )}

        {hasAudio && !processing && noSpeechFound && (
          <div className="qr-decoded">
            <span>{t("noSpeech.badge")}</span>
            <p>{t("audio.noSpeechBody")}</p>
            <p className="hint">{t("audio.noSpeechHint")}</p>
            <textarea
              className="context-textarea"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder={t("audio.contextPlaceholder")}
              maxLength={500}
            />
            {/* Sept 23, 2026: Quick Check first, Deep Investigation second,
                both styled identically — see the identical comment above
                on the combined-transcript block. */}
            <div className="result-actions">
              <button onClick={() => submitAudio("quick")} disabled={anySubmitting}>
                {submitting === "audio-quick" ? t("claim.checking") : t("claim.quickCheck")}
              </button>
              <button onClick={() => submitAudio("deep")} disabled={anySubmitting}>
                {submitting === "audio-deep"
                  ? `${t("claim.investigating")} (${deepElapsed}s)`
                  : t("claim.deepInvestigation")}
              </button>
              <button className="secondary" onClick={reset} disabled={anySubmitting}>
                {t("action.chooseAnother")}
              </button>
            </div>
            {submitError && <p className="error">{submitError}</p>}
          </div>
        )}
      </section>
    </main>
  );
}
