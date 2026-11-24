"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api-fetch";
import { useLanguage } from "@/app/providers/language-provider";

// Email/password breach check — Nov 24, 2026. See lib/breach-check.ts's
// header for the full rationale and data source (XposedOrNot).
//
// Same architectural shape as app/verify/sebi/page.tsx: NOT routed through
// /result like a credited verification type — this is a free, direct
// lookup (app/api/breach-check/route.ts), rendered inline rather than
// forced into the credited-verdict UI it doesn't belong to.
//
// Two independent sections on one page (email, password) rather than two
// separate pages — they're the same mental task ("is something I use
// compromised?"), and keeping them on one page means a user who came to
// check their email sees the password checker right there too, instead of
// needing to discover a second page exists.
interface EmailBreachDetail {
  name: string;
  domain: string | null;
  year: string | null;
  exposedData: string[];
  industry: string | null;
  passwordRisk: string | null;
}

export default function BreachCheckPage() {
  const router = useRouter();
  const supabase = createClient();
  const { t } = useLanguage();

  const [email, setEmail] = useState("");
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailError, setEmailError] = useState("");
  const [emailResult, setEmailResult] = useState<{ found: boolean; breaches: EmailBreachDetail[] } | null>(null);

  const [password, setPassword] = useState("");
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordResult, setPasswordResult] = useState<{ found: boolean; count: number | null } | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.replace("/login");
    });
  }, [router, supabase]);

  async function submitEmail() {
    const trimmed = email.trim();
    if (!trimmed || !trimmed.includes("@")) return;
    setEmailLoading(true);
    setEmailError("");
    setEmailResult(null);
    try {
      const r = await apiFetch("/api/breach-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "email", email: trimmed }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || t("breach.unavailable"));
      setEmailResult({ found: d.found, breaches: d.breaches });
    } catch (e: any) {
      setEmailError(e.message);
    } finally {
      setEmailLoading(false);
    }
  }

  async function submitPassword() {
    if (!password) return;
    setPasswordLoading(true);
    setPasswordError("");
    setPasswordResult(null);
    try {
      const r = await apiFetch("/api/breach-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "password", password }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || t("breach.unavailable"));
      setPasswordResult({ found: d.found, count: d.count });
    } catch (e: any) {
      setPasswordError(e.message);
    } finally {
      setPasswordLoading(false);
    }
  }

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push("/")}>
          {t("nav.back")}
        </button>
        <div className="credits">{t("nav.freeCredits")}</div>
      </nav>
      <section className="verify">
        <p className="eyebrow">{t("scam.eyebrow")}</p>
        <h1>{t("breach.heading")}</h1>
        <p className="sub" style={{ margin: "0 0 24px" }}>
          {t("breach.sub")}
        </p>

        {/* Email section */}
        <h2 style={{ fontSize: 16, margin: "0 0 10px" }}>{t("breach.emailHeading")}</h2>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t("breach.emailPlaceholder")}
          maxLength={320}
          onKeyDown={(e) => e.key === "Enter" && submitEmail()}
        />
        <div className="actions">
          <span />
          <button onClick={submitEmail} disabled={emailLoading || !email.trim().includes("@")}>
            {emailLoading ? t("claim.checking") : t("breach.emailCheckButton")}
          </button>
        </div>
        {emailError && <p className="error">{emailError}</p>}

        {emailResult && emailResult.found && (
          <>
            <div className="scam-warning">
              <span>{t("breach.emailFoundHeading")}</span>
              <p className="caution">
                {t("breach.emailFoundCount").replace("{count}", String(emailResult.breaches.length))}
              </p>
            </div>
            {emailResult.breaches.map((b, i) => (
              <div key={`${b.name}-${i}`} className="qr-payment">
                <span>{b.year || ""}</span>
                <h3>{b.name}</h3>
                {b.domain && <p className="payee-id">{b.domain}</p>}
                {b.exposedData.length > 0 && (
                  <p className="payee-id">
                    {t("breach.emailExposedLabel")} {b.exposedData.join(", ")}
                  </p>
                )}
                <p className="caution">{t("breach.emailRemediation")}</p>
              </div>
            ))}
          </>
        )}

        {emailResult && !emailResult.found && (
          <div className="qr-payment">
            <span>{t("breach.emailNotFoundHeading")}</span>
            <p className="caution">{t("breach.emailNotFoundBody")}</p>
          </div>
        )}

        {/* Password section */}
        <h2 style={{ fontSize: 16, margin: "36px 0 10px" }}>{t("breach.passwordHeading")}</h2>
        <p className="hint" style={{ marginTop: 0 }}>{t("breach.passwordSub")}</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t("breach.passwordPlaceholder")}
          maxLength={200}
          onKeyDown={(e) => e.key === "Enter" && submitPassword()}
        />
        <div className="actions">
          <span />
          <button onClick={submitPassword} disabled={passwordLoading || !password}>
            {passwordLoading ? t("claim.checking") : t("breach.passwordCheckButton")}
          </button>
        </div>
        {passwordError && <p className="error">{passwordError}</p>}

        {passwordResult && passwordResult.found && (
          <div className="scam-warning">
            <span>{t("breach.passwordFoundHeading")}</span>
            <p className="caution">{t("breach.passwordFoundBody")}</p>
          </div>
        )}

        {passwordResult && !passwordResult.found && (
          <div className="qr-payment">
            <span>{t("breach.passwordNotFoundHeading")}</span>
            <p className="caution">{t("breach.passwordNotFoundBody")}</p>
          </div>
        )}

        <p className="hint" style={{ marginTop: 32 }}>{t("breach.caution")}</p>
      </section>
    </main>
  );
}
