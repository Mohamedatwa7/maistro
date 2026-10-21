-- 004 — jobs: the server-side record of every long-running provider call (ADR-004).
create table if not exists jobs (
  id uuid primary key default gen_random_uuid(),
  piece_id uuid references content_pieces (id) on delete restrict,
  stage_id uuid references stages (id) on delete restrict,
  kind text not null check (kind in ('director','higgsfield_image','higgsfield_video','f1x8_image','f1x8_video','hermes_stage','curation')),
  provider_ref text,
  state text not null default 'queued' check (state in ('queued','running','succeeded','failed','timed_out','cancelled')),
  attempts integer not null default 0,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  next_poll_at timestamptz
);
create index if not exists jobs_due_idx on jobs (state, next_poll_at) where state in ('queued','running');
create index if not exists jobs_piece_idx on jobs (piece_id, created_at desc);
alter table jobs enable row level security;
drop policy if exists jobs_member_read on jobs;
create policy jobs_member_read on jobs for select using (exists (select 1 from members m where m.id = auth.uid() and m.active));
