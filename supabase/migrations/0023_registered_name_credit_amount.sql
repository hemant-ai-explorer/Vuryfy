-- Vuryfy — lets decrement_quick_check()/refund_quick_check() move more
-- than 1 credit in a single atomic call, needed for the "real registered
-- name" cost design locked in Sept 23, 2026 (see lib/vpa-registered-name.ts's
-- header): Deep Investigation bundles the real VPA→registered-name lookup
-- in at no extra cost (its allowance is small enough — 2-5/month — that the
-- worst case is a few rupees), but Quick Check only includes it as an
-- explicit 2-credit option, specifically so a user can't spend their whole
-- monthly Quick Check allowance on the ~₹1.70/lookup registered-name path
-- at the same 1-credit price as an ordinary check. See the cost-structure
-- conversation this came out of: at 1 credit, a Starter user maxing out 30
-- QCs on payee/QR checks could cost ~₹50-75/month in external lookups
-- alone against a ₹99 plan; at 2 credits, the same worst case is halved
-- (max 15 such checks/month) and DI's own worst case stays under ₹10.
--
-- Both functions gain an optional p_amount parameter, defaulting to 1, so
-- every existing caller (ordinary Quick Checks, the plain payee reputation
-- check) is unaffected and keeps decrementing/refunding exactly 1 credit
-- without passing anything new. app/api/verify-payee/route.ts is the only
-- caller that will ever pass p_amount: 2, and only when the caller
-- explicitly opted into the registered-name lookup.
--
-- The "> 0" / ">= p_amount" guard still makes this safe under concurrent
-- requests for the same reason as the original: the UPDATE's WHERE clause
-- is re-evaluated per-row inside one atomic statement, so two simultaneous
-- requests racing for the last 1-2 credits can't both succeed when there
-- isn't enough balance for both.
--
-- Run this in the Supabase SQL Editor for BOTH vuryfy-test and vuryfy-prod,
-- same as every prior migration.
--
-- Note: a separate, not-yet-built "delete my account" plan also expected to
-- claim migration number 0020 — if that lands after this one, it should
-- renumber to 0021.
--
-- Sept 23, 2026 correction: CREATE OR REPLACE FUNCTION only replaces a
-- function whose argument list matches EXACTLY — adding p_amount changes
-- the signature, so the first version of this migration didn't replace
-- decrement_quick_check(uuid)/refund_quick_check(uuid) at all, it created
-- a second, overloaded function alongside each original. Two functions
-- sharing a name confuses PostgREST's RPC resolution (surfaced as a 500 on
-- every call, including ordinary 1-credit ones from every OTHER caller of
-- these two functions — verify/route.ts, deep/route.ts, verify-image,
-- verify-audio, verify-video, and their *-combined variants, subscribe).
-- The DROPs below remove the original single-argument versions first, so
-- only the new default-parameter version remains — every existing caller
-- (which only ever passes p_user_id) keeps working exactly as before via
-- the default, while verify-payee/route.ts can also pass p_amount: 2.

drop function if exists public.decrement_quick_check(uuid);
drop function if exists public.refund_quick_check(uuid);

create or replace function public.decrement_quick_check(p_user_id uuid, p_amount integer default 1)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_remaining integer;
begin
  update public.credit_balances
    set quick_checks_remaining = quick_checks_remaining - p_amount,
        updated_at = now()
    where user_id = p_user_id
      and quick_checks_remaining >= p_amount
    returning quick_checks_remaining into v_remaining;

  return v_remaining; -- NULL if no row updated (no balance row, or insufficient balance)
end;
$$;

create or replace function public.refund_quick_check(p_user_id uuid, p_amount integer default 1)
returns integer
language plpgsql
security definer set search_path = public
as $$
declare
  v_remaining integer;
begin
  update public.credit_balances
    set quick_checks_remaining = quick_checks_remaining + p_amount,
        updated_at = now()
    where user_id = p_user_id
    returning quick_checks_remaining into v_remaining;

  return v_remaining; -- NULL if the user has no credit_balances row at all
end;
$$;
