"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { translate, isSupportedLanguage, type Language } from "@/lib/translations";

// Client-side language context — Phase 1 of the multilingual rollout (see
// lib/translations.ts's header for the full rationale and current scope).
// Wraps the whole app (see app/layout.tsx) so any page can call
// useLanguage() for the current language, a t() translate helper, and a
// setLanguage() that persists the change via /api/preferences (used by
// both the signup language-picker step and the settings page).
//
// `hasPreference` distinguishes "no /api/preferences row yet" (a genuinely
// new sign-up, or a user who signed up before this feature existed) from
// "preference loaded and it's English" — app/login/page.tsx uses this to
// decide whether to show the language-picker step after a fresh OTP
// verification. Defaults to "en" while loading/unauthenticated so pages
// never flash untranslated placeholder text.
interface LanguageContextValue {
  language: Language;
  hasPreference: boolean | null; // null = not yet checked
  loading: boolean;
  t: (key: string) => string;
  setLanguage: (language: Language) => Promise<void>;
  refresh: () => Promise<void>;
}

const LanguageContext = createContext<LanguageContextValue>({
  language: "en",
  hasPreference: null,
  loading: true,
  t: (key: string) => translate("en", key),
  setLanguage: async () => {},
  refresh: async () => {},
});

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>("en");
  const [hasPreference, setHasPreference] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/preferences");
      if (res.ok) {
        const data = await res.json();
        if (isSupportedLanguage(data.language)) {
          setLanguageState(data.language);
          setHasPreference(true);
        } else {
          setHasPreference(false);
        }
      } else {
        // Not signed in, or the lookup failed — fail open to English and
        // treat as "no preference yet" rather than blocking the page.
        setHasPreference(false);
      }
    } catch {
      setHasPreference(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setLanguage = useCallback(async (next: Language) => {
    setLanguageState(next);
    setHasPreference(true);
    try {
      await fetch("/api/preferences", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: next }),
      });
    } catch {
      // Non-fatal — the UI already reflects the choice; a failed save just
      // means it may ask again next session. Never block the user's flow
      // on a preference-save failure.
    }
  }, []);

  const t = useCallback((key: string) => translate(language, key), [language]);

  const value = useMemo(
    () => ({ language, hasPreference, loading, t, setLanguage, refresh }),
    [language, hasPreference, loading, t, setLanguage, refresh]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage() {
  return useContext(LanguageContext);
}
