"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useLanguage } from "@/app/providers/language-provider";
import { SUPPORTED_LANGUAGES, type Language } from "@/lib/translations";

// Minimal settings page — Sept 16, 2026. Created specifically to hold the
// language preference the multilingual rollout needs a persistent home
// for (see lib/translations.ts and app/login/page.tsx's language-picker
// step). Deliberately just language for now — Credits & Subscription were
// removed from the home screen's footer with the explicit intent of
// moving here once billing is built (see architecture-decisions.md's
// entry on the home-screen relabeling); this page is where that lands
// next, not a placeholder to be replaced later.
export default function SettingsPage() {
  const router = useRouter();
  const supabase = createClient();
  const { language, t, setLanguage } = useLanguage();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.replace("/login");
    });
  }, [router, supabase]);

  async function pick(next: Language) {
    if (next === language) return;
    setSaving(true);
    setSaved(false);
    await setLanguage(next);
    setSaving(false);
    setSaved(true);
  }

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push("/")}>
          {t("nav.back")}
        </button>
      </nav>
      <section className="verify">
        <p className="eyebrow">{t("settings.eyebrow")}</p>
        <h1>{t("settings.heading")}</h1>

        <div className="panel" style={{ width: "100%", marginTop: 20 }}>
          <h2>{t("settings.languageLabel")}</h2>
          <p className="sub" style={{ margin: "0 0 18px", fontSize: 15 }}>
            {t("settings.languageSub")}
          </p>
          <div className="home-actions" style={{ justifyContent: "flex-start" }}>
            {SUPPORTED_LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                className={lang.code === language ? "primary-link" : "secondary-link"}
                style={{ width: "auto", height: 48, padding: "0 20px", border: 0, cursor: "pointer" }}
                onClick={() => pick(lang.code)}
                disabled={saving}
              >
                {lang.nativeLabel}
              </button>
            ))}
          </div>
          {saving && <p className="hint">{t("settings.saving")}</p>}
          {saved && !saving && <p className="hint">{t("settings.saved")}</p>}
        </div>

        <p className="hint" style={{ marginTop: 28 }}>
          {t("settings.moreComingSoon")}
        </p>
      </section>
    </main>
  );
}
