-- WhatsApp media-first flow (Part 13 rework) — Sept 18, 2026.
--
-- Replaces the "WhatsApp auto-runs a Quick Check" MVP with what the user
-- actually asked for: WhatsApp is an INTAKE channel only. A linked phone
-- can forward text/a link OR a photo; each forward becomes a row here.
-- The app shows "you have something from WhatsApp — continue" and opens
-- the normal Verify Text / Verify Image screen pre-filled with that
-- content, so the user still picks Quick Check vs Deep Investigation
-- themselves, same as any other submission. No credit is touched and no
-- verifications row is written by the webhook anymore — that all happens
-- through the existing /api/verify and /api/verify-image routes once the
-- user acts on it in the app.
--
-- whatsapp_link_codes (0016) still owns the one-time code -> phone LINK
-- step, but a linked phone is no longer single-use: once linked, it stays
-- usable for LINK_SESSION_HOURS (see app/api/whatsapp/webhook/route.ts),
-- so multiple forwards can arrive before the user returns to the app.
--
-- Run this in the Supabase SQL Editor for BOTH vuryfy-test and vuryfy-prod.

create table if not exists whatsapp_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  phone_number text not null,
  input_type text not null check (input_type in ('text', 'image')),
  claim_text text,               -- set when input_type = 'text'
  storage_path text,             -- set when input_type = 'image' (temp-whatsapp-uploads bucket)
  mime_type text,                -- set when input_type = 'image'
  consumed_at timestamptz,       -- set once the app has pulled this into a Verify screen
  created_at timestamptz not null default now()
);

alter table whatsapp_submissions enable row level security;
grant all on whatsapp_submissions to service_role;

create index if not exists whatsapp_submissions_user_pending_idx
  on whatsapp_submissions(user_id, created_at desc) where consumed_at is null;

-- Temp storage for photos forwarded over WhatsApp, mirroring
-- 0009_temp_video_storage.sql's pattern. Private; only ever read/written
-- by the admin (service_role) client — the webhook writes it, and
-- app/api/whatsapp/pending/[id]/image/route.ts deletes it immediately
-- after streaming it to the app once, same "never persists" principle as
-- every other media type in this app (Part 15). No storage.objects RLS
-- policies needed since no browser code ever touches this bucket
-- directly (unlike temp-video-uploads, which the browser uploads to via
-- a signed URL).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'temp-whatsapp-uploads',
  'temp-whatsapp-uploads',
  false,
  15728640, -- 15MB — generous for a WhatsApp photo (WhatsApp itself compresses images well below this)
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
