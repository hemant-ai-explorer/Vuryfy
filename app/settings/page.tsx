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

  // Sept 19, 2026: Sign out moved here from the home screen's footer (which
  // also dropped its History link — see app/page.tsx) so the home footer is
  // just "Settings", and account-level actions like this one live inside
  // Settings instead. Reuses the same t("home.signOut") translation key the
  // home page already had, rather than adding a new one.
  async function logout() {
    await supabase.auth.signOut();
    router.push("/");
    router.refresh();
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
          {/* Sept 18, 2026 (later same day as the Marathi addition): switched
              from a button grid (one per SUPPORTED_LANGUAGES entry) to a
              dropdown, matching the same change on the sign-up language
              picker (app/login/page.tsx) — with 9 languages now supported, a
              button grid was getting unwieldy. Still auto-saves immediately
              on selection, same as the old onClick-per-button behavior.
              Sept 20, 2026: aria-label added — a bare <select> with no label
              association can have an accessible name that doesn't reliably
              update with the selected option across browsers/AT. */}
          <select
            value={language}
            onChange={(e) => pick(e.target.value as Language)}
            disabled={saving}
            style={{ maxWidth: 320 }}
            aria-label={t("settings.languageLabel")}
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.nativeLabel}
              </option>
            ))}
          </select>
          {saving && <p className="hint">{t("settings.saving")}</p>}
          {saved && !saving && <p className="hint">{t("settings.saved")}</p>}
        </div>

        <p className="hint" style={{ marginTop: 28 }}>
          {t("settings.moreComingSoon")}
        </p>

        <div className="home-links" style={{ marginTop: 28 }}>
          <button className="text-button" onClick={logout}>
            {t("home.signOut")}
          </button>
        </div>
      </section>
    </main>
  );
}
