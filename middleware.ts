import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// The Capacitor native app's WebView runs on its own origin — Android
// defaults to https://localhost, iOS to capacitor://localhost — completely
// separate from app.vuryfy.com. Every API call the native app makes is
// therefore cross-origin, unlike the web app (same-origin, so none of this
// CORS handling applies to it or changes its behavior at all). Added
// Sept 29 2026 while getting the first real device build working — see
// claude/roadmap-notes.md, "Capacitor build — kickoff". Fixes the "Failed
// to fetch" the native app hit on every API call: the browser blocks a
// cross-origin request outright unless the server explicitly allows it,
// and for a POST/JSON request it sends an OPTIONS preflight first, which
// Next's API route handlers don't define and would otherwise 405.
const ALLOWED_APP_ORIGINS = new Set<string>([
  "https://localhost", // Capacitor Android default origin
  "capacitor://localhost", // Capacitor iOS default origin
]);

// Refreshes the Supabase auth session cookie on every request. Without
// this, sessions can silently go stale in Server Components / API routes
// even though the browser still thinks it's logged in. Standard
// @supabase/ssr pattern — not specific to Vuryfy's business logic.
export async function middleware(request: NextRequest) {
  const origin = request.headers.get("origin");
  const isApiRoute = request.nextUrl.pathname.startsWith("/api/");
  const isAllowedAppOrigin = origin !== null && ALLOWED_APP_ORIGINS.has(origin);

  // CORS preflight from the native app. Real (non-preflight) requests still
  // flow through the normal Supabase-refresh path below so cookies stay
  // correct; a preflight carries no cookies/auth to refresh, so it's safe
  // to answer immediately without hitting Supabase at all.
  if (isApiRoute && request.method === "OPTIONS" && isAllowedAppOrigin) {
    return new NextResponse(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": origin!,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  await supabase.auth.getUser();

  if (isApiRoute && isAllowedAppOrigin) {
    response.headers.set("Access-Control-Allow-Origin", origin!);
    response.headers.set("Access-Control-Allow-Credentials", "true");
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
