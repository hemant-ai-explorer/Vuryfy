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
// Usage: npm run build:capacitor
// Output: ./out  (this is capacitor.config.ts's webDir)

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = process.cwd();

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
  execSync("npx next build", { stdio: "inherit", cwd: root });
} catch (err) {
  exitCode = 1;
} finally {
  swapBack();
}
process.exit(exitCode);
