import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies, headers } from "next/headers";

// Server-side Supabase client bound to the incoming request's cookies.
// Use this in API routes / Server Components to find out WHO is logged
// in (via supabase.auth.getUser()) — it respects the real user session,
// not an admin/service-role override. It does NOT bypass Row Level
// Security, which is intentional: it should only ever be used to read
// the current user's identity, never to read/write business tables
// directly (use lib/supabase/admin.ts for that, after you've confirmed
// the user's identity with this client).
//
// Bearer-token support — added Sept 29 2026 (see claude/roadmap-notes.md,
// "Capacitor build — kickoff"): the Capacitor native app can't use
// cookie-based auth at all, because its WebView runs on its own origin
// (https://localhost / capacitor://localhost) and the Supabase browser
// client sets the session cookie on whatever origin the page's JS is
// running from — never on app.vuryfy.com. So lib/api-fetch.ts sends the
// native app's session as a standard `Authorization: Bearer <access_token>`
// header instead. When that header is present, forward it to every request
// this client makes via the `global.headers` option — including the
// internal call supabase.auth.getUser() makes to Supabase's own
// /auth/v1/user endpoint — so it validates that token directly instead of
// looking for a session cookie. Every one of the ~30 API routes that call
// `createServerSupabase()` then `supabase.auth.getUser()` picks this up
// automatically with no per-route changes.
//
// The ordinary web app never sends this header (lib/api-fetch.ts only
// attaches it when NEXT_PUBLIC_API_BASE_URL is set, i.e. the Capacitor
// build), so cookie-based auth for the web app is completely unchanged.
export async function createClient() {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const authHeader = headerStore.get("authorization");

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // setAll called from a Server Component — safe to ignore
            // as long as middleware.ts is also refreshing the session.
          }
        },
      },
      ...(authHeader
        ? { global: { headers: { Authorization: authHeader } } }
        : {}),
    }
  );
}
