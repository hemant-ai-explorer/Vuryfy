"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useLanguage } from "@/app/providers/language-provider";
import { SUPPORTED_LANGUAGES, type Language } from "@/lib/translations";

// Phone OTP via Supabase Auth directly (no custom backend endpoint —
// Supabase handles the challenge/verify state itself). Real SMS delivery
// isn't wired up yet (needs the Send SMS Hook + 2Factor/Message Central
// account); until then, add test phone numbers with fixed OTPs under
// Supabase Dashboard → Authentication → Providers → Phone → Test OTPs,
// which lets this whole flow be tested end-to-end today.
//
// Signup flow redesign — Sept 19, 2026 (see
// architecture-decisions-addendum-2026-09-19.md's "Signup flow redesign,
// built" entry, replacing the Sept 16 combined-OTP-flow design below).
// `?intent=signup` vs `?intent=signin` now changes real field behavior, not
// just copy:
//   - signup: the first screen collects Name + Language + Phone together.
//     After OTP verifies, both are saved directly against /api/preferences
//     (bypassing useLanguage()'s setLanguage(), which only accepts a
//     language) and the user is sent straight to /onboarding/payment — a
//     brand-new account never has an existing language preference, so there
//     is no need to run it through the hasPreference-based picker below.
//   - signin (or no intent, e.g. a bookmarked /login): unchanged from the
//     original design — phone + OTP only. Right after OTP verification, this
//     checks whether the user already has a stored language preference (via
//     useLanguage()'s hasPreference flag). A MISSING preference — for
//     instance, an account created before this feature existed — falls back
//     to the picker as a screen state before continuing home. An EXISTING
//     preference skips straight to "/". This fallback path intentionally
//     stays in place rather than being deleted, since it's still the only
//     way an older account without a full_name/language pair on file can
//     set one.
// `useSearchParams()` requires a Suspense boundary at build time (same
// convention as app/verify/claim/page.tsx), so the component reading it is
// wrapped below rather than exported directly.
function LoginForm() {
  const router = useRouter();
  const supabase = createClient();
  const searchParams = useSearchParams();
  const { t, hasPreference, setLanguage, refresh } = useLanguage();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpVerified, setOtpVerified] = useState(false);
  const [otp, setOtp] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingLanguage, setSavingLanguage] = useState(false);
  // Doubles as the signup screen's language dropdown and the fallback
  // language-picker step's dropdown further down. Defaults to "en".
  const [selectedLanguage, setSelectedLanguage] = useState<Language>("en");

  const intentParam = searchParams.get("intent");
  const intent: "signin" | "signup" | null =
    intentParam === "signin" ? "signin" : intentParam === "signup" ? "signup" : null;
  const isSignup = intent === "signup";
  const eyebrowStart = intent === "signin" ? t("login.eyebrowSignin") : t("login.eyebrowStart");
  const headingStart =
    intent === "signin" ? t("login.headingSignin") : intent === "signup" ? t("login.headingSignup") : t("login.headingStart");
  const subStart =
    intent === "signin" ? t("login.subSignin") : intent === "signup" ? t("login.subSignup") : t("login.subStart");

  function toE164(input: string) {
    const digits = input.replace(/\D/g, "");
    if (input.trim().startsWith("+")) return `+${digits}`;
    // Assume a bare 10-digit number is an Indian mobile number.
    if (digits.length === 10) return `+91${digits}`;
    return `+${digits}`;
  }

  async function requestOtp() {
    setLoading(true);
    setMessage("");
    const { error } = await supabase.auth.signInWithOtp({ phone: toE164(phone) });
    if (error) {
      setMessage(error.message);
    } else {
      setOtpSent(true);
      setMessage(t("login.subCode"));
    }
    setLoading(false);
  }

  async function verify() {
    setLoading(true);
    setMessage("");
    const { error } = await supabase.auth.verifyOtp({
      phone: toE164(phone),
      token: otp.trim(),
      type: "sms",
    });
    if (error) {
      setMessage(error.message);
      setLoading(false);
      return;
    }

    if (isSignup) {
      // Combined Name + Language + Phone signup: save both in one direct
      // call against /api/preferences (it accepts an optional full_name
      // alongside language specifically for this screen — see that route's
      // header comment) rather than useLanguage()'s setLanguage(), which
      // only takes a language. A brand-new signup never has an existing
      // preference, so this skips the hasPreference branch below entirely
      // and goes straight to the plan-selection stub.
      try {
        await fetch("/api/preferences", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ language: selectedLanguage, full_name: name.trim() }),
        });
      } catch (err) {
        console.error("[login] saving signup name/language failed:", err);
      }
      // justAuthenticated=true — see language-provider.tsx's refresh() header
      // comment: right after verifyOtp() resolves, the session cookie isn't
      // always readable yet by this immediate /api/preferences call, so a
      // 401 here should retry rather than fail open to "no preference".
      await refresh(true);
      setLoading(false);
      router.push("/onboarding/payment");
      router.refresh();
      return;
    }

    // Sign-in (or no intent) — now check whether a language preference
    // already exists before deciding where to send the user next.
    // justAuthenticated=true for the same reason as the signup branch above.
    await refresh(true);
    setOtpVerified(true);
    setLoading(false);
  }

  async function pickLanguage(language: Language) {
    setSavingLanguage(true);
    await setLanguage(language);
    setSavingLanguage(false);
    router.push("/");
    router.refresh();
  }

  function continueHome() {
    router.push("/");
    router.refresh();
  }

  // Fallback screen state for the sign-in path only: OTP verified, but the
  // preference lookup hasn't resolved yet (hasPreference === null) or came
  // back empty (=== false) — e.g. an account created before this feature
  // existed. hasPreference === true means a returning user with a language
  // already set — skip straight home rather than rendering anything here.
  if (otpVerified && hasPreference === true) {
    continueHome();
    return null;
  }

  if (otpVerified && hasPreference !== true) {
    return (
      <main className="shell">
        <nav>
          <div className="brand">Vuryfy</div>
        </nav>
        <section className="hero">
          <p className="eyebrow">{t("language.eyebrow")}</p>
          <h1>{t("language.heading")}</h1>
          <p className="sub">{t("language.sub")}</p>
          <div className="panel">
            {/* Sept 20, 2026: aria-label added — a bare <select> with no
                label association can have an accessible name that doesn't
                reliably update with the selected option across browsers/AT
                (confirmed during a full feature test pass). */}
            <select
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value as Language)}
              disabled={savingLanguage || hasPreference === null}
              aria-label={t("settings.languageLabel")}
            >
              {SUPPORTED_LANGUAGES.map((lang) => (
                <option key={lang.code} value={lang.code}>
                  {lang.nativeLabel}
                </option>
              ))}
            </select>
            <button
              onClick={() => pickLanguage(selectedLanguage)}
              disabled={savingLanguage || hasPreference === null}
            >
              {savingLanguage ? t("language.saving") : t("language.continue")}
            </button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="shell">
      <nav>
        <div className="brand">Vuryfy</div>
      </nav>
      <section className="hero">
        <p className="eyebrow">{otpSent ? t("login.eyebrowCode") : eyebrowStart}</p>
        <h1>{otpSent ? t("login.headingCode") : headingStart}</h1>
        <p className="sub">{otpSent ? t("login.subCode") : subStart}</p>
        <div className="panel">
          {!otpSent ? (
            <>
              {isSignup && (
                <>
                  {/* Hardcoded English strings, not run through
                      lib/translations.ts — same "flagged, known i18n gap"
                      convention already used elsewhere (e.g. the WhatsApp UI
                      panels) for new pieces added outside the original
                      9-language rollout. */}
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
                  <select
                    value={selectedLanguage}
                    onChange={(e) => setSelectedLanguage(e.target.value as Language)}
                    aria-label={t("settings.languageLabel")}
                  >
                    {SUPPORTED_LANGUAGES.map((lang) => (
                      <option key={lang.code} value={lang.code}>
                        {lang.nativeLabel}
                      </option>
                    ))}
                  </select>
                </>
              )}
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder={t("login.phonePlaceholder")}
                inputMode="tel"
              />
              <button
                disabled={loading || phone.trim().length < 8 || (isSignup && name.trim().length === 0)}
                onClick={requestOtp}
              >
                {loading ? t("login.sending") : t("login.continue")}
              </button>
            </>
          ) : (
            <>
              <input
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                placeholder={t("login.otpPlaceholder")}
                inputMode="numeric"
                autoFocus
              />
              <button disabled={loading || otp.trim().length < 4} onClick={verify}>
                {loading ? t("login.verifying") : t("login.verify")}
              </button>
              <button
                className="back-action"
                onClick={() => {
                  setOtpSent(false);
                  setMessage("");
                }}
              >
                {t("login.useAnotherNumber")}
              </button>
            </>
          )}
          {message && <p className="message">{message}</p>}
        </div>
      </section>
    </main>
  );
}

export default function Login() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
