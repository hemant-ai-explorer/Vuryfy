"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
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
// same OTP flow (Supabase creates the account automatically on a brand
// new phone number's first verification, per the "Sign in or sign up"
// copy on the landing page), so there's no separate "signup form" moment
// to hang a language picker off of. Instead, right after OTP verification
// succeeds, this checks whether the user already has a stored language
// preference (via useLanguage()'s hasPreference flag, populated from
// /api/preferences). A MISSING preference — true for both a genuinely new
// sign-up and anyone who verified before this feature existed — shows the
// picker as a third screen state before continuing home. An EXISTING
// preference (any returning user who already chose one) skips straight to
// "/", so this step is only ever seen once per account. Changing it later
// happens from Settings (app/settings/page.tsx), not here.
export default function Login() {
  const router = useRouter();
  const supabase = createClient();
  const { t, hasPreference, setLanguage, refresh } = useLanguage();
  const [phone, setPhone] = useState("");
  const [otpSent, setOtpSent] = useState(false);
  const [otpVerified, setOtpVerified] = useState(false);
  const [otp, setOtp] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingLanguage, setSavingLanguage] = useState(false);

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
          <div className="home-actions">
            {SUPPORTED_LANGUAGES.map((lang) => (
              <button
                key={lang.code}
                className="secondary-link"
                style={{ width: "auto", border: 0, cursor: "pointer" }}
                onClick={() => pickLanguage(lang.code)}
                disabled={savingLanguage || hasPreference === null}
              >
                {savingLanguage ? t("language.saving") : lang.nativeLabel}
              </button>
            ))}
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
        <p className="eyebrow">{otpSent ? t("login.eyebrowCode") : t("login.eyebrowStart")}</p>
        <h1>{otpSent ? t("login.headingCode") : t("login.headingStart")}</h1>
        <p className="sub">{otpSent ? t("login.subCode") : t("login.subStart")}</p>
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
