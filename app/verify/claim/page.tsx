"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { useLanguage } from "@/app/providers/language-provider";
import { parseJsonResponse } from "@/lib/safe-json";
import { WHATSAPP_FEATURE_ENABLED } from "@/lib/whatsapp";
import { useElapsedSeconds } from "@/lib/use-elapsed-seconds";

// Unified text-entry confirm screen — Sept 16, 2026. Replaces the home
// screen's old mode-first pair ("Start a Quick Check" / "Start a Deep
// Investigation") with a content-type-first pair ("Verify Text" /
// "Verify URL/Claims"), per the user's explicit request. This brings
// text/link input in line with the standing cross-cutting pattern every
// other input type (QR, image, audio, video) already follows: type/select
// the content once, then choose Quick Check or Deep Investigation from
// buttons on that same screen — see app/verify/qr/page.tsx's header for
// where that pattern was first locked.
//
// "Verify Text" and "Verify URL/Claims" are two labeled entry points into
// the exact same textarea and the exact same submission path (input_type
// stays "text" for both, matching the pre-existing convention: the old
// app/verify/page.tsx already accepted "a claim, statement, or URL" under
// input_type "text", so a URL was never treated differently on the
// backend — see lib/detect-payment-receipt.ts / detect-payment-request.ts
// and the shared quick-check/deep-investigation pipelines, all of which
// operate on "text-shaped input" regardless of this label).
//
// Localized Sept 16, 2026 (Phase 1 of the multilingual rollout, see
// lib/translations.ts) — the per-type copy that used to live in a local
// COPY table now comes from the shared dictionary via useLanguage()'s t(),
// keyed by "claim.text*" / "claim.url*".
//
// The old app/verify/page.tsx (Quick-Check-only) and app/deep/page.tsx
// (Deep-Investigation-only) are left in place, not deleted — they're no
// longer linked from the home screen, but nothing else in the app links
// to them either (confirmed via a full grep), so leaving them costs
// nothing and avoids an unnecessary deletion via the device bridge, which
// can't delete files on the user's machine directly.
function ClaimForm() {
  const router = useRouter();
  const supabase = createClient();
  const searchParams = useSearchParams();
  const { t } = useLanguage();
  const type: "text" | "url" = searchParams.get("type") === "url" ? "url" : "text";
  const backHref = `/verify/claim?type=${type}`;
  const whatsappId = searchParams.get("whatsapp");

  const copy =
    type === "url"
      ? {
          eyebrow: t("claim.urlEyebrow"),
          heading: t("claim.urlHeading"),
          sub: t("claim.urlSub"),
          placeholder: t("claim.urlPlaceholder"),
        }
      : {
          eyebrow: t("claim.textEyebrow"),
          heading: t("claim.textHeading"),
          sub: t("claim.textSub"),
          placeholder: t("claim.textPlaceholder"),
        };

  const [claim, setClaim] = useState("");
  const [submitting, setSubmitting] = useState<"quick" | "deep" | null>(null);
  const [error, setError] = useState("");
  // Sept 20, 2026: lightweight "still working" progress indicator for Deep
  // Investigation — see lib/use-elapsed-seconds.ts's header. A real video DI
  // took ~50s with nothing but a static "Investigating…" label to look at.
  const deepElapsed = useElapsedSeconds(submitting === "deep");
  // WhatsApp media-first flow (Part 13 rework, Sept 18, 2026) — see
  // supabase/migrations/0017_whatsapp_submissions.sql. A linked phone can
  // forward text/a link OR a photo (app/verify/image/page.tsx handles the
  // photo case); this screen just pre-fills the textarea from a pending
  // text submission when arriving via ?whatsapp=<id> — the rest of the
  // flow (choosing Quick Check vs Deep Investigation) is unchanged.
  const [waCode, setWaCode] = useState<{ code: string; waLink: string } | null>(null);
  const [waLoading, setWaLoading] = useState(false);
  const [waError, setWaError] = useState("");
  const [loadingWaSubmission, setLoadingWaSubmission] = useState(!!whatsappId);

  async function getWhatsAppLink() {
    setWaLoading(true);
    setWaError("");
    try {
      const r = await fetch("/api/whatsapp/link-code", { method: "POST" });
      const d = await parseJsonResponse(r);
      if (!r.ok) throw new Error(d.error || "Couldn't create a WhatsApp link.");
      setWaCode({ code: d.code, waLink: d.wa_link });
    } catch (e: any) {
      setWaError(e.message);
    } finally {
      setWaLoading(false);
    }
  }

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.replace("/login");
    });
  }, [router, supabase]);

  useEffect(() => {
    if (!whatsappId) return;
    setLoadingWaSubmission(true);
    fetch(`/api/whatsapp/pending/${whatsappId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.input_type === "text" && d.claim_text) setClaim(d.claim_text);
      })
      .catch(() => {})
      .finally(() => setLoadingWaSubmission(false));
  }, [whatsappId]);

  async function submit(mode: "quick" | "deep") {
    if (claim.trim().length < 5) return;
    setSubmitting(mode);
    setError("");
    try {
      const endpoint = mode === "quick" ? "/api/verify" : "/api/deep";
      const r = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim: claim.trim(), input_type: "text" }),
      });
      const d = await parseJsonResponse(r);
      if (!r.ok) throw new Error(d.error || (mode === "quick" ? "Verification failed" : "Investigation failed"));
      sessionStorage.setItem("vuryfy_result", JSON.stringify({ ...d, return_to: backHref }));
      router.push(`/result?id=${d.id}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(null);
    }
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
        <p className="eyebrow">{copy.eyebrow}</p>
        <h1>{copy.heading}</h1>
        <p className="sub">{copy.sub}</p>
        {loadingWaSubmission && <p className="hint">Loading your claim from WhatsApp…</p>}
        <textarea
          value={claim}
          onChange={(e) => setClaim(e.target.value)}
          placeholder={copy.placeholder}
          maxLength={10000}
        />
        <div className="actions">
          <span>{claim.length}/10,000</span>
        </div>
        {/* Sept 20, 2026: a disabled button never fires onClick, so there's
            no reactive event to hang a "why didn't this work" message off
            of — this proactive hint shows the same disabled condition
            (non-empty but under 5 chars) before the user even presses
            anything, rather than silently doing nothing on click. */}
        {claim.trim().length > 0 && claim.trim().length < 5 && !submitting && (
          <p className="hint">{t("claim.minLengthHint")}</p>
        )}
        <div className="result-actions">
          <button
            className="secondary"
            onClick={() => submit("deep")}
            disabled={!!submitting || claim.trim().length < 5}
          >
            {submitting === "deep" ? `${t("claim.investigating")} (${deepElapsed}s)` : t("claim.deepInvestigation")}
          </button>
          <button onClick={() => submit("quick")} disabled={!!submitting || claim.trim().length < 5}>
            {submitting === "quick" ? t("claim.checking") : t("claim.quickCheck")}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        {/* WhatsApp media-first flow — paused Sept 19, 2026, see
            lib/whatsapp.ts's WHATSAPP_FEATURE_ENABLED comment. Panel hidden
            entirely rather than shown disabled, until it relaunches
            alongside Instagram/Facebook. */}
        {WHATSAPP_FEATURE_ENABLED && (
          <div className="panel" style={{ marginTop: 28 }}>
            <h2 style={{ fontSize: 16 }}>Prefer WhatsApp?</h2>
            {waCode ? (
              <>
                <p className="sub" style={{ fontSize: 14, margin: "0 0 14px" }}>
                  Tap below and send the pre-filled code. Once connected, forward text, a link, or a photo — each one
                  will show up here in the app for you to check, for the next 24 hours.
                </p>
                <a
                  className="primary-link"
                  href={waCode.waLink}
                  target="_blank"
                  rel="noreferrer"
                  style={{ display: "block", textAlign: "center" }}
                >
                  Open WhatsApp
                </a>
              </>
            ) : (
              <button className="secondary" onClick={getWhatsAppLink} disabled={waLoading}>
                {waLoading ? "Generating…" : "Get a WhatsApp link"}
              </button>
            )}
            {waError && <p className="error">{waError}</p>}
          </div>
        )}
        <p className="hint">
          {t("claim.hintQrText")} <Link href="/verify/qr">{t("claim.hintQrLink")}</Link>
        </p>
        <p className="hint">
          {t("claim.hintPhotoText")} <Link href="/verify/image">{t("claim.hintPhotoLink")}</Link>
        </p>
        <p className="hint">
          {t("claim.hintAudioText")} <Link href="/verify/audio">{t("claim.hintAudioLink")}</Link>
        </p>
        <p className="hint">
          {t("claim.hintVideoText")} <Link href="/verify/video">{t("claim.hintVideoLink")}</Link>
        </p>
      </section>
    </main>
  );
}

// useSearchParams() requires a Suspense boundary at build time (the same
// Vercel build failure hit and fixed for the old /deep/status page — see
// architecture-decisions.md's "Bugs found in the existing local code"
// entry — applied here proactively rather than discovered at deploy time.
export default function VerifyClaimPage() {
  return (
    <Suspense fallback={null}>
      <ClaimForm />
    </Suspense>
  );
}
