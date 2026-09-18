-- WhatsApp submission linking table — Sept 18, 2026 (Part 13's locked
-- design: submission METHOD is kept separate from verification TYPE — a
-- user can submit a claim via WhatsApp instead of typing it into the app).
--
-- MVP scope, explicit: text/link claims only, submitted via a one-time
-- code the user generates in-app (app/api/whatsapp/link-code/route.ts)
-- and sends as their first WhatsApp message. The webhook
-- (app/api/whatsapp/webhook/route.ts) matches that code to this row, then
-- treats the user's NEXT message from that phone number as the claim
-- text and runs it through the normal Quick Check pipeline. QR/image/
-- audio/video submission via WhatsApp is a deliberate next-phase
-- extension, not built in this pass — same "prove the mechanism with one
-- type first, then extend" sequencing as every other multi-part feature
-- in this project (QR -> image -> audio -> video; English+Hindi -> the
-- remaining 7 languages).
--
-- Result delivery, per the user's explicit choice: WhatsApp is a pure
-- upload channel here, not a reply channel — the verdict is never sent
-- back over WhatsApp. The one exception is a short operational
-- confirmation when the LINK step succeeds ("you're linked, send your
-- claim next") — never the verdict itself. The user views the actual
-- result in the app, via the new history list (app/saved/page.tsx) once
-- it's landed in `verifications`.
--
-- One row per code. A code starts unlinked (phone_number/linked_at
-- null) — generated the moment the user asks for a WhatsApp link in the
-- app, before they've sent anything. The webhook sets phone_number +
-- linked_at on the first WhatsApp message that matches the code text,
-- then marks the SAME row consumed (consumed_at, verification_id) once
-- the follow-up claim message has been processed into a real
-- `verifications` row — a code is single-use end to end, not just
-- single-link, so it can't be replayed to submit a second claim for
-- free.
--
-- Same RLS convention as every other table in this schema: enabled, zero
-- policies — only the service_role client (used by both the in-app API
-- route and the public webhook route) touches this table directly.
create table if not exists whatsapp_link_codes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null,
  mode text not null default 'quick' check (mode in ('quick', 'deep')),
  input_type text not null default 'text' check (input_type in ('text', 'link')),
  phone_number text,
  linked_at timestamptz,
  consumed_at timestamptz,
  verification_id uuid references verifications(id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table whatsapp_link_codes is
  'One-time codes correlating an inbound WhatsApp message back to the Vuryfy user who generated it in-app (Part 13). A missing linked_at means the code has been shown to the user but not yet sent over WhatsApp; a missing consumed_at means it is still awaiting (or mid-) processing.';

alter table whatsapp_link_codes enable row level security;

-- Same service_role grant every new migration needs (see
-- architecture-decisions.md's "service_role had no table privileges" bug
-- fix — written directly into the migration now rather than discovered
-- as a follow-up bug).
grant all on whatsapp_link_codes to service_role;

-- Only one ACTIVE (unconsumed) row may hold a given code text at a time,
-- so the webhook's code lookup can't ambiguously match two live codes.
-- A partial unique index rather than a plain unique constraint, so an
-- old consumed/expired code's text is free to be reissued later.
create unique index if not exists whatsapp_link_codes_active_code_idx
  on whatsapp_link_codes(code) where consumed_at is null;

create index if not exists whatsapp_link_codes_user_id_idx on whatsapp_link_codes(user_id);
create index if not exists whatsapp_link_codes_phone_idx on whatsapp_link_codes(phone_number) where consumed_at is null;
