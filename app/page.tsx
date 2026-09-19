"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useLanguage } from "@/app/providers/language-provider";
import { WHATSAPP_FEATURE_ENABLED } from "@/lib/whatsapp";

type Credits = { quick_checks: number; deep_investigations: number; total: number };
type Subscription = {
  plan: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end: string;
} | null;
type PendingWhatsApp = { id: string; input_type: "text" | "image"; preview: string | null } | null;

// Localized Sept 16, 2026 as part of Phase 1 of the multilingual rollout —
// see lib/translations.ts's header for scope. Every static string here now
// comes from useLanguage()'s t(), so this screen renders in whatever
// language the signed-in user chose during sign-up (or later in Settings).
// A signed-out visitor always sees English, since there's no preference to
// read yet at that point.
export default function Home() {
  const router = useRouter();
  const supabase = createClient();
  const { t } = useLanguage();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [credits, setCredits] = useState<Credits | null>(null);
  const [subscription, setSubscription] = useState<Subscription>(null);
  // WhatsApp media-first flow (Part 13 rework, Sept 18, 2026) — see
  // supabase/migrations/0017_whatsapp_submissions.sql. English-only for
  // now, same flagged, known i18n gap as the rest of the WhatsApp UI.
  const [pendingWa, setPendingWa] = useState<PendingWhatsApp>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setSignedIn(!!data.user));
  }, [supabase]);

  useEffect(() => {
    if (!signedIn) return;
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setCredits(d.credits);
        setSubscription(d.subscription);
      })
      .catch(() => {});
    // Feature paused — see lib/whatsapp.ts's WHATSAPP_FEATURE_ENABLED
    // comment. Skip the check entirely rather than fetch-then-hide.
    if (WHATSAPP_FEATURE_ENABLED) {
      fetch("/api/whatsapp/pending")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setPendingWa(d?.pending ?? null))
        .catch(() => {});
    }
  }, [signedIn]);

  async function logout() {
    await supabase.auth.signOut();
    setSignedIn(false);
    router.refresh();
  }

  function continueWhatsApp() {
    if (!pendingWa) return;
    if (pendingWa.input_type === "image") {
      router.push(`/verify/image?whatsapp=${pendingWa.id}`);
    } else {
      router.push(`/verify/claim?type=text&whatsapp=${pendingWa.id}`);
    }
  }

  if (signedIn === null) return null;

  if (!signedIn)
    return (
      <main className="shell">
        <nav>
          <div className="brand">Vuryfy</div>
          <div className="credits">{t("nav.credits")} · —</div>
        </nav>
        <section className="hero">
          <p className="eyebrow">{t("landing.eyebrow")}</p>
          <h1>{t("landing.heading")}</h1>
          <p className="sub">{t("landing.sub")}</p>
          <div className="home-actions">
            <Link className="primary-link" href="/login?intent=signup">
              {t("landing.signUp")}
            </Link>
            <Link className="secondary-link" href="/login?intent=signin">
              {t("landing.signIn")}
            </Link>
          </div>
          <p className="hint">{t("landing.hint")}</p>
        </section>
      </main>
    );

  return (
    <main className="shell">
      <nav>
        <div className="brand">Vuryfy</div>
        <div className="credits">{t("nav.credits")} · {credits?.total ?? "…"}</div>
      </nav>
      <section className="hero">
        <p className="eyebrow">{t("home.eyebrow")}</p>
        <h1>{t("home.heading")}</h1>
        <p className="sub">{t("home.sub")}</p>
        {WHATSAPP_FEATURE_ENABLED && pendingWa && (
          <div className="panel" style={{ marginBottom: 20 }}>
            <p style={{ margin: "0 0 8px", fontWeight: 600 }}>
              {pendingWa.input_type === "image"
                ? "You have a photo submitted via WhatsApp"
                : "You have a claim submitted via WhatsApp"}
            </p>
            {pendingWa.preview && (
              <p className="sub" style={{ fontSize: 14, margin: "0 0 12px" }}>
                &ldquo;{pendingWa.preview}
                {pendingWa.preview.length >= 80 ? "…" : ""}&rdquo;
              </p>
            )}
            <button onClick={continueWhatsApp}>Continue</button>
          </div>
        )}
        <div className="home-actions">
          <Link className="primary-link" href="/verify/claim?type=text">
            {t("home.verifyText")}
          </Link>
          <Link className="secondary-link" href="/verify/claim?type=url">
            {t("home.verifyUrl")}
          </Link>
          <Link className="secondary-link" href="/verify/qr">
            {t("home.verifyQr")}
          </Link>
          <Link className="secondary-link" href="/verify/image">
            {t("home.verifyPhoto")}
          </Link>
          <Link className="secondary-link" href="/verify/audio">
            {t("home.verifyAudio")}
          </Link>
          <Link className="secondary-link" href="/verify/video">
            {t("home.verifyVideo")}
          </Link>
        </div>
        <div className="balance-card">
          <div>
            <span>{t("home.quickChecks")}</span>
            <strong>{credits?.quick_checks ?? "—"}</strong>
          </div>
          <div>
            <span>{t("home.deepInvestigations")}</span>
            <strong>{credits?.deep_investigations ?? "—"}</strong>
          </div>
        </div>
        <div className="home-links">
          <button className="text-button" onClick={() => router.push("/saved")}>
            {t("home.history")}
          </button>
          <button className="text-button" onClick={() => router.push("/settings")}>
            {t("home.settings")}
          </button>
          <button className="text-button" onClick={logout}>
            {t("home.signOut")}
          </button>
        </div>
        {subscription?.cancel_at_period_end && (
          <p className="hint">{t("home.subEnding")}</p>
        )}
        {!subscription && <p className="hint">{t("home.noPlan")}</p>}
      </section>
    </main>
  );
}
