"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { apiUrl } from "@/lib/api-fetch";

export default function VerifyPage() {
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
      const r = await fetch(apiUrl("/api/verify"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claim: claim.trim(), input_type: "text" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Verification failed");
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
        <p className="eyebrow">QUICK CHECK</p>
        <h1>What should we verify?</h1>
        <textarea
          value={claim}
          onChange={(e) => setClaim(e.target.value)}
          placeholder="Paste a claim, statement, or URL…"
          maxLength={10000}
        />
        <div className="actions">
          <span>{claim.length}/10,000</span>
          <button onClick={submit} disabled={loading || claim.trim().length < 5}>
            {loading ? "Checking…" : "Verify"}
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
        <p className="hint">
          Got a video? <Link href="/verify/video">Check it</Link>
        </p>
      </section>
    </main>
  );
}
