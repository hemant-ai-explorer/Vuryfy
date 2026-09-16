"use client";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";

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
// operate on "text-shaped input" regardless of this label). Only the
// on-screen copy (eyebrow/heading/placeholder) differs by `?type=`, kept
// in one COPY table below rather than as two separate page files, since
// there is no real behavioral difference to justify duplicating the form.
//
// The old app/verify/page.tsx (Quick-Check-only) and app/deep/page.tsx
// (Deep-Investigation-only) are left in place, not deleted — they're no
// longer linked from the home screen, but nothing else in the app links
// to them either (confirmed via a full grep), so leaving them costs
// nothing and avoids an unnecessary deletion via the device bridge, which
// can't delete files on the user's machine directly.
const COPY: Record<
  "text" | "url",
  { eyebrow: string; heading: string; sub: string; placeholder: string }
> = {
  text: {
    eyebrow: "VERIFY TEXT",
    heading: "What should we verify?",
    sub: "Paste a claim or statement, then choose Quick Check for a fast answer or Deep Investigation for a more thorough one.",
    placeholder: "Paste a claim or statement…",
  },
  url: {
    eyebrow: "VERIFY URL/CLAIMS",
    heading: "What link or claim should we verify?",
    sub: "Paste a URL, or a claim about one, then choose Quick Check for a fast answer or Deep Investigation for a more thorough one.",
    placeholder: "Paste a URL, link, or claim…",
  },
};

function ClaimForm() {
  const router = useRouter();
  const supabase = createClient();
  const searchParams = useSearchParams();
  const type: "text" | "url" = searchParams.get("type") === "url" ? "url" : "text";
  const copy = COPY[type];
  const backHref = `/verify/claim?type=${type}`;

  const [claim, setClaim] = useState("");
  const [submitting, setSubmitting] = useState<"quick" | "deep" | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.replace("/login");
    });
  }, [router, supabase]);

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
      const d = await r.json();
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
          ← Back
        </button>
        <div className="credits">Credits</div>
      </nav>
      <section className="verify">
        <p className="eyebrow">{copy.eyebrow}</p>
        <h1>{copy.heading}</h1>
        <p className="sub">{copy.sub}</p>
        <textarea
          value={claim}
          onChange={(e) => setClaim(e.target.value)}
          placeholder={copy.placeholder}
          maxLength={10000}
        />
        <div className="actions">
          <span>{claim.length}/10,000</span>
        </div>
        <div className="result-actions">
          <button
            className="secondary"
            onClick={() => submit("deep")}
            disabled={!!submitting || claim.trim().length < 5}
          >
            {submitting === "deep" ? "Investigating…" : "Deep Investigation"}
          </button>
          <button onClick={() => submit("quick")} disabled={!!submitting || claim.trim().length < 5}>
            {submitting === "quick" ? "Checking…" : "Quick Check"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        <p className="hint">
          Have a QR code instead? <Link href="/verify/qr">Scan it</Link>
        </p>
        <p className="hint">
          Got a photo? <Link href="/verify/image">Check it</Link>
        </p>
        <p className="hint">
          Got audio? <Link href="/verify/audio">Check it</Link>
        </p>
        <p className="hint">
          Got a video? <Link href="/verify/video">Check it</Link>
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
