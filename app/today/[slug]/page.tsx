"use client";
import { Suspense, useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useLanguage } from "@/app/providers/language-provider";
import { apiUrl } from "@/lib/api-fetch";
import { isSupportedLanguage, translateVerdict, type Language } from "@/lib/translations";

// Public Daily Check detail page — Nov 21, 2026. See
// app/api/today/[slug]/route.ts and lib/daily-check.ts for the pipeline
// and API behind this. Deliberately works with NO login at all — a
// forwarded WhatsApp link may land on someone who has never opened
// Vuryfy — which is also why this is its own small page rather than
// reusing app/result/page.tsx (that page assumes a signed-in viewer with
// credits/history). Visual language (the .result/.eyebrow/.verdict/
// .claim/.explanation/.evidence/.caveats classes) is deliberately copied
// from app/result/page.tsx so a Daily Check reads as the same product,
// not a bolted-on page.
//
// Excluded from the Capacitor static export in scripts/build-capacitor.js
// (same reason as app/share/[id]: a dynamic route with no
// generateStaticParams, meant to be opened from outside the app, same as
// every share-style link in this project).
interface DailyCheckDetail {
  slug: string;
  claim: string;
  verdict: string;
  confidence: number;
  headline: string;
  summary: string;
  teaser: string;
  caveats: string[];
  sources: { title: string; url: string }[];
  published_at: string;
  language: Language;
}

function DailyCheckView() {
  const params = useParams<{ slug: string }>();
  const searchParams = useSearchParams();
  const { language: accountLanguage, t } = useLanguage();

  const [data, setData] = useState<DailyCheckDetail | null>(null);
  const [notFound, setNotFound] = useState(false);

  // A forwarded link can carry ?lang= so it opens in the language the
  // sender intended for that specific recipient, independent of whatever
  // language the viewer's own Vuryfy account (if any) is set to.
  const langParam = searchParams.get("lang");
  const effectiveLanguage: Language = isSupportedLanguage(langParam) ? langParam : accountLanguage;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setNotFound(false);
      try {
        const res = await fetch(apiUrl(`/api/today/${params.slug}?lang=${effectiveLanguage}`));
        if (!res.ok) {
          if (!cancelled) setNotFound(true);
          return;
        }
        const json = await res.json();
        if (!cancelled) setData(json);
      } catch {
        if (!cancelled) setNotFound(true);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [params.slug, effectiveLanguage]);

  if (notFound) {
    return (
      <main className="shell">
        <nav>
          <div className="brand">Vuryfy</div>
        </nav>
        <section className="result">
          <p className="eyebrow">{t("dailyCheck.title")}</p>
          <h1 style={{ fontSize: 32 }}>{t("dailyCheck.notFoundHeading")}</h1>
          <p className="sub">{t("dailyCheck.notFoundBody")}</p>
          <Link className="primary-link" href="/">
            {t("dailyCheck.openApp")}
          </Link>
        </section>
      </main>
    );
  }

  if (!data) {
    return (
      <main className="shell">
        <nav>
          <div className="brand">Vuryfy</div>
        </nav>
        <section className="result">
          <p className="eyebrow">{t("dailyCheck.title")}</p>
        </section>
      </main>
    );
  }

  const isScam = data.verdict === "Scam";

  // "Forward to any WhatsApp number" — Nov 24, 2026. Deliberately a wa.me
  // share link rather than a Vuryfy-sends-it-for-you feature: wa.me opens
  // the READER's own WhatsApp client with this text pre-filled, and they
  // pick any contact or group themselves from WhatsApp's own picker. That
  // satisfies "forward to any number" directly, costs nothing, needs no
  // backend route or auth, and — critically — never routes through
  // Vuryfy's own WhatsApp Business number, so it carries none of the
  // spam/reputation risk that Vuryfy-initiated messages to arbitrary
  // third parties would carry for a newly-set-up WABA. Uses the teaser
  // (not the full summary) so the curiosity-gap behavior is consistent
  // between the original WhatsApp send and whatever the reader forwards.
  const shareUrl = typeof window !== "undefined" ? window.location.href : `${process.env.NEXT_PUBLIC_APP_URL || "https://app.vuryfy.com"}/today/${data.slug}`;
  const shareText = `${data.headline}\n\n${data.teaser}\n\n${shareUrl}`;
  const whatsappShareHref = `https://wa.me/?text=${encodeURIComponent(shareText)}`;

  return (
    <main className="shell">
      <nav>
        <div className="brand">Vuryfy</div>
      </nav>
      <section className="result">
        <p className="eyebrow">{t("dailyCheck.title")}</p>

        {isScam ? (
          <div className="scam-warning">
            <span>{t("result.scamWarning")}</span>
            <div className="verdict">{translateVerdict(effectiveLanguage, data.verdict)}</div>
          </div>
        ) : (
          <div className="verdict">{translateVerdict(effectiveLanguage, data.verdict)}</div>
        )}

        <div className="claim">
          <span>{t("dailyCheck.claimLabel")}</span>
          <p>{data.claim}</p>
        </div>

        <div className="explanation">
          <span>{t("result.whyLabel")}</span>
          <p>{data.summary}</p>
        </div>

        {data.sources.length > 0 && (
          <div className="evidence">
            <span>{t("dailyCheck.sourcesHeading")}</span>
            {data.sources.map((s, i) => (
              <a key={i} href={s.url} target="_blank" rel="noreferrer">
                <strong>{s.title}</strong>
                <small>{s.url}</small>
              </a>
            ))}
          </div>
        )}

        {data.caveats.length > 0 && (
          <div className="caveats">
            <span>{t("dailyCheck.caveatsHeading")}</span>
            {data.caveats.map((c, i) => (
              <p key={i}>{c}</p>
            ))}
          </div>
        )}

        <div className="result-actions">
          <a className="primary-link" href={whatsappShareHref} target="_blank" rel="noreferrer">
            {t("dailyCheck.shareWhatsapp")}
          </a>
          {/* Nov 24, 2026: names the actual payoff ("like this one") right
              above the signup CTA, instead of a bare "Open Vuryfy" link
              into a generic pitch screen — this is the highest-intent
              moment in the whole page, right after the reader has just
              seen a real scam explained. Links straight to the signup
              intent rather than "/" for the same reason: a reader who
              just read a Daily Check already has the context a first-time
              visitor would otherwise need from the landing page. */}
          <p className="sub" style={{ textAlign: "center", margin: "2px 0 0" }}>
            {t("dailyCheck.openAppPrompt")}
          </p>
          <Link className="primary-link" href="/login?intent=signup">
            {t("dailyCheck.openApp")}
          </Link>
        </div>
      </section>
    </main>
  );
}

export default function DailyCheckPage() {
  return (
    <Suspense fallback={null}>
      <DailyCheckView />
    </Suspense>
  );
}
