-- 002 — content pieces and their stages (ARCHITECTURE_TARGET §3).
create table if not exists content_pieces (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  product text,
  key_message text,
  angle text,
  markets text[] not null default '{}',
  platforms text[] not null default '{}',
  trend_id text,
  trend_name text,
  origin text not null check (origin in ('hermes_dispatch','external_hermes','studio')),
  legacy_id text unique,                 -- the browser-side id (gen-… / ext-…) while the legacy UI syncs here
  created_by uuid references members (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
drop trigger if exists content_pieces_updated_at on content_pieces;
create trigger content_pieces_updated_at before update on content_pieces for each row execute function set_updated_at();

create table if not exists stages (
  id uuid primary key default gen_random_uuid(),
  piece_id uuid not null references content_pieces (id) on delete restrict,
  kind text not null check (kind in ('plan','mood','thumb','brief','board','draft','qc','final')),
  position smallint not null,
  state text not null default 'locked' check (state in ('locked','ready','generating','generated','rejected','approved')),
  current_version_id uuid,
  updated_at timestamptz not null default now(),
  unique (piece_id, kind)
);
create index if not exists stages_piece_idx on stages (piece_id);
drop trigger if exists stages_updated_at on stages;
create trigger stages_updated_at before update on stages for each row execute function set_updated_at();

alter table content_pieces enable row level security;
alter table stages enable row level security;
-- Reads for any active member; writes are server-side only.
drop policy if exists content_pieces_member_read on content_pieces;
create policy content_pieces_member_read on content_pieces for select using (exists (select 1 from members m where m.id = auth.uid() and m.active));
drop policy if exists stages_member_read on stages;
create policy stages_member_read on stages for select using (exists (select 1 from members m where m.id = auth.uid() and m.active));
