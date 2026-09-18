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
// Language-picker step added Sept 16, 2026 (Phase 1 of the multilingual
// rollout — see lib/translations.ts's header): sign-in and sign-up are the
// same OTP flow underneath (Supabase creates the account automatically on a
// brand new phone number's first verification) — there's no separate
// "signup form" moment to hang a language picker off of. Instead, right
// after OTP verification succeeds, this checks whether the user already has
// a stored language preference (via useLanguage()'s hasPreference flag,
// populated from /api/preferences). A MISSING preference — true for both a
// genuinely new sign-up and anyone who verified before this feature
// existed — shows the picker as a third screen state before continuing
// home. An EXISTING preference (any returning user who already chose one)
// skips straight to "/", so this step is only ever seen once per account.
// Changing it later happens from Settings (app/settings/page.tsx), not here.
//
// Separate Sign in / Sign up entry points added Sept 16, 2026, per the
// user's explicit request for two distinct buttons on the landing page
// (app/page.tsx) instead of one combined "Sign in or sign up" button. The
// underlying OTP flow is still exactly one form either way — Supabase has
// no separate signup step to route to — so `?intent=signin`/`?intent=signup`
// on the URL only changes this screen's copy (eyebrow/heading/sub) before
// an OTP has been requested; the phone input, OTP verification, and
// language-picker step behave identically regardless of which button was
// clicked. `useSearchParams()` requires a Suspense boundary at build time
// (same convention as app/verify/claim/page.tsx), so the component reading
// it is wrapped below rather than exported directly.
function LoginForm() {
  const router = useRouter();
  const supabase = createClient();
  const searchParams = useSearchParams();
  const { t, hasPreference, setLanguage, refresh } = useLanguage();
  const [phone, setPhone] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpVerified, setOtpVerified] = useState(false);
  const [otp, setOtp] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingLanguage, setSavingLanguage] = useState(false);
  // Sept 18, 2026 (later same day as the Marathi addition): the picker
  // switched from a grid of one button per SUPPORTED_LANGUAGES entry to a
  // dropdown, per the user's explicit request — with 9 languages now
  // supported, a button grid was getting unwieldy. Behavior is otherwise
  // identical: still shown at most once per account (see the hasPreference
  // logic below), still redirects home on confirm. Defaults to "en".
  const [selectedLanguage, setSelectedLanguage] = useState<Language>("en");

  const intentParam = searchParams.get("intent");
  const intent: "signin" | "signup" | null =
    intentParam === "signin" ? "signin" : intentParam === "signup" ? "signup" : null;
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
    // Signed in — now check whether a language preference already exists
    // before deciding where to send the user next.
    await refresh();
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

  // Third screen state: OTP verified, but the preference lookup hasn't
  // resolved yet (hasPreference === null) or came back empty (=== false).
  // hasPreference === true means a returning user with a language already
  // set — skip straight home rather than rendering anything here.
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
            <select
              value={selectedLanguage}
              onChange={(e) => setSelectedLanguage(e.target.value as Language)}
              disabled={savingLanguage || hasPreference === null}
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
              <input
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder={t("login.phonePlaceholder")}
                inputMode="tel"
              />
              <button disabled={loading || phone.trim().length < 8} onClick={requestOtp}>
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
