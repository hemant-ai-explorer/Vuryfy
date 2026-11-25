-- Billing engine, Phase 1a — Nov 24, 2026. See
-- claude/billing-engine-scoping-2026-11-24.md in the Vuryfy project for the
-- full design. Implements the schema for Correction #2's two billing
-- triggers (marketing-site-2026-09-19.md): a user's 6th Quick Check, their
-- 1st Deep Investigation, or the start of their second month — whichever
-- comes first. This migration only adds the schema; lib/billing-gate.ts and
-- the two touched routes (app/api/verify, app/api/deep) are what actually
-- set these columns. Phase 1b (real Razorpay wiring) will use
-- gateway/gateway_subscription_id/gateway_customer_id below once real API
-- keys exist — they're added now so Phase 1b doesn't need its own
-- migration for columns that are already known to be needed.
--
-- Run this in the Supabase SQL Editor for BOTH vuryfy-test and vuryfy-prod,
-- same as every other migration in this project.

alter table public.subscriptions
  add column if not exists gateway text,
  add column if not exists gateway_subscription_id text,
  add column if not exists gateway_customer_id text,
  add column if not exists payment_required boolean not null default false,
  add column if not exists last_trigger text
    check (last_trigger in ('quick_check_6', 'deep_investigation_1', 'month_end')),
  add column if not exists last_trigger_at timestamptz;

-- Partial index: the cron job and every gate check only ever query for
-- payment_required = true, and that's a small minority of rows even at
-- scale, so a partial index keeps this cheap indefinitely.
create index if not exists subscriptions_payment_required_idx
  on public.subscriptions(payment_required)
  where payment_required = true;

-- payments: append-only audit ledger for every gateway event, mirroring the
-- credit_transactions philosophy already locked in 0001_init.sql ("Every
-- balance change must have a corresponding row here"). Empty/unused until
-- Phase 1b actually talks to a gateway, but created now so Phase 1b is a
-- pure code change, not a code-plus-migration change.
create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  gateway text not null,
  gateway_payment_id text,
  gateway_event text not null,
  amount_inr integer,
  status text not null,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.payments enable row level security;
create index if not exists payments_user_id_idx on public.payments(user_id);
create index if not exists payments_subscription_id_idx on public.payments(subscription_id);
