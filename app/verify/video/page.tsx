"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { uploadVideoToStorage, deleteUploadedVideo, type UploadedVideo } from "@/lib/prepare-video-upload";
import { useLanguage } from "@/app/providers/language-provider";
import { parseJsonResponse } from "@/lib/safe-json";
import { useElapsedSeconds } from "@/lib/use-elapsed-seconds";

// Video input — the last step in the locked media-type build order (text +
// link -> QR -> image -> audio -> video), shipping after audio per the
// user's explicit sequencing call. Mirrors app/verify/audio/page.tsx as
// closely as possible, built combined from the start (see
// app/api/verify-video-combined/route.ts's header) rather than repeating
// audio's original "two buttons on one screen" mistake and fixing it
// later.
//
// Same free-preview-then-charge shape as audio: choosing a video triggers
// an upload step followed by a brief "Transcribing…" step (video's audio
// track, via /api/transcribe-video) before the transcript block appears —
// no credit charged until a Quick Check or Deep Investigation button is
// explicitly pressed. When a transcript is found, ONE Quick Check button
// and ONE Deep Investigation button run both the transcript fact-check and
// the video authenticity/deepfake analysis together (1 credit total). When
// no speech is found, only the video-only authenticity check is offered.
//
// Sept 15, 2026: the video now uploads DIRECTLY to Supabase Storage (see
// lib/prepare-video-upload.ts's header for the full rework — a real user
// request for 3-5+ minute video support that the old inline-base64
// approach could never accommodate). The uploaded storage path is kept in
// state and reused across both the free transcribe call and the
// subsequent paid check call, rather than re-uploading the file a second
// time — the server deletes the underlying Storage object after the
// terminal check call (see the API routes' own headers).
export default function VerifyVideoPage() {
  const router = useRouter();
  const supabase = createClient();
  const { t } = useLanguage();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [uploading, setUploading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [processError, setProcessError] = useState("");
  const [uploaded, setUploaded] = useState<UploadedVideo | null>(null);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [noSpeechFound, setNoSpeechFound] = useState(false);
  const [context, setContext] = useState("");
  const [submitting, setSubmitting] = useState<
    "combined-quick" | "combined-deep" | "video-quick" | "video-deep" | null
  >(null);
  const [submitError, setSubmitError] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.replace("/login");
    });
  }, [router, supabase]);

  async function handleFile(file: File) {
    setUploading(true);
    setProcessing(false);
    setProcessError("");
    setTranscript(null);
    setNoSpeechFound(false);
    setSubmitError("");
    try {
      const video = await uploadVideoToStorage(file, supabase);
      setUploaded(video);
      setUploading(false);
      setProcessing(true);

      const r = await fetch("/api/transcribe-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storage_path: video.storagePath, mime_type: video.mimeType }),
      });
      const d = await parseJsonResponse(r);
      if (!r.ok) throw new Error(d.error || "Transcription failed");
      if (d.transcript) {
        setTranscript(d.transcript);
      } else {
        setNoSpeechFound(true);
      }
    } catch (e: any) {
      setProcessError(e.message || t("video.processError"));
    } finally {
      setUploading(false);
      setProcessing(false);
    }
  }

  // Combined check — runs both the transcript fact-check and the video
  // authenticity/deepfake analysis from one button, one credit charge.
  async function submitCombined(mode: "quick" | "deep") {
    if (!transcript || !uploaded) return;
    setSubmitting(mode === "quick" ? "combined-quick" : "combined-deep");
    setSubmitError("");
    try {
      const endpoint = mode === "quick" ? "/api/verify-video-combined" : "/api/deep-video-combined";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storage_path: uploaded.storagePath,
          mime_type: uploaded.mimeType,
          transcript,
          context: context.trim(),
        }),
      });
      const d = await parseJsonResponse(r);
      if (!r.ok) throw new Error(d.error || (mode === "quick" ? "Check failed" : "Investigation failed"));
      sessionStorage.setItem("vuryfy_result", JSON.stringify({ ...d, return_to: "/verify/video" }));
      router.push(`/result?id=${d.id}`);
    } catch (e: any) {
      setSubmitError(e.message);
    } finally {
      setSubmitting(null);
    }
  }

  // Video-only check — used only when no speech was found, so there's
  // nothing to combine with.
  async function submitVideo(mode: "quick" | "deep") {
    if (!uploaded) return;
    setSubmitting(mode === "quick" ? "video-quick" : "video-deep");
    setSubmitError("");
    try {
      const endpoint = mode === "quick" ? "/api/verify-video" : "/api/deep-video";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          storage_path: uploaded.storagePath,
          mime_type: uploaded.mimeType,
          context: context.trim(),
        }),
      });
      const d = await parseJsonResponse(r);
      if (!r.ok) throw new Error(d.error || (mode === "quick" ? "Analysis failed" : "Investigation failed"));
      sessionStorage.setItem("vuryfy_result", JSON.stringify({ ...d, return_to: "/verify/video" }));
      router.push(`/result?id=${d.id}`);
    } catch (e: any) {
      setSubmitError(e.message);
    } finally {
      setSubmitting(null);
    }
  }

  function reset() {
    // Best-effort cleanup: if the user is walking away without ever
    // running a check, delete the temp upload now rather than leaving it
    // for the video content to just sit there (see lib/prepare-video-
    // upload.ts's header — there's no scheduled cleanup job in V1, so this
    // is the main opportunistic cleanup path for an abandoned upload).
    if (uploaded) {
      deleteUploadedVideo(uploaded.storagePath, supabase);
    }
    setUploaded(null);
    setTranscript(null);
    setNoSpeechFound(false);
    setContext("");
    setProcessError("");
    setSubmitError("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const hasVideo = !!uploaded;
  const anySubmitting = !!submitting;
  // Sept 20, 2026: "still working" progress indicator for Deep Investigation
  // — a real video DI took ~50s with nothing but a static "Investigating…"
  // label to look at (see lib/use-elapsed-seconds.ts).
  const deepElapsed = useElapsedSeconds(submitting === "combined-deep" || submitting === "video-deep");

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push("/")}>
          {t("nav.back")}
        </button>
        <div className="credits">{t("nav.credits")}</div>
      </nav>
      <section className="verify">
        <p className="eyebrow">{t("video.eyebrow")}</p>
        <h1>{t("video.heading")}</h1>
        <p className="sub">{t("video.sub")}</p>

        {!hasVideo && (
          <>
            <input
              ref={fileInputRef}
              id="video-file"
              type="file"
              accept="video/*"
              className="qr-file-input"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFile(file);
              }}
            />
            <label htmlFor="video-file" className="primary-link">
              {uploading ? t("status.uploading") : processing ? t("status.processing") : t("video.chooseVideo")}
            </label>
            {processError && <p className="error">{processError}</p>}
            <p className="hint">
              {t("video.hintAudioText")} <Link href="/verify/audio">{t("hint.checkIt")}</Link>
            </p>
            <p className="hint">
              {t("video.hintPhotoText")} <Link href="/verify/image">{t("hint.checkIt")}</Link>
            </p>
          </>
        )}

        {hasVideo && uploading && <p className="hint">{t("status.uploading")}</p>}
        {hasVideo && processing && <p className="hint">{t("status.transcribing")}</p>}

        {hasVideo && !processing && transcript && (
          <div className="qr-decoded">
            <span>{t("transcript.badge")}</span>
            <textarea
              className="context-textarea"
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
              maxLength={10000}
            />
            <p className="hint">{t("video.transcriptHint")}</p>
            <p className="hint">{t("video.combinedHint")}</p>
            <div className="result-actions">
              <button className="secondary" onClick={reset} disabled={anySubmitting}>
                {t("action.chooseAnother")}
              </button>
              <button className="secondary" onClick={() => submitCombined("deep")} disabled={anySubmitting}>
                {submitting === "combined-deep"
                  ? `${t("claim.investigating")} (${deepElapsed}s)`
                  : t("claim.deepInvestigation")}
              </button>
              <button onClick={() => submitCombined("quick")} disabled={anySubmitting}>
                {submitting === "combined-quick" ? t("claim.checking") : t("claim.quickCheck")}
              </button>
            </div>
            {submitError && <p className="error">{submitError}</p>}
          </div>
        )}

        {hasVideo && !processing && noSpeechFound && (
          <div className="qr-decoded">
            <span>{t("noSpeech.badge")}</span>
            <p>{t("video.noSpeechBody")}</p>
            <p className="hint">{t("video.noSpeechHint")}</p>
            <textarea
              className="context-textarea"
              value={context}
              onChange={(e) => setContext(e.target.value)}
              placeholder={t("video.contextPlaceholder")}
              maxLength={500}
            />
            <div className="result-actions">
              <button className="secondary" onClick={reset} disabled={anySubmitting}>
                {t("action.chooseAnother")}
              </button>
              <button className="secondary" onClick={() => submitVideo("deep")} disabled={anySubmitting}>
                {submitting === "video-deep"
                  ? `${t("claim.investigating")} (${deepElapsed}s)`
                  : t("claim.deepInvestigation")}
              </button>
              <button onClick={() => submitVideo("quick")} disabled={anySubmitting}>
                {submitting === "video-quick" ? t("claim.checking") : t("claim.quickCheck")}
              </button>
            </div>
            {submitError && <p className="error">{submitError}</p>}
          </div>
        )}
      </section>
    </main>
  );
}
