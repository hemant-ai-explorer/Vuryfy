-- Per-call cost logging (Part 19, LOCKED — "cost per verification must be
-- logged from day one") — this table was never built until now (Sept 16,
-- 2026); every margin/profitability figure discussed for the Rs 99/Rs 299
-- plans up to this point has been an estimate, never measured data. This
-- migration, plus lib/cost-pricing.ts (pricing constants) and the logging
-- calls wired into lib/ai-gateway.ts, lib/search-gateway.ts, and
-- lib/embeddings.ts (the three files that between them make every metered
-- external call this app makes — Part 11's "AI/Search Gateway" lock is
-- exactly what makes this a 3-file change instead of touching every
-- route), closes that gap.
--
-- One row per metered call's FINAL outcome, not per retry attempt — a
-- transient retry inside callStructured()/search() does not get its own
-- row (see ai-gateway.ts's logCost() / search-gateway.ts's equivalent). A
-- failed call is still logged (status='error', estimated_cost_usd=0) so
-- failure rates are visible here too, not just cost.
--
-- Deliberately NOT attempting full per-individual-check cost attribution
-- (which would need a request_id threaded through every API route plus a
-- new column on verifications) — left as an optional "phase 2" until this
-- coarser, call-site-level view proves useful on its own. call_site (a
-- short, hand-written label like "quick-check.verdict" or
-- "video-analysis.deep") is the aggregation key for now — group by it (and
-- by model/provider) in the SQL editor to see where money actually goes.
create table if not exists api_cost_logs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  provider text not null check (provider in ('gemini', 'tavily')),
  model text,
  tier text check (tier in ('cheap', 'reasoning')),
  call_site text not null,
  prompt_tokens integer not null default 0,
  output_tokens integer not null default 0,
  total_tokens integer not null default 0,
  search_credits integer not null default 0,
  estimated_cost_usd numeric(12, 6) not null default 0,
  used_fallback boolean not null default false,
  status text not null default 'success' check (status in ('success', 'error')),
  error_message text
);

comment on table api_cost_logs is
  'Per-call cost log for every Gemini/Tavily call this app makes, fire-and-forget written from lib/ai-gateway.ts, lib/search-gateway.ts, and lib/embeddings.ts. estimated_cost_usd is computed from lib/cost-pricing.ts''s hardcoded rates, not provider-billed truth — a running estimate for unit-economics visibility, not an invoice reconciliation.';

-- Read-heavy table (SQL-editor cost queries, not app-served) — an index on
-- created_at covers every "cost by day" / "cost in the last N days" query
-- this table exists for; call_site is the other common group-by, indexed
-- separately so a query filtering or grouping by it doesn't scan the whole
-- table as it grows.
create index if not exists api_cost_logs_created_at_idx on api_cost_logs (created_at desc);
create index if not exists api_cost_logs_call_site_idx on api_cost_logs (call_site);

-- Same RLS convention as every other table in this schema: enabled, zero
-- policies — only the service_role client (lib/supabase/admin.ts) ever
-- touches this table, written directly from the gateway files above, never
-- through a user-facing API route.
alter table api_cost_logs enable row level security;

-- Same service_role grants every new migration needs going forward (see
-- architecture-decisions.md's "service_role had no table privileges" bug
-- fix for why this is written directly into the migration now rather than
-- discovered as a follow-up bug).
grant all on api_cost_logs to service_role;
