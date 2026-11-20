"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api-fetch";

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
// registration number (format: two letters + 'N' + 6-9 digits, e.g.
// INA000017523, INH300000211) rather than asking the user to pick a mode
// up front — one less decision before they can just check something.
const REG_NO_PATTERN = /^IN[A-Z]\d{6,9}$/i;

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
          ← Back
        </button>
        <div className="credits">Free — no credit used</div>
      </nav>
      <section className="verify">
        <p className="eyebrow">SCAM PREVENTION</p>
        <h1>Is this adviser SEBI-registered?</h1>
        <p className="sub" style={{ margin: "0 0 24px" }}>
          Before trusting a stock tip, trading group, or investment adviser, check whether their
          name or registration number actually appears in SEBI&apos;s own public records.
        </p>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Adviser/firm name, or registration number (e.g. INA000017523)…"
          maxLength={200}
          onKeyDown={(e) => e.key === "Enter" && submit()}
        />
        <div className="actions">
          <span />
          <button onClick={submit} disabled={loading || query.trim().length < 3}>
            {loading ? "Checking…" : "Check"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}

        {searched && matches && matches.length === 0 && (
          <div className="qr-payment">
            <span>NOT FOUND</span>
            <h3>No match in SEBI&apos;s records</h3>
            <p className="caution">
              This name or registration number doesn&apos;t appear in our copy of SEBI&apos;s
              registry{syncedLabel ? ` (last synced ${syncedLabel})` : ""}. This does NOT by
              itself confirm a scam — our data could be out of date, or the name could be spelled
              differently from what you entered — but a genuinely SEBI-registered adviser should
              appear here. If you&apos;re unsure, verify directly on SEBI&apos;s own site before
              trusting anyone claiming this credential.
            </p>
          </div>
        )}

        {searched && matches && matches.length === 0 && !syncedAt && (
          <p className="hint">
            Our SEBI registry hasn&apos;t finished its first sync yet — results may be incomplete
            right now.
          </p>
        )}

        {matches &&
          matches.map((m) => (
            <div key={m.regNo} className="qr-payment" style={!m.isActive ? { opacity: 0.85 } : undefined}>
              <span>{m.isActive ? "REGISTERED WITH SEBI" : "REGISTRATION LAPSED/CANCELLED"}</span>
              <h3>{m.name}</h3>
              <p className="payee-id">
                {m.category} · {m.regNo}
              </p>
              <p className="payee-id">
                {m.isActive
                  ? `Active since ${m.validFrom || "an unspecified date"}`
                  : `Was valid from ${m.validFrom || "an unspecified date"} until ${m.validTo}`}
              </p>
              {(m.address || m.phone || m.email) && (
                <p className="payee-id">
                  {[m.address, m.phone, m.email].filter(Boolean).join(" · ")}
                </p>
              )}
              <p className="caution">
                This confirms the registration itself is genuine. It does NOT confirm that the
                specific person or channel who contacted you is actually authorized to represent
                this registered entity — fraudsters sometimes cite a real adviser&apos;s name or
                number while impersonating them. If anything about the contact feels off, verify
                directly with the firm through a channel you trust.
              </p>
            </div>
          ))}

        {syncedLabel && (!matches || matches.length > 0) && (
          <p className="hint">SEBI registry last synced {syncedLabel}.</p>
        )}
      </section>
    </main>
  );
}
