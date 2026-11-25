-- Billing engine, Phase 1b — Nov 25, 2026. See
-- claude/billing-engine-scoping-2026-11-24.md in the Vuryfy project for the
-- full design. Adds a slot to cache the Razorpay Plan object id created
-- for each Vuryfy plan row (lib/razorpay.ts's getOrCreateRazorpayPlanId()
-- populates this lazily, on the first subscribe attempt for that plan —
-- no manual bootstrap step needed).
--
-- A Razorpay Plan's amount is immutable once created. To reprice an
-- existing Vuryfy plan later, update plans.price_inr as usual AND set this
-- same row's razorpay_plan_id back to null — the next subscribe attempt
-- will create a fresh Razorpay Plan at the new price. Existing subscribers
-- already on the old Razorpay Plan/price are unaffected until
-- individually migrated; this is a Razorpay platform constraint, not a
-- Vuryfy design choice.
--
-- Run this in the Supabase SQL Editor for BOTH vuryfy-test and vuryfy-prod,
-- same as every other migration in this project.

alter table public.plans
  add column if not exists razorpay_plan_id text;
