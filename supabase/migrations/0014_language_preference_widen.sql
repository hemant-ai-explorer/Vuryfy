-- Widen user_preferences.language's check constraint to cover all 8 launch
-- languages — Sept 18, 2026. 0011_user_preferences.sql (Sept 16) shipped
-- Phase 1 with English + Hindi only ('en', 'hi'), by the user's explicit
-- choice to prove the whole mechanism before scaling to the remaining 6
-- (see architecture-decisions.md's "Multilingual support (Phase 1: English
-- + Hindi) shipped" entry). This migration adds Kannada, Malayalam, Tamil,
-- Telugu, Gujarati, and Bengali, matching the language codes now wired
-- into lib/translations.ts's Language type and SUPPORTED_LANGUAGES list
-- (lib/translations-kn.ts, -ml.ts, -ta.ts, -te.ts, -gu.ts, -bn.ts).
--
-- Same drop-and-re-add pattern as every prior input_type constraint widen
-- in this migration sequence (0004/0005/0006/0008/0013) — Postgres has no
-- "add value to check constraint" shorthand, so the constraint is dropped
-- and recreated with the full new list.
alter table user_preferences drop constraint if exists user_preferences_language_check;
alter table user_preferences add constraint user_preferences_language_check
  check (language in ('en', 'hi', 'kn', 'ml', 'ta', 'te', 'gu', 'bn'));
