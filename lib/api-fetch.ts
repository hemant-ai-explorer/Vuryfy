// Prefixes app/api/* calls with an absolute base URL when the frontend is
// running inside the Capacitor-wrapped native app, where the UI is bundled
// locally (a capacitor://localhost / https://localhost origin) and no
// longer shares an origin with the API routes the way it does on the
// ordinary web app. Added Sept 29 2026 — see claude/roadmap-notes.md,
// "Capacitor build — kickoff", for the full plan this is part of.
//
// On the live web app (app.vuryfy.com) NEXT_PUBLIC_API_BASE_URL is unset,
// so this resolves to "" and every call behaves exactly as it always has —
// a plain relative fetch("/api/...").  scripts/build-capacitor.js sets
// NEXT_PUBLIC_API_BASE_URL to the production API origin only for the
// Capacitor export build.
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "";

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

// apiFetch() is what every call site actually uses. Three things it adds
// beyond a plain fetch(apiUrl(path)):
//
// 1. credentials: "include" — on the web app this is a no-op (same-origin
//    requests send cookies by default regardless).
// 2. Still resolves through apiUrl() so the absolute-base-URL behavior
//    described in that function's own comment above is unchanged.
// 3. Authorization: Bearer <access_token> — added Sept 29 2026 after
//    credentials: "include" alone turned out not to be enough. The Supabase
//    browser client (@supabase/ssr's createBrowserClient, see
//    lib/supabase/client.ts) stores the session by setting a cookie via
//    document.cookie on whatever origin the page's JS is currently running
//    from. Inside the Capacitor app that's https://localhost or
//    capacitor://localhost — never app.vuryfy.com. A cookie set on one
//    origin simply doesn't exist on another; that's a browser-level
//    same-origin rule, not something CORS or SameSite settings can affect
//    either way. So even with the CORS fix in middleware.ts and
//    credentials: "include" here, there was never an app.vuryfy.com-scoped
//    session cookie for the request to send in the first place — confirmed
//    by the native app's API calls reaching the server fine (no more
//    "Failed to fetch") but coming back "Not signed in." (the middleware
//    CORS preflight fix worked; this is the separate, second issue it was
//    expected to surface next).
//
//    The fix is to stop relying on cookies for the native app and instead
//    send the session's access token explicitly as a standard
//    Authorization header — a mechanism that works identically regardless
//    of origin, with no cookie/CORS complications at all.
//    lib/supabase/server.ts's createClient() reads this header when
//    present and validates that token directly instead of looking for a
//    session cookie. The web app never sends this header (API_BASE is ""
//    there, see below), so its existing cookie-based auth is completely
//    unchanged.
//
//    Only fetched when API_BASE is set (i.e. the Capacitor build) so the
//    web app never pays for the extra supabase.auth.getSession() call.
//
// Usage: apiFetch("/api/verify", { method: "POST", ... }) instead of
// fetch("/api/verify", { method: "POST", ... }). Works with a plain path or
// a template literal (e.g. apiFetch(`/api/verifications/${id}`)).
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);

  if (API_BASE) {
    // Client-only import path — apiFetch is only ever called from client
    // components, and this branch only runs in the Capacitor build.
    const { createClient } = await import("@/lib/supabase/client");
    const supabase = createClient();
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (session?.access_token) {
      headers.set("Authorization", `Bearer ${session.access_token}`);
    }
  }

  return fetch(apiUrl(path), { credentials: "include", ...init, headers });
}
