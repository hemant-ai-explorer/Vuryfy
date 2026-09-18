"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Item = {
  id: string;
  mode: string;
  input_type: string;
  claim: string;
  verdict: string | null;
  confidence: number | null;
  created_at: string;
};

// Real history list — Sept 18, 2026. Replaces the previous app/saved/
// page.tsx, which was dead code left over from the pre-Supabase FastAPI
// backend (it called localStorage.getItem("vuryfy_token") and fetched
// from http://localhost:8000/api/v1/saved, a server that hasn't existed
// since the app moved to Supabase). Rebuilt now because the WhatsApp
// submission MVP needs somewhere for an asynchronously-processed result
// to land — there's no browser tab to redirect to the way there is for
// an interactive in-app check — but this list is useful for every
// verification regardless of how it was submitted, not just WhatsApp
// ones.
//
// Not yet localized (still English-only) — same known, explicitly-
// flagged gap as the result page's static chrome and the QR/image/audio/
// video confirm screens (see claude/multilingual-phase2-2026-09-18.md's
// "Not yet done" section); this page joins that same list rather than
// being a new, separate omission.
export default function Saved() {
  const router = useRouter();
  const supabase = createClient();
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        router.replace("/login");
        return;
      }
      fetch("/api/verifications")
        .then((r) => (r.ok ? r.json() : { items: [] }))
        .then((d) => setItems(d.items || []))
        .finally(() => setLoading(false));
    });
  }, [router, supabase]);

  return (
    <main className="shell narrow">
      <nav>
        <button className="back" onClick={() => router.push("/")}>
          ← Vuryfy
        </button>
        <div className="brand">History</div>
      </nav>
      <section className="hero">
        <p className="eyebrow">YOUR LIBRARY</p>
        <h1>Past verifications.</h1>
        <p className="sub">
          Every check you&apos;ve run, most recent first — including anything submitted over WhatsApp.
        </p>
      </section>
      <section>
        {loading ? (
          <p>Loading…</p>
        ) : items.length === 0 ? (
          <div className="empty">
            <h2>Nothing here yet.</h2>
            <p>Run a Quick Check or Deep Investigation to see it show up here.</p>
          </div>
        ) : (
          items.map((i) => (
            <article className="saved-item" key={i.id}>
              <div className="verdict">{i.verdict || "—"}</div>
              <p>{i.claim}</p>
              <small>
                {i.mode === "deep" ? "Deep Investigation" : "Quick Check"}
                {i.confidence !== null ? ` · ${i.confidence}% confidence` : ""} ·{" "}
                {new Date(i.created_at).toLocaleString()}
              </small>
              <div className="row-actions">
                <button className="secondary" onClick={() => router.push(`/result?id=${i.id}`)}>
                  Open
                </button>
              </div>
            </article>
          ))
        )}
      </section>
    </main>
  );
}
