"use client";
import { Suspense, useEffect } from "react";
import posthog from "posthog-js";
import { usePathname, useSearchParams } from "next/navigation";

// Client-side PostHog init (Part 23, LOCKED spec) — Sept 21, 2026. See
// lib/analytics.ts for the server-side half and the full taxonomy/privacy
// rationale (identical rules apply here: pseudonymous IDs only, no claim
// text or media in event properties).
//
// Pageviews only — autocapture and session recording are both explicitly
// OFF (a deliberate decision, not a default left unconfigured): this app's
// screens carry claim text, image/audio/video previews, and OTP/payment
// fields that must never be captured, even accidentally, by a generic
// click/DOM recorder or a session replay. A $pageview on /result also
// stands in for Part 23's "result viewed" funnel step, and one on
// /verify/claim etc. for "evidence viewed" isn't tracked separately in V1
// — see lib/analytics.ts's header for the full V1-scope reasoning.
//
// Manual pageview capture (rather than PostHog's own autocapture pageview
// listener) because the Next.js App Router doesn't fire the traditional
// full-page-load event that listener expects on client-side navigation —
// this effect re-fires on every pathname/search-param change instead, the
// documented pattern for App Router + posthog-js. useSearchParams()
// requires a Suspense boundary at build time (same reason app/login/
// page.tsx wraps its own searchParams-consuming component), so only the
// small tracker component below is wrapped, not the whole provider.
//
// identify()/reset() are NOT called from here — they're called from the
// actual sign-in/sign-up moment (app/login/page.tsx) and sign-out moment
// (app/settings/page.tsx's logout()/deleteAccount()), since this provider
// has no visibility into auth state changes itself.
let initialized = false;

function initPostHog() {
  if (initialized) return;
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) {
    console.warn("[posthog] NEXT_PUBLIC_POSTHOG_KEY not set — client-side analytics disabled.");
    return;
  }
  posthog.init(key, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://us.i.posthog.com",
    person_profiles: "identified_only", // pseudonymous-by-default, per the lock
    capture_pageview: false, // manual capture below — see file header
    autocapture: false, // explicit decision — see file header
    disable_session_recording: true, // explicit decision — see file header
  });
  initialized = true;
}

function PageviewTracker() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!initialized) return;
    const query = searchParams?.toString();
    const url = query ? `${pathname}?${query}` : pathname;
    posthog.capture("$pageview", { $current_url: url });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, searchParams?.toString()]);

  return null;
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    initPostHog();
  }, []);

  return (
    <>
      <Suspense fallback={null}>
        <PageviewTracker />
      </Suspense>
      {children}
    </>
  );
}

export { posthog };
