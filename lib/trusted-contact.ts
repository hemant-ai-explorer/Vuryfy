// Trusted-contact phone helpers — Nov 20, 2026, built for the
// digital-arrest Scam SOS feature (app/verify/digital-arrest/page.tsx and
// the trusted-contact panel in app/settings/page.tsx). Shared between
// client and server code (no secrets, no "use server"/"use client"
// directive needed), so both the save-time validation in
// app/api/preferences/route.ts and the link-building in the digital-arrest
// page import the same normalizer rather than drifting apart.

// Turns a user-entered phone number into the digits-only,
// country-code-prefixed form wa.me/<number> and sms:<number> links need
// (no "+", no spaces, no dashes). Assumes a bare 10-digit number is Indian
// — this app's whole user base — and prefixes 91 rather than asking the
// user to type a country code themselves; a number that already looks
// like it includes one (11-15 digits after stripping punctuation) is left
// as-is rather than guessed at further. Returns null for anything that
// doesn't look like a plausible phone number at all, so callers can
// reject obviously bad input instead of silently saving garbage that
// would produce a dead SOS button later, mid-scam-call, when it matters
// most.
export function normalizeTrustedContactPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `91${digits}`;
  if (digits.length >= 11 && digits.length <= 15) return digits;
  return null;
}

// Renders a normalized phone number back to a human-readable form for
// display in Settings (e.g. "91 98XXXXXXXX") — intentionally not a full
// international-formatting library (libphonenumber etc.) for one display
// line; good enough to show the user what's saved, not meant to validate
// correctness.
export function formatTrustedContactPhone(normalized: string): string {
  if (normalized.length === 12 && normalized.startsWith("91")) {
    return `+91 ${normalized.slice(2)}`;
  }
  return `+${normalized}`;
}
