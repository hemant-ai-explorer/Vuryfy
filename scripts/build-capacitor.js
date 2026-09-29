#!/usr/bin/env node
// Builds the static export of the Next.js app for Capacitor packaging.
// Added Sept 29 2026 — see claude/roadmap-notes.md, "Capacitor build —
// kickoff", for the full plan this is part of.
//
// Three things make the live app's real next.config.ts / app tree
// incompatible with a static export in the same build:
//   1. `output: 'export'` can't coexist with app/api/* (dynamic route
//      handlers) in the same build tree — Next errors or silently drops
//      them.
//   2. `output: 'export'` also can't contain app/share/[id] — a dynamic
//      route with no generateStaticParams(). It doesn't need to: share
//      links are meant to be opened from outside the app (WhatsApp,
//      social), so it's excluded from the bundled native-app UI and stays
//      live on the website exactly as it works today. (Confirmed as the
//      real blocker by a first test build on Sept 29 2026 — Next's error
//      was: `Page "/share/[id]" is missing "generateStaticParams()" so it
//      cannot be used with "output: export" config.`)
//   3. Next has no built-in "--config <file>" flag, so using a different
//      config for just this one build means temporarily swapping
//      next.config.ts itself for next.config.capacitor.ts.
//
// This script does all three swaps, runs `next build`, and restores
// everything afterward — including when the build fails — so a crashed run
// never leaves the live dev/prod app missing routes or its real config.
//
// Also sets NEXT_PUBLIC_API_BASE_URL for this build only, so every
// fetch(apiUrl("/api/...")) call (see lib/api-fetch.ts) resolves to the real
// production API instead of a relative path — the exported UI runs from a
// different origin once it's bundled inside the native shell, so a relative
// "/api/..." would otherwise hit nothing. The ordinary `next build` used by
// Vercel never sets this, so the live web app is unaffected.
//
// Usage: npm run build:capacitor
// Output: ./out  (this is capacitor.config.ts's webDir)

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = process.cwd();

// app.vuryfy.com is the real production app domain (confirmed live since
// Sept 20 2026 — see claude/business-ops-2026-09-20.md), and is the default
// every normal `npm run build:capacitor` uses. Override it for a one-off
// build against the `test` branch's Vercel preview instead — e.g. to check
// a server-side change (an API route, middleware.ts) against staging
// before merging it to main and hitting real production — with:
//   $env:CAPACITOR_API_BASE_URL = "https://vuryfy-git-test-ai-explorers1.vercel.app"
//   npm run build:capacitor
// Added Sept 29 2026 after a CORS fix in middleware.ts (see
// claude/roadmap-notes.md, "Capacitor build — kickoff") had to actually be
// pushed and deployed before the native app could pick it up — a build
// only ever bundles the CLIENT code locally; server-side files like
// middleware.ts run wherever this URL points, not on the device at all.
const API_BASE_URL = process.env.CAPACITOR_API_BASE_URL || "https://app.vuryfy.com";

// Supabase project credentials for this build — added Sept 29 2026 after a
// mismatch bug: NEXT_PUBLIC_SUPABASE_URL/ANON_KEY are ordinarily supplied by
// .env.local (used for everyday local dev, which on this machine points at
// the `vuryfy-test` Supabase project), but that file has no idea whether
// *this* build is meant to talk to production or test — it just always
// contributes whatever it currently contains. A build that left it alone
// while pointing API_BASE_URL at production created a broken combination:
// sign-in went to the test Supabase project while /api/* calls (and their
// server-side token validation) went to the production project, so every
// login looked valid to the client but came back "Not signed in." from the
// server. Fixed the same way as API_BASE_URL above — default to the real
// production project, and require an explicit override (mirroring
// CAPACITOR_API_BASE_URL) to build against test instead:
//   $env:CAPACITOR_API_BASE_URL = "https://vuryfy-git-test-ai-explorers1.vercel.app"
//   $env:CAPACITOR_SUPABASE_URL = "https://tituotrsxpxkhdrsyvvd.supabase.co"
//   $env:CAPACITOR_SUPABASE_ANON_KEY = "sb_publishable_PMcRmH0ddlnWTBUV912YJw_XLTJD381"
//   npm run build:capacitor
const SUPABASE_URL =
  process.env.CAPACITOR_SUPABASE_URL || "https://bzzenbguxofeirknzxld.supabase.co";
const SUPABASE_ANON_KEY =
  process.env.CAPACITOR_SUPABASE_ANON_KEY || "sb_publishable_ZFgxN8LC44Xy6kg3s2AJ8Q_uU6KUIo6";

// Directories moved out of app/ for the duration of the export build, and
// restored afterward. Add to this list if another export-incompatible route
// shows up later (e.g. a future dynamic page with no generateStaticParams).
const EXCLUDED_DIRS = [
  {
    real: path.join(root, "app", "api"),
    backup: path.join(root, ".capacitor-build-tmp-api"),
  },
  {
    real: path.join(root, "app", "share"),
    backup: path.join(root, ".capacitor-build-tmp-share"),
  },
];

const configPath = path.join(root, "next.config.ts");
const configBackup = path.join(root, ".capacitor-build-tmp-next.config.ts");
const capacitorConfigPath = path.join(root, "next.config.capacitor.ts");

// Safety net: if a previous run crashed before restoring, refuse to run
// rather than silently building with routes missing or overwriting a real
// backup that still needs to be restored by hand.
const leftovers = [configBackup, ...EXCLUDED_DIRS.map((d) => d.backup)].filter(
  fs.existsSync
);
if (leftovers.length > 0) {
  console.error(
    "Found leftover .capacitor-build-tmp-* file(s)/dir(s) from a previous " +
      "run that didn't finish restoring:\n" +
      leftovers.map((p) => "  " + p).join("\n") +
      "\nCheck these against app/api, app/share and next.config.ts by hand " +
      "before re-running."
  );
  process.exit(1);
}

if (!fs.existsSync(capacitorConfigPath)) {
  console.error(`Missing ${capacitorConfigPath}.`);
  process.exit(1);
}

function swapOut() {
  for (const { real, backup } of EXCLUDED_DIRS) {
    if (fs.existsSync(real)) {
      fs.renameSync(real, backup);
    }
  }
  fs.renameSync(configPath, configBackup);
  fs.copyFileSync(capacitorConfigPath, configPath);
}

function swapBack() {
  if (fs.existsSync(configBackup)) {
    fs.rmSync(configPath, { force: true });
    fs.renameSync(configBackup, configPath);
  }
  for (const { real, backup } of EXCLUDED_DIRS) {
    if (fs.existsSync(backup)) {
      fs.renameSync(backup, real);
    }
  }
}

let exitCode = 0;
swapOut();
try {
  execSync("npx next build", {
    stdio: "inherit",
    cwd: root,
    env: {
      ...process.env,
      NEXT_PUBLIC_API_BASE_URL: API_BASE_URL,
      NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
    },
  });
} catch (err) {
  exitCode = 1;
} finally {
  swapBack();
}
process.exit(exitCode);
