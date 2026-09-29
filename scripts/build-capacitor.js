#!/usr/bin/env node
// Builds the static export of the Next.js app for Capacitor packaging.
// Added Sept 29 2026 — see claude/roadmap-notes.md, "Capacitor build —
// kickoff", for the full plan this is part of.
//
// Two things make the live app's real next.config.ts / app/api
// incompatible with a static export in the same build:
//   1. `output: 'export'` can't coexist with app/api/* (dynamic route
//      handlers) in the same build tree — Next errors or silently drops
//      them.
//   2. Next has no built-in "--config <file>" flag, so using a different
//      config for just this one build means temporarily swapping
//      next.config.ts itself for next.config.capacitor.ts.
//
// This script does both swaps, runs `next build`, and restores everything
// afterward — including when the build fails — so a crashed run never
// leaves the live dev/prod app missing its API routes or its real config.
//
// Usage: npm run build:capacitor
// Output: ./out  (this is capacitor.config.ts's webDir)

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = process.cwd();

const apiDir = path.join(root, "app", "api");
const apiBackup = path.join(root, ".capacitor-build-tmp-api");

const configPath = path.join(root, "next.config.ts");
const configBackup = path.join(root, ".capacitor-build-tmp-next.config.ts");
const capacitorConfigPath = path.join(root, "next.config.capacitor.ts");

// Safety net: if a previous run crashed before restoring, refuse to run
// rather than silently building with app/api missing or overwriting a real
// backup that still needs to be restored by hand.
if (fs.existsSync(apiBackup) || fs.existsSync(configBackup)) {
  console.error(
    "Found leftover .capacitor-build-tmp-* file(s) from a previous run " +
      "that didn't finish restoring.\n" +
      "Check app/api, next.config.ts, .capacitor-build-tmp-api and " +
      ".capacitor-build-tmp-next.config.ts by hand before re-running."
  );
  process.exit(1);
}

if (!fs.existsSync(apiDir)) {
  console.error(`Expected ${apiDir} to exist — nothing to build from.`);
  process.exit(1);
}
if (!fs.existsSync(capacitorConfigPath)) {
  console.error(`Missing ${capacitorConfigPath}.`);
  process.exit(1);
}

function swapOut() {
  fs.renameSync(apiDir, apiBackup);
  fs.renameSync(configPath, configBackup);
  fs.copyFileSync(capacitorConfigPath, configPath);
}

function swapBack() {
  if (fs.existsSync(configBackup)) {
    fs.rmSync(configPath, { force: true });
    fs.renameSync(configBackup, configPath);
  }
  if (fs.existsSync(apiBackup)) {
    fs.renameSync(apiBackup, apiDir);
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
