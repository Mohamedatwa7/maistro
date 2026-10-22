-- 019 — publishing_slots (8b, ADR-008): when and where an approved final goes out. Manual/export mode until
-- Sprinklr access exists: a line manager or admin plans a slot (platform, owned account, time, caption), exports
-- the delivery package, posts it by hand, and links the published post ("Published as"), which marks the slot
-- posted. Nothing is deleted: a cancel sets canceled_at.
create table if not exists publishing_slots (
  id bigint generated always as identity primary key,
  piece_id uuid not null references content_pieces(id),
  platform text not null check (platform in ('tiktok','instagram','facebook','x')),
  account text not null,
  slot_at timestamptz not null,
  caption text,
  mode text not null default 'manual_export' check (mode in ('manual_export','sprinklr')),
  status text not null default 'planned' check (status in ('planned','exported','posted','canceled')),
  created_by uuid,
  created_by_label text,
  created_at timestamptz not null default now(),
  exported_at timestamptz,
  posted_at timestamptz,
  piece_post_id bigint references piece_posts(id),
  canceled_at timestamptz,
  cancel_reason text
);
create index if not exists publishing_slots_when_idx on publishing_slots (slot_at);
create index if not exists publishing_slots_piece_idx on publishing_slots (piece_id);
alter table publishing_slots enable row level security;
