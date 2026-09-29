// Prefixes app/api/* calls with an absolute base URL when the frontend is
// running inside the Capacitor-wrapped native app, where the UI is bundled
// locally (a capacitor://localhost / file-based origin) and no longer
// shares an origin with the API routes the way it does on the ordinary web
// app. Added Sept 29 2026 — see claude/roadmap-notes.md, "Capacitor build —
// kickoff", for the full plan this is part of.
//
// On the live web app (app.vuryfy.com) NEXT_PUBLIC_API_BASE_URL is unset,
// so this resolves to "" and every call behaves exactly as it always has —
// a plain relative fetch("/api/..."). scripts/build-capacitor.js sets
// NEXT_PUBLIC_API_BASE_URL to the production API origin only for the
// Capacitor export build.
//
// Usage: fetch(apiUrl("/api/verify"), { ... }) instead of
// fetch("/api/verify", { ... }). Works with a plain path or a template
// literal (e.g. apiUrl(`/api/verifications/${id}`)).
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL || "";

export function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}
