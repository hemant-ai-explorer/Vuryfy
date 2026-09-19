-- Sept 19, 2026 — supports the new combined Name + Language + Phone signup
-- screen and the stub "choose your plan" step after OTP verification (see
-- architecture-decisions-addendum-2026-09-19.md's "Signup flow redesign,
-- built" entry).

-- Name is collected once at signup and shown/used going forward (e.g. a
-- future "Hi, <name>" greeting) — profiles already mirrors auth.users per
-- 0001_init.sql's comment, so this is the natural home for it rather than
-- a new table or a column on user_preferences (which is specifically
-- per-user *settings*, not identity).
alter table public.profiles add column if not exists full_name text;

-- Real drift found while building the plan-selection step, not caused by
-- it: the Sept 17, 2026 decision to reprice the ₹299 plan to ₹199 (same
-- allowance — see architecture-decisions-addendum-2026-09-17.md) was only
-- ever applied to marketing copy and docs. This table — the actual source
-- `/api/subscribe` reads from — was never updated and has been sitting at
-- price_inr=299 this whole time. Fixed here. Also renamed both plans'
-- display_name to match the marketing site's naming (Starter / Power)
-- instead of the placeholder "Vuryfy 99" / "Vuryfy 299" labels.
update public.plans set display_name = 'Starter' where code = 'plan_99';
update public.plans set display_name = 'Power', price_inr = 199 where code = 'plan_299';
