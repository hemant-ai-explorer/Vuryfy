import type { CapacitorConfig } from "@capacitor/cli";

// Capacitor wrapper config for the native Android/iOS build — added Sept 29
// 2026, kickoff of the native-app phase (see claude/roadmap-notes.md,
// "Capacitor build — kickoff", for the full plan and reasoning).
//
// appId follows reverse-DNS convention matching the vuryfy.com domain —
// this becomes the app's permanent package name / bundle identifier on both
// stores and can't be changed after first publish, so it's set deliberately
// now rather than left as a Capacitor default.
//
// webDir points at the static export produced by `npm run build:capacitor`
// (see scripts/build-capacitor.js) — NOT the live app.vuryfy.com site. The
// bundled UI ships inside the app package; only API calls go over the
// network at runtime. This is what keeps the app from being an Apple
// "web clip" rejection (App Store Review Guideline 4.2) — see the roadmap
// doc for the full explanation.
const config: CapacitorConfig = {
  appId: "com.vuryfy.app",
  appName: "Vuryfy",
  webDir: "out",
};

export default config;
