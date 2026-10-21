-- 013 — Phase 6.2: automated checks per stage version, human selection on
-- approvals, and the vision-check job kind.
create table if not exists stage_checks (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  piece_id uuid not null references content_pieces (id) on delete restrict,
  stage_id uuid not null references stages (id) on delete restrict,
  artifact_version_id uuid not null references artifact_versions (id) on delete restrict,
  kind text not null check (kind in ('vision','copy','spec')),
  passed boolean,
  results jsonb not null default '{}'::jsonb,
  model text,
  prompt_version text,
  job_id uuid
);
create index if not exists stage_checks_version_idx on stage_checks (artifact_version_id, at desc);

alter table approvals add column if not exists details jsonb;   -- e.g. {selectedImages:[0,2], annotations:"…"}

alter table jobs drop constraint if exists jobs_kind_check;
alter table jobs add constraint jobs_kind_check check (kind in ('director','higgsfield_image','higgsfield_video','f1x8_image','f1x8_video','hermes_stage','curation','vision_check'));

alter table stage_checks enable row level security;
drop policy if exists stage_checks_member_read on stage_checks;
create policy stage_checks_member_read on stage_checks for select using (exists (select 1 from members m where m.id = auth.uid() and m.active));
