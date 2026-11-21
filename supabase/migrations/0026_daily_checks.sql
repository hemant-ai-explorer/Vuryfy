-- Daily Check — Nov 21, 2026. See claude/ (Vuryfy project notes) for the
-- feature writeup: a fully-automated pipeline finds a real, currently
-- circulating scam/misinformation topic, runs it through the existing
-- evidence-grounded Deep Investigation engine (lib/deep-investigation.ts —
-- no separate "write an article" logic, no new hallucination surface),
-- and publishes the result here. app/api/cron/daily-check/route.ts is the
-- only writer (service-role only, same as every table); the result is
-- then pushed to Hemant over WhatsApp and is also readable by anyone,
-- signed in or not, at /today/<slug> — a forwarded WhatsApp link may land
-- on someone with no Vuryfy account at all, so this table (unlike every
-- other verification-result table in this app) needs a genuine public,
-- unauthenticated read path.
--
-- Content is stored per-language as jsonb objects keyed by language code
-- ("en", "hi", "kn", "ml", "ta", "te", "gu", "bn", "mr" — see
-- lib/translations.ts's Language type), produced by one localization
-- call per entry that translates/rephrases the already-investigated
-- English result — it does not re-run the investigation per language, so
-- all 9 languages share one verdict and one evidence set, never nine
-- independently-reasoned ones that could drift apart.
create table if not exists daily_checks (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  claim text not null,
  verdict text not null,
  confidence integer not null default 0,
  -- {"en": "...", "hi": "...", ...} — one short (<100 char) line per
  -- language, the text that also goes out as the WhatsApp message's
  -- headline.
  headline jsonb not null default '{}'::jsonb,
  -- {"en": "...", "hi": "...", ...} — the one-paragraph explanation,
  -- adapted per language from the English Deep Investigation summary.
  summary jsonb not null default '{}'::jsonb,
  -- {"en": ["...", ...], "hi": [...], ...} — translated caveats lists;
  -- an empty array is normal (most investigations have none).
  caveats jsonb not null default '{}'::jsonb,
  -- [{"title": "...", "url": "..."}] — language-independent, same
  -- sources regardless of which language a reader views the page in.
  sources jsonb not null default '[]'::jsonb,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists daily_checks_published_at_idx on daily_checks (published_at desc);

-- RLS: enabled, with a real public policy this time — this table is
-- meant to be read by anyone with the link, not just service_role (see
-- header above). Only ever written by service_role (the cron route).
alter table daily_checks enable row level security;

drop policy if exists "daily_checks_public_read" on daily_checks;
create policy "daily_checks_public_read" on daily_checks
  for select
  using (published_at <= now());

grant select on daily_checks to anon, authenticated;
grant all on daily_checks to service_role;

comment on table daily_checks is
  'One row per published Daily Check — an automatically-found, evidence-grounded fact-check pushed to Hemant over WhatsApp and publicly readable at /today/<slug>. See app/api/cron/daily-check/route.ts and lib/daily-check.ts.';
