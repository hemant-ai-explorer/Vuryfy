-- Widen user_preferences.language's check constraint to add Marathi ('mr')
-- — Sept 18, 2026 (later same day as 0014). Marathi is a 9th language,
-- beyond Part 11's original 8-language list, added per the user's direct
-- request ("can you also add marathi language"), matching lib/translations-
-- mr.ts and the 'mr' entry now wired into lib/translations.ts's Language
-- type and SUPPORTED_LANGUAGES list.
--
-- New migration rather than editing 0014 in place, since 0014 may already
-- have been run against a live database — same drop-and-re-add pattern as
-- every prior check-constraint widen in this sequence (0004/0005/0006/
-- 0008/0013/0014).
alter table user_preferences drop constraint if exists user_preferences_language_check;
alter table user_preferences add constraint user_preferences_language_check
  check (language in ('en', 'hi', 'kn', 'ml', 'ta', 'te', 'gu', 'bn', 'mr'));
