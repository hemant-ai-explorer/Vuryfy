"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api-fetch";
import { useLanguage } from "@/app/providers/language-provider";

// SEBI registration check — Nov 20, 2026. See lib/sebi-check.ts's header
// for the full rationale (investment/trading scams are ~76-77% of all
// reported cyber-fraud losses in India; the primary trust hook is a fake
// "SEBI-registered" claim).
//
// Deliberately NOT routed through /result like every other verification
// type — this isn't a credited "verification" with a verdict/cache row in
// the `verifications` table, it's a free, direct lookup against Vuryfy's
// own cached SEBI registry (app/api/sebi-check/route.ts). Rendering
// inline here keeps that architectural distinction visible rather than
// forcing it into the credited-verdict UI it doesn't actually belong to.
//
// A single input auto-detects whether the user typed a name or a SEBI
// registration number rather than asking the user to pick a mode up
// front — one less decision before they can just check something.
// Two formats, confirmed against real SEBI data: Investment
// Adviser/Research Analyst/Stockbroker use two letters + 6-9 digits (e.g.
// INA000017523, INH300000211, INZ000031633); Depository Participants
// (added Nov 20, 2026) use a visibly different IN-DP-<digits>-<year>
// format (e.g. IN-DP-870-2026) — easy to miss since it doesn't fit the
// first pattern at all, confirmed live before this category was synced
// rather than assumed from the others' shape.
const REG_NO_PATTERN = /^(IN[A-Z]\d{6,9}|IN-DP-\d+-\d{4})$/i;

interface SebiMatch {
  regNo: string;
  name: string;
  category: string;
  validFrom: string | null;
  validTo: string | null;
  isActive: boolean;
  address: string | null;
  phone: string | null;
  email: string | null;
}

export default function SebiCheckPage() {
  const router = useRouter();
  const supabase = createClient();
  const { t } = useLanguage();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [matches, setMatches] = useState<SebiMatch[] | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.replace("/login");
    });
  }, [router, supabase]);

  async function submit() {
    const trimmed = query.trim();
    if (trimmed.length < 3) return;
    setLoading(true);
    setError("");
    setMatches(null);
    setSearched(false);
    try {
      const isRegNo = REG_NO_PATTERN.test(trimmed);
      const r = await apiFetch("/api/sebi-check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(isRegNo ? { reg_no: trimmed } : { name: trimmed }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Check failed");
      setMatches(d.matches);
      setSyncedAt(d.synced_at);
      setSearched(true);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const syncedLabel = syncedAt
    ? new Date(syncedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
    : null;

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
        {/* "Entity" not "adviser" — Nov 20, 2026, once the registry grew
            past Investment Adviser to also cover Research Analyst, 6
            stockbroker segments, and CDSL/NSDL depository participants.
            Some of those are individuals, most are firms, so "adviser"
            undersold what this now checks. */}
        <h1>{t("sebi.heading")}</h1>
        <p className="sub" style={{ margin: "0 0 24px" }}>
          {t("sebi.sub")}
        </p>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("sebi.placeholder")}
          maxLength={200}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <div className="actions">
          <span />
          <button onClick={submit} disabled={loading || query.trim().length < 3}>
            {loading ? t("claim.checking") : t("sebi.checkButton")}
          </button>
        </div>
        {error && <p className="error">{error}</p>}

        {searched && matches && matches.length === 0 && (
          <div className="qr-payment">
            <span>{t("sebi.notFound")}</span>
            <h3>{t("sebi.noMatchHeading")}</h3>
            <p className="caution">
              {t("sebi.noMatchBody").replace(
                "{syncedSuffix}",
                syncedLabel ? t("sebi.lastSyncedSuffix").replace("{date}", syncedLabel) : ""
              )}
            </p>
          </div>
        )}

        {searched && matches && matches.length === 0 && !syncedAt && (
          <p className="hint">{t("sebi.notSyncedHint")}</p>
        )}

        {matches &&
          matches.map((m) => (
            <div key={m.regNo} className="qr-payment" style={!m.isActive ? { opacity: 0.85 } : undefined}>
              <span>{m.isActive ? t("sebi.registered") : t("sebi.lapsed")}</span>
              <h3>{m.name}</h3>
              <p className="payee-id">
                {m.category} · {m.regNo}
              </p>
              <p className="payee-id">
                {m.isActive
                  ? t("sebi.activeSince").replace("{date}", m.validFrom || t("sebi.unspecifiedDate"))
                  : t("sebi.validFromUntil")
                      .replace("{from}", m.validFrom || t("sebi.unspecifiedDate"))
                      .replace("{to}", m.validTo || "")}
              </p>
              {(m.address || m.phone || m.email) && (
                <p className="payee-id">
                  {[m.address, m.phone, m.email].filter(Boolean).join(" · ")}
                </p>
              )}
              <p className="caution">{t("sebi.registeredCaution")}</p>
            </div>
          ))}

        {syncedLabel && (!matches || matches.length > 0) && (
          <p className="hint">{t("sebi.lastSyncedHint").replace("{date}", syncedLabel)}</p>
        )}
      </section>
    </main>
  );
}
