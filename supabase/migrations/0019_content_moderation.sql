-- Illegal/harmful content handling pipeline (Part 15, LOCKED spec) — Sept
-- 19, 2026.
--
-- This is the schema half of Part 15's first addition: "a content_flagged
-- / quarantined state, distinct from normal processing states." It is
-- deliberately a NEW table rather than a new `verifications.status` value,
-- because flagged content must never reach the AI provider or get a normal
-- verdict row in the first place (see lib/content-safety.ts) — there is no
-- verifications row to attach a status to. This table is the entire record
-- of the event: what was submitted, why it was flagged, and what happened
-- to it.
--
-- Scope, per the operator's own decision (Sept 19, 2026): this pipeline
-- currently does automated detection + quarantine + an operator-visible
-- log only. It does NOT auto-submit anything to India's cybercrime portal
-- or NCMEC — actual legal reporting is a manual step for the operator,
-- taken with their own legal counsel, outside this app. See
-- lib/content-safety.ts's file header for the full rationale, including
-- why the scan function itself is currently a STUB (no hash-matching
-- provider — Thorn Safer / Microsoft PhotoDNA — is connected yet).
--
-- Run this in the Supabase SQL Editor for BOTH vuryfy-test and vuryfy-prod.

create table if not exists content_moderation_flags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  content_type text not null check (content_type in ('image', 'audio', 'video')),
  source_route text not null,        -- e.g. "verify-image", "deep-video-combined" — which endpoint caught this
  content_hash text not null,        -- sha256 hex of the raw media bytes; never the media itself (see content-safety.ts)
  scan_provider text not null,       -- e.g. "stub-unconfigured", "test-harness" until a real provider (Thorn Safer, PhotoDNA) is wired in
  scan_reason text,                  -- provider-reported reason/category, when available
  storage_path text,                 -- set for video (temp-video-uploads) when the object was deliberately NOT deleted, so it survives for a possible manual report; null for image/audio, which are never persisted to Storage at all (Part 15's existing "process, don't retain" design — see image-analysis.ts / audio-analysis.ts headers)
  status text not null default 'quarantined' check (status in ('quarantined', 'reviewed_cleared', 'reviewed_confirmed')),
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  review_notes text,
  created_at timestamptz not null default now()
);

-- RLS enabled with zero policies — same pattern as every other table in
-- this project (0001_init.sql onward): only the service_role (admin)
-- client ever touches this table, from server-side code. No browser code,
-- and no end user of any kind (including the flagged submitter), can ever
-- read or write this table directly.
alter table content_moderation_flags enable row level security;
grant all on content_moderation_flags to service_role;

-- The operator's primary query: "what's waiting for me to look at" — see
-- lib/content-safety.ts's header for how this is surfaced today (Supabase
-- Table Editor / a SQL query), since no in-app review UI exists.
create index if not exists content_moderation_flags_pending_idx
  on content_moderation_flags(created_at desc)
  where status = 'quarantined';

create index if not exists content_moderation_flags_user_idx
  on content_moderation_flags(user_id);
