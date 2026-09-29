"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { apiFetch } from "@/lib/api-fetch";

// Rewritten Sept 14, 2026 to replace the old pre-Supabase-rewrite version
// of this page. Deliberately mirrors app/verify/page.tsx's shape: Deep
// Investigation runs as a single synchronous request (see
// app/api/deep/route.ts and lib/deep-investigation.ts for why), so there's
// no job id to create, no status page to redirect to, and no polling loop
// — the old /deep/status page is retired along with that pattern. The
// only real differences from Quick Check are the copy, the endpoint, and
// a longer expected wait (Deep Investigation runs a heavier pipeline, so
// the button/placeholder text set that expectation rather than implying
// it's as fast as a Quick Check).
//
// QR hint added Sept 2026, mirroring app/verify/page.tsx: the QR scan
// screen (app/verify/qr/page.tsx) now offers both Quick Check and Deep
// Investigation from the same decoded-claim screen, so both text-entry
// pages surface it as an alternative entry point, not just Quick Check's.
export default function DeepPage() {
  const router = useRouter();
  const supabase = createClient();
  const [claim, setClaim] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) router.replace("/login");
    });
  }, [router, supabase]);

  async function submit() {
    if (claim.trim().length < 5) return;
    setLoading(true);
    setError("");
    try {
      const r = await apiFetch("/api/deep", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim: claim.trim(), input_type: "text" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Investigation failed");
      sessionStorage.setItem("vuryfy_result", JSON.stringify(d));
      router.push(`/result?id=${d.id}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push("/")}>
          ← Back
        </button>
        <div className="credits">Credits</div>
      </nav>
      <section className="verify">
        <p className="eyebrow">DEEP INVESTIGATION</p>
        <h1>Investigate thoroughly.</h1>
        <p className="sub">
          Vuryfy will break the claim into questions, research multiple sources, and weigh the
          evidence before reaching a verdict. This takes longer than a Quick Check.
        </p>
        <textarea
          value={claim}
          onChange={(e) => setClaim(e.target.value)}
          placeholder="Paste a claim, statement, or URL…"
          maxLength={10000}
        />
        <div className="actions">
          <span>{claim.length}/10,000</span>
          <button onClick={submit} disabled={loading || claim.trim().length < 5}>
            {loading ? "Investigating…" : "Start investigation"}
          </button>
        </div>
        {error && <p className="error">{error}</p>}
        <p className="hint">
          Have a QR code instead? <Link href="/verify/qr">Scan it</Link>
        </p>
        <p className="hint">
          Got a photo? <Link href="/verify/image">Check it</Link>
        </p>
        <p className="hint">
          Got audio? <Link href="/verify/audio">Check it</Link>
        </p>
      </section>
    </main>
  );
}
