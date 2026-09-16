-- User language preference — Sept 16, 2026. Phase 1 of Part 11's locked
-- multilingual design (user language -> canonical internal claim
-- representation -> language-independent evidence engine -> localized
-- output), launched with English + Hindi only per the user's explicit
-- choice to prove the mechanism (signup picker, stored preference,
-- localized UI, localized AI output, settings-page override) before
-- scaling to the remaining 6 launch languages (Kannada, Malayalam, Tamil,
-- Telugu, Gujarati, Bengali).
--
-- One row per user, created the first time they pick a language (at
-- signup, via the login-page language-picker step — see app/login/
-- page.tsx) or updated later from the settings page. A MISSING row is the
-- signal the client uses to show the picker in the first place — this is
-- deliberately not a column on auth.users (which this app never writes to
-- directly) or a new generic "profiles" table (none existed yet; this
-- table can grow into one if more per-user preferences show up later).
create table if not exists user_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  language text not null default 'en' check (language in ('en', 'hi')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table user_preferences is
  'Per-user settings, starting with language (Phase 1 of the multilingual rollout — see architecture-decisions.md). A missing row means the user has never picked a language yet.';

-- Same RLS convention as every other table in this schema: enabled, zero
-- policies — only the service_role client (via API routes) touches this
-- table directly.
alter table user_preferences enable row level security;

-- Same service_role grants every new migration needs going forward (see
-- architecture-decisions.md's "service_role had no table privileges" bug
-- fix for why this is written directly into the migration now rather than
-- discovered as a follow-up bug).
grant all on user_preferences to service_role;
