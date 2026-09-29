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

// apiFetch() is what every call site actually uses. Two things it adds
// beyond a plain fetch(apiUrl(path)):
//
// 1. credentials: "include" — on the web app this is a no-op (same-origin
//    requests send cookies by default regardless), but from inside the
//    Capacitor app the request is genuinely cross-origin, and a fetch()
//    only attaches cookies to a cross-origin request when explicitly told
//    to via `credentials: "include"`. Without this, the Supabase session
//    cookie would never be sent at all, even once CORS itself is fixed
//    (see middleware.ts's CORS block, added the same day for the matching
//    server-side half of this).
// 2. Still resolves through apiUrl() so the absolute-base-URL behavior
//    described in that function's own comment above is unchanged.
//
// Usage: apiFetch("/api/verify", { method: "POST", ... }) instead of
// fetch("/api/verify", { method: "POST", ... }). Works with a plain path or
// a template literal (e.g. apiFetch(`/api/verifications/${id}`)).
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(apiUrl(path), { credentials: "include", ...init });
}
