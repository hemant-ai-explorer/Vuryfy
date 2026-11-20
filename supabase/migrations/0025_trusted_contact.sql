-- Trusted contact for the digital-arrest Scam SOS feature — Nov 20, 2026.
-- See claude/scam-feature-digital-arrest-2026-11-20.md (Vuryfy project
-- notes) for the full feasibility writeup this was built from.
--
-- "Digital arrest" scams work by isolating the victim mid-call ("don't
-- tell your family, bank, or a lawyer"). The SOS feature on
-- app/verify/digital-arrest/page.tsx breaks that isolation with a one-tap
-- WhatsApp/SMS message to someone the user picked in advance — but that
-- only works if the contact is already saved, so it lives in
-- user_preferences (set once in Settings, read instantly mid-call) rather
-- than being typed in under pressure during the scam call itself.
--
-- Both columns nullable: a user who hasn't set a trusted contact yet still
-- gets the rest of the digital-arrest check (the guided checklist and the
-- escape toolkit don't depend on this), the SOS section just prompts them
-- to add one in Settings instead of showing a broken button.
alter table user_preferences
  add column if not exists trusted_contact_name text,
  add column if not exists trusted_contact_phone text;

comment on column user_preferences.trusted_contact_name is
  'Display name for the Scam SOS one-tap contact (digital-arrest feature) — free text, user-entered, not verified against anything.';
comment on column user_preferences.trusted_contact_phone is
  'E.164-ish digits-only phone number (country code prefixed, no +, no spaces — see lib/trusted-contact.ts''s normalizeTrustedContactPhone) used to build the wa.me/sms: SOS links. Not validated as a real, reachable number.';

-- No RLS policy changes needed — user_preferences already has RLS enabled
-- with zero policies (service_role-only, same convention as every table
-- since 0001_init.sql), and service_role already has ALL privileges on it
-- from 0011_user_preferences.sql's grant. New columns on an existing table
-- inherit the existing grant automatically.
