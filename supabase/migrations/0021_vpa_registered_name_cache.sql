-- 0021_vpa_registered_name_cache.sql
-- Sept 24, 2026 — cache for the real Eko VPA (UPI ID) -> registered name
-- lookup (lib/vpa-registered-name.ts), wired in today with live Eko
-- production credentials. A registered name essentially never changes, so
-- this is a long-TTL (90 day, enforced in application code) cache keyed
-- by UPI ID, checked before any billed Eko call — this was flagged as the
-- natural next step when the stub was first written (Sept 23, 2026) and
-- is added now rather than skipped, consistent with this project's
-- ongoing cost-control design (see unit-economics notes).

create table if not exists vpa_registered_name_cache (
  upi_id text primary key,
  registered_name text not null,
  fetched_at timestamptz not null default now()
);

alter table vpa_registered_name_cache enable row level security;
-- service_role-only (no policies) — same convention as every other table
-- since 0001_init.sql.
