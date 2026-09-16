"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Credits = { quick_checks: number; deep_investigations: number; total: number };
type Subscription = {
  plan: string;
  status: string;
  cancel_at_period_end: boolean;
  current_period_end: string;
} | null;

export default function Home() {
  const router = useRouter();
  const supabase = createClient();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [credits, setCredits] = useState<Credits | null>(null);
  const [subscription, setSubscription] = useState<Subscription>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setSignedIn(!!data.user));
  }, [supabase]);

  useEffect(() => {
    if (!signedIn) return;
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setCredits(d.credits);
        setSubscription(d.subscription);
      })
      .catch(() => {});
  }, [signedIn]);

  async function logout() {
    await supabase.auth.signOut();
    setSignedIn(false);
    router.refresh();
  }

  if (signedIn === null) return null;

  if (!signedIn)
    return (
      <main className="shell">
        <nav>
          <div className="brand">Vuryfy</div>
          <div className="credits">Credits · —</div>
        </nav>
        <section className="hero">
          <p className="eyebrow">VERIFY WHAT MATTERS</p>
          <h1>Know what to trust.</h1>
          <p className="sub">
            Investigate claims and information with explainable AI-powered verification.
          </p>
          <Link className="primary-link" href="/login">
            Sign in to start
          </Link>
        </section>
      </main>
    );

  return (
    <main className="shell">
      <nav>
        <div className="brand">Vuryfy</div>
        <div className="credits">Credits · {credits?.total ?? "…"}</div>
      </nav>
      <section className="hero">
        <p className="eyebrow">VURYFY</p>
        <h1>What do you want to verify?</h1>
        <p className="sub">
          Choose what you want to verify, then pick Quick Check for a fast answer or Deep
          Investigation when you need a more thorough examination.
        </p>
        <div className="home-actions">
          <Link className="primary-link" href="/verify/claim?type=text">
            Verify Text
          </Link>
          <Link className="secondary-link" href="/verify/claim?type=url">
            Verify URL/Claims
          </Link>
          <Link className="secondary-link" href="/verify/qr">
            Scan a QR Code
          </Link>
          <Link className="secondary-link" href="/verify/image">
            Check a Photo
          </Link>
          <Link className="secondary-link" href="/verify/audio">
            Check Audio
          </Link>
          <Link className="secondary-link" href="/verify/video">
            Check a Video
          </Link>
        </div>
        <div className="balance-card">
          <div>
            <span>Quick</span>
            <strong>{credits?.quick_checks ?? "—"}</strong>
          </div>
          <div>
            <span>Deep</span>
            <strong>{credits?.deep_investigations ?? "—"}</strong>
          </div>
        </div>
        <div className="home-links">
          <Link href="/saved">Saved</Link>
          <Link href="/billing">Credits & Subscription</Link>
          <button className="text-button" onClick={logout}>
            Sign out
          </button>
        </div>
        {subscription?.cancel_at_period_end && (
          <p className="hint">
            Your subscription is scheduled to end at the end of the current paid period.
          </p>
        )}
        {!subscription && (
          <p className="hint">
            You don&apos;t have an active plan yet — choose one from Credits &amp; Subscription to
            get Quick Check and Deep Investigation credits.
          </p>
        )}
      </section>
    </main>
  );
}
