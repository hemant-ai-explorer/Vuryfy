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

  // Retries transient failures before settling into the English fail-open
  // — added Sept 16, 2026. Confirmed live (via a direct hit to a fresh
  // `npm run dev` process) that /api/preferences can come back non-OK for
  // reasons that have nothing to do with the user's actual sign-in state —
  // a dev-server cold-start hiccup while routes are still compiling, or a
  // dropped connection right after a restart. Previously ANY single
  // failure — even one totally unrelated to auth — permanently set
  // hasPreference=false and left `language` stuck at "en" for the rest of
  // that tab's life, since refresh() only ever runs once (the effect below
  // has no polling/retry of its own) and a stored "hi" preference doesn't
  // get a second chance until a full page reload. A real 401 ("Not signed
  // in") is a clean, well-defined answer from this route and is NOT
  // retried — only network errors and non-401 non-OK statuses (5xx, or a
  // transient proxy/dev-server error) get a couple of quick retries first.
  const refresh = useCallback(async () => {
    setLoading(true);
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
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
          setLoading(false);
          return;
        }
        if (res.status === 401) {
          // Genuinely not signed in — no point retrying that.
          setHasPreference(false);
          setLoading(false);
          return;
        }
        console.error(
          `[language-provider] /api/preferences returned ${res.status} (attempt ${attempt}/${maxAttempts})`
        );
      } catch (err) {
        console.error(
          `[language-provider] /api/preferences fetch failed (attempt ${attempt}/${maxAttempts}):`,
          err
        );
      }
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    }
    // Every attempt failed for a non-401 reason — fail open to English
    // rather than blocking the page, same as before.
    setHasPreference(false);
    setLoading(false);
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
