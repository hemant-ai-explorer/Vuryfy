// Email + password breach check — Nov 24, 2026. Added after the user asked
// whether Vuryfy could tell them if an app/account they use has been
// "hacked or leaked." The real mechanism: when a company's own user
// database gets breached, the leaked email+password lists eventually show
// up in public breach-tracking datasets, indexed by which email addresses
// and (separately, via password hash) which passwords appeared in them.
// This queries that public dataset — it does NOT mean Vuryfy itself was
// breached, and it can't see a breach that hasn't become public yet.
//
// Data source: XposedOrNot (https://xposedornot.com/api_doc) — chosen over
// Have I Been Pwned (no free tier, $4.39+/mo, email-only, requires a
// visible "identify Have I Been Pwned as the source" attribution) and
// LeakCheck (closer to a raw credential/OSINT lookup tool — even offers
// "reverse search by password" — than a consumer trust product; sits oddly
// next to Vuryfy's own positioning). XposedOrNot's free tier needs NO API
// key for either endpoint this file calls, so there's zero new secret to
// set up for this pass. Its free-tier limits are per-IP, shared across
// every Vuryfy user since all server-side calls leave from the same Vercel
// IP: 2 requests/sec, 25/hour, 100/day for the email-breach endpoint, no
// published limit for the password endpoint. If real traffic exhausts
// that, upgrade to their paid xonAPI+ tier (from $9/month — needs an API
// key passed via a new env var, not wired up here since the free tier is
// enough to ship with) rather than building a caching layer first.
//
// PRIVACY: neither function stores the submitted email or password
// anywhere — no DB write, no console.log of the raw value, consistent with
// this app's private-by-default principle (see
// marketing-site-2026-09-19.md). The password check never sends the actual
// password over the network — only the first 10 hex characters of its
// Keccak-512 hash (40 bits of a 512-bit digest), which is enough entropy
// that a match is a near-certain real match, without ever exposing the
// password itself to XposedOrNot or to anyone inspecting the request.

import { keccak512 } from "js-sha3";

const EMAIL_BREACH_URL = "https://api.xposedornot.com/v1/breach-analytics";
const PASSWORD_CHECK_URL = "https://passwords.xposedornot.com/api/v1/pass/anon";
const FETCH_TIMEOUT_MS = 8000;

export interface EmailBreachDetail {
  name: string;
  domain: string | null;
  year: string | null;
  exposedData: string[];
  industry: string | null;
  passwordRisk: string | null;
}

export interface EmailBreachResult {
  found: boolean;
  breaches: EmailBreachDetail[];
  // true when the lookup itself failed (rate-limited / network error /
  // unexpected response shape) — distinct from a clean "found: false", so
  // the caller can say "try again" instead of implying a real, completed
  // check came back clean.
  unavailable: boolean;
}

export async function checkEmailBreaches(email: string): Promise<EmailBreachResult> {
  try {
    const res = await fetch(`${EMAIL_BREACH_URL}?email=${encodeURIComponent(email)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    // Documented as the "no data found" case for XposedOrNot's email
    // endpoints — handled as a clean not-found, not a failure.
    if (res.status === 404) {
      return { found: false, breaches: [], unavailable: false };
    }
    if (res.status === 429) {
      console.error("[breach-check] XposedOrNot rate limit hit (email check)");
      return { found: false, breaches: [], unavailable: true };
    }
    if (!res.ok) {
      console.error("[breach-check] email breach lookup failed, status:", res.status);
      return { found: false, breaches: [], unavailable: true };
    }

    const data = await res.json().catch(() => null);
    const details = data?.ExposedBreaches?.breaches_details;
    if (!Array.isArray(details) || details.length === 0) {
      // breach-analytics returns HTTP 200 with empty/null sub-objects for
      // a genuine not-found, rather than a 404 — confirmed from the API
      // docs before shipping this.
      return { found: false, breaches: [], unavailable: false };
    }

    const breaches: EmailBreachDetail[] = details.map((b: Record<string, unknown>) => ({
      name: typeof b?.breach === "string" ? b.breach : "Unknown",
      domain: typeof b?.domain === "string" ? b.domain : null,
      year: typeof b?.xposed_date === "string" ? b.xposed_date : null,
      exposedData:
        typeof b?.xposed_data === "string"
          ? b.xposed_data
              .split(";")
              .map((s) => s.trim())
              .filter(Boolean)
          : [],
      industry: typeof b?.industry === "string" ? b.industry : null,
      passwordRisk: typeof b?.password_risk === "string" ? b.password_risk : null,
    }));

    return { found: true, breaches, unavailable: false };
  } catch (err) {
    console.error("[breach-check] email breach lookup threw:", err);
    return { found: false, breaches: [], unavailable: true };
  }
}

export interface PasswordBreachResult {
  found: boolean;
  count: number | null;
  unavailable: boolean;
}

export async function checkPasswordBreach(password: string): Promise<PasswordBreachResult> {
  try {
    // Keccak-512, NOT the NIST-standardized SHA3-512 that Node's own
    // "crypto" module exposes under the confusingly similar name
    // "sha3-512" — the two produce different digests for the same input.
    // Confirmed against the published test vector (Keccak-512("test")
    // begins "1e2e9fc200") before this shipped. js-sha3's own `sha3_512`
    // export is the NIST variant too; only its `keccak512` export is the
    // right one here.
    const hash = keccak512(password);
    const prefix = hash.slice(0, 10);

    const res = await fetch(`${PASSWORD_CHECK_URL}/${prefix}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (res.status === 404) {
      return { found: false, count: null, unavailable: false };
    }
    if (res.status === 429) {
      console.error("[breach-check] XposedOrNot rate limit hit (password check)");
      return { found: false, count: null, unavailable: true };
    }
    if (!res.ok) {
      console.error("[breach-check] password breach lookup failed, status:", res.status);
      return { found: false, count: null, unavailable: true };
    }

    const data = await res.json().catch(() => null);
    if (!data || data.Error || !data.SearchPassAnon) {
      return { found: false, count: null, unavailable: false };
    }

    const rawCount = data.SearchPassAnon.count;
    const count =
      typeof rawCount === "string" ? parseInt(rawCount, 10) : typeof rawCount === "number" ? rawCount : null;

    return { found: true, count: Number.isFinite(count as number) ? (count as number) : null, unavailable: false };
  } catch (err) {
    console.error("[breach-check] password breach lookup threw:", err);
    return { found: false, count: null, unavailable: true };
  }
}
