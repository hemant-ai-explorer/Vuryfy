-- 0024_sebi_intermediaries.sql
-- Nov 20, 2026 — local cache of SEBI's public intermediary registry
-- (Investment Advisers and Research Analysts to start; more categories
-- possible later), synced periodically from SEBI's own site. See
-- claude/scam-feature-sebi-check-2026-11-20.md (Vuryfy project notes) for
-- the full rationale: investment/trading scams are ~76-77% of all
-- reported cyber-fraud financial losses in India (I4C/NCRP data), and the
-- primary trust hook these scams use is a fake "SEBI-registered" claim.
-- This table lets a user check a name or registration number against
-- SEBI's real public data, with zero vendor dependency — unlike the
-- UPI-payee-name saga (Decentro/Signzy/Cashfree), this needs no
-- RBI/SEBI/IRDAI license for Vuryfy itself, since it's just reading
-- SEBI's own published registry, not acting as a regulated intermediary.
--
-- Synced via lib/sebi-check.ts's syncSebiCategory(), which calls an
-- undocumented AJAX endpoint SEBI's own search page uses internally
-- (sebiweb/ajax/department/getsearchintminfo.jsp) — reverse-engineered
-- Nov 20, 2026, no official API contract, so the sync is expected to need
-- maintenance if SEBI changes that page's markup or parameters.
--
-- Deliberately NOT a live per-request lookup: user-facing checks
-- (app/api/sebi-check/route.ts) query this cached table directly, which
-- is fast and doesn't depend on SEBI's site being reachable/fast during a
-- user's request. `synced_at` lets the UI show data freshness honestly
-- rather than implying a live check.
--
-- Date fields are stored as the raw display strings SEBI returns (e.g.
-- "13 Apr, 2026"), not parsed into typed dates — SEBI's format isn't
-- guaranteed stable enough to risk a parse failure silently dropping
-- records during sync. `is_active` is the one thing actually computed
-- during sync (true when SEBI shows "NA" as the validity end, false when
-- an actual end date is shown, i.e. the registration lapsed/was
-- cancelled) since that's the one fact the lookup UI actually needs to
-- branch on.

create table if not exists sebi_intermediaries (
  reg_no text primary key,
  name text not null,
  category text not null, -- 'Investment Adviser' | 'Research Analyst' for now
  valid_from text,        -- raw display string, e.g. "13 Apr, 2026"
  valid_to text,           -- raw display string if lapsed/cancelled, else null
  is_active boolean not null default true,
  address text,
  phone text,
  email text,
  synced_at timestamptz not null default now()
);

create index if not exists sebi_intermediaries_name_idx on sebi_intermediaries (lower(name));
create index if not exists sebi_intermediaries_category_idx on sebi_intermediaries (category);

alter table sebi_intermediaries enable row level security;
-- service_role-only (no policies) — same convention as every other table
-- since 0001_init.sql. All access goes through lib/supabase/admin.ts from
-- server-side code (the sync job and the lookup API route), same pattern
-- as vpa_registered_name_cache.
