-- Widen verifications.input_type to accept "payee_reputation" — Sept 17, 2026.
--
-- Bug fix, not a new feature. app/api/verify-payee/route.ts and
-- app/api/deep-payee/route.ts (the payee-reputation Quick Check/Deep
-- Investigation pair, shipped Sept 15, 2026 — see architecture-decisions.md's
-- "Payee reputation investigation shipped" entry) have always inserted with
-- input_type = "payee_reputation", but no migration in this sequence
-- (0001_init.sql, then 0004/0005/0006/0008, each widening this same check
-- constraint one media type at a time) ever added that value to it.
--
-- Every real payee Quick Check/Deep Investigation has therefore been
-- failing at the final insert step:
--   new row for relation "verifications" violates check constraint
--   "verifications_input_type_check"   (Postgres code 23514)
-- surfaced to the user as the generic "Verification ran but couldn't be
-- saved. Please try again." — the same message this project has seen twice
-- before for two different root causes (missing service_role grants,
-- Sept 12; a malformed-JSON request body, Sept 16). This is a third,
-- distinct cause. Confirmed via the actual server-side log line during
-- Sept 17, 2026 live testing of the unrelated payee.disclaimer
-- localization fix — this constraint gap predates that fix by two days and
-- has blocked every payee check regardless of language.
--
-- Run this in the Supabase SQL Editor for BOTH vuryfy-test and vuryfy-prod.

alter table public.verifications drop constraint if exists verifications_input_type_check;
alter table public.verifications add constraint verifications_input_type_check
  check (input_type in ('text', 'link', 'qr', 'ocr', 'image', 'audio_transcript', 'audio', 'video_transcript', 'video', 'payee_reputation'));
