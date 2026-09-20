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
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  // Delete my account — Sept 20, 2026. Implements Part 15's locked "delete
  // account" user right (see app/api/account/delete/route.ts for what
  // actually gets deleted/anonymized). English-only for now — same flagged,
  // known i18n gap already used for newer, smaller features like the
  // WhatsApp UI and the signup name field, rather than every one of these
  // strings being run through 9 language dictionaries up front.
  //
  // No modal/confirm-dialog component exists anywhere in this app, so this
  // is an inline two-step reveal instead: the button below only shows a
  // warning panel with the real destructive action; nothing irreversible
  // happens until that second, explicit click.
  async function deleteAccount() {
    setDeleting(true);
    setDeleteError(null);
    try {
      const res = await fetch("/api/account/delete", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setDeleteError(body?.error ?? "Try Again");
        setDeleting(false);
        return;
      }
      await supabase.auth.signOut();
      router.push("/?accountDeleted=1");
      router.refresh();
    } catch {
      setDeleteError("Try Again");
      setDeleting(false);
    }
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

        <div className="panel" style={{ width: "100%", marginTop: 28 }}>
          {!showDeleteConfirm ? (
            <button
              className="text-button"
              style={{ color: "#b42318" }}
              onClick={() => {
                setShowDeleteConfirm(true);
                setDeleteError(null);
              }}
            >
              Delete my account
            </button>
          ) : (
            <>
              <div className="scam-warning">
                <p className="caution" style={{ margin: 0 }}>
                  This permanently deletes your account, including your
                  verification history, credit balance, and saved
                  preferences. This can&apos;t be undone.
                </p>
              </div>
              {deleteError && (
                <p className="hint" style={{ color: "#b42318" }}>
                  {deleteError}
                </p>
              )}
              <div className="result-actions" style={{ marginTop: 14 }}>
                <button
                  className="secondary"
                  disabled={deleting}
                  onClick={() => {
                    setShowDeleteConfirm(false);
                    setDeleteError(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  style={{ background: "#b42318" }}
                  disabled={deleting}
                  onClick={deleteAccount}
                >
                  {deleting ? "Deleting…" : "Yes, permanently delete my account"}
                </button>
              </div>
            </>
          )}
        </div>

        <div className="home-links" style={{ marginTop: 28 }}>
          <button className="text-button" onClick={logout}>
            {t("home.signOut")}
          </button>
        </div>
      </section>
    </main>
  );
}
