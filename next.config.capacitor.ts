import type { NextConfig } from "next";

// Separate Next.js config used ONLY for the Capacitor (native app) static
// export build — the live Vercel deployment keeps using next.config.ts,
// completely unchanged. Added Sept 29 2026; see claude/roadmap-notes.md,
// "Capacitor build — kickoff", for why this has to be a separate config
// rather than a flag on the existing one.
//
// output: 'export' produces a fully static app/ bundle in ./out that
// Capacitor packages inside the native app shell, per Apple's requirement
// that the UI ship locally rather than load live from the network on every
// launch.
//
// This only works because scripts/build-capacitor.js temporarily moves
// app/api out of the build tree before running this config — Next's static
// export cannot contain dynamic API route handlers (every route under
// app/api/* reads the request body / calls Supabase, Gemini, Tavily, none
// of which are exportable as static output).
//
// No images.unoptimized flag is needed here — the audit confirmed next/image
// is unused anywhere in this app.
const nextConfig: NextConfig = {
  output: "export",
};

export default nextConfig;
