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
//    credentials: "include" alone turned out not to be enough (the
//    Supabase session cookie only ever exists on the Capacitor app's own
//    origin, never on app.vuryfy.com — see lib/supabase/server.ts's
//    matching comment for the full explanation). lib/supabase/server.ts
//    reads this header when present and validates the token directly
//    instead of looking for a session cookie.
//
//    TEMPORARY DEBUG LOGGING (Sept 29 2026): a first attempt at this
//    (same shape, no console calls) reached the server correctly but the
//    Authorization header was verifiably absent on the actual request
//    (confirmed via chrome://inspect Network tab), even though the
//    session cookie was confirmed present and valid via `document.cookie`
//    in the same live page at the same time. The logging below is there
//    to pin down why getSession() isn't finding it — DO NOT REVERT OR
//    "CLEAN UP" THIS FILE, this is intentional and actively being tested
//    on-device. Safe to remove once the real cause is found and fixed —
//    ask Claude before removing it if unsure.
//
//    Only attempted when API_BASE is set (i.e. the Capacitor build) so
//    the web app never pays for the extra getSession() call.
//
// Usage: apiFetch("/api/verify", { method: "POST", ... }) instead of
// fetch("/api/verify", { method: "POST", ... }). Works with a plain path or
// a template literal (e.g. apiFetch(`/api/verifications/${id}`)).
export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);

  if (API_BASE) {
    try {
      const { createClient } = await import("@/lib/supabase/client");
      const supabase = createClient();
      const { data, error } = await supabase.auth.getSession();
      if (error) {
        console.error("[apiFetch] getSession() returned an error:", error);
      }
      console.log(
        "[apiFetch] getSession() result — has session:",
        !!data.session,
        "has access_token:",
        !!data.session?.access_token,
        "expires_at:",
        data.session?.expires_at
      );
      if (data.session?.access_token) {
        headers.set("Authorization", `Bearer ${data.session.access_token}`);
        console.log("[apiFetch] Authorization header attached for", path);
      } else {
        console.warn("[apiFetch] no access_token available — request to", path, "will go out with no Authorization header");
      }
    } catch (err) {
      console.error("[apiFetch] threw while attaching auth token:", err);
    }
  }

  return fetch(apiUrl(path), { credentials: "include", ...init, headers });
}
