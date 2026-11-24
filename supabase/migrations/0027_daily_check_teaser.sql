-- Daily Check "teaser" field — Nov 24, 2026.
--
-- Problem: the WhatsApp message sent for each Daily Check carried the
-- FULL explanation (the "summary" field) in its body. That fully answers
-- the question right there in the chat thread, so there was no reason
-- for the recipient to tap the /today/<slug> link — the product's whole
-- click-through goal was undermined by its own content design.
--
-- Fix: a new, deliberately incomplete "teaser" field — a short
-- curiosity-gap line distinct from both "headline" (the verdict) and
-- "summary" (the full reasoning, shown only on the /today page). The
-- WhatsApp message now sends headline + teaser + link; "summary" never
-- appears outside the app. See lib/daily-check.ts and
-- app/api/cron/daily-check/route.ts for the generation/send logic, and
-- app/today/[slug]/page.tsx for where "summary" is actually shown, plus
-- the new "Share on WhatsApp" wa.me link (built from headline + teaser)
-- that lets a reader forward the article to any WhatsApp number via
-- their own WhatsApp client.
--
-- Same per-language jsonb shape as "headline"/"summary"/"caveats"
-- (keyed by Vuryfy language code, e.g. {"en": "...", "hi": "..."}).
-- Default '{}' so this backfills cleanly against any already-published
-- rows (none expected yet in practice, since Daily Check only shipped
-- Nov 21, 2026 and sending has stayed disabled pending WhatsApp template
-- approval) without needing a backfill script.
alter table public.daily_checks
  add column if not exists teaser jsonb not null default '{}'::jsonb;

comment on column public.daily_checks.teaser is
  'Per-language short curiosity-gap line sent in the WhatsApp message body (distinct from summary, which is the full explanation shown only on the /today page). Keyed by language code, same shape as headline/summary/caveats.';
