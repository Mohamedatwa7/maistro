-- 003 — versioned artifacts, immutable approvals, ADLCP documents, QC results.
create table if not exists artifact_versions (
  id uuid primary key default gen_random_uuid(),
  stage_id uuid not null references stages (id) on delete restrict,
  version integer not null,
  kind text not null check (kind in ('text','image','video','qc_report')),
  payload jsonb not null default '{}'::jsonb,
  produced_by text not null check (produced_by in ('claude','higgsfield_soul','higgsfield_seedance','f1x8','external_hermes','manual')),
  job_id uuid,
  generated_by uuid references members (id),
  created_at timestamptz not null default now(),
  unique (stage_id, version)
);
create index if not exists artifact_versions_stage_idx on artifact_versions (stage_id, version desc);

alter table stages drop constraint if exists stages_current_version_fk;
alter table stages add constraint stages_current_version_fk foreign key (current_version_id) references artifact_versions (id) deferrable initially deferred;

create table if not exists approvals (
  id uuid primary key default gen_random_uuid(),
  artifact_version_id uuid not null references artifact_versions (id) on delete restrict,
  decision text not null check (decision in ('approved','rejected')),
  reason text,
  decided_by uuid references members (id),
  name_as_signed text not null,
  role_as_signed text not null,
  decided_at timestamptz not null default now()
);
create index if not exists approvals_version_idx on approvals (artifact_version_id, decided_at desc);
-- One approval per version: a second "approved" row for the same version is impossible.
create unique index if not exists approvals_one_approved_per_version on approvals (artifact_version_id) where decision = 'approved';

create table if not exists adlcp_documents (
  id uuid primary key default gen_random_uuid(),
  artifact_version_id uuid not null references artifact_versions (id) on delete restrict,
  kind text not null check (kind in ('line_manager','adlcp')),
  storage_path text not null,
  sha256 text not null,
  size_bytes integer not null check (size_bytes > 0),
  content_type text not null,
  uploaded_by uuid references members (id),
  uploaded_at timestamptz not null default now(),
  unique (artifact_version_id, kind)
);

create table if not exists qc_results (
  id uuid primary key default gen_random_uuid(),
  artifact_version_id uuid not null references artifact_versions (id) on delete restrict,
  job_id uuid,
  provider text not null default 'f1x8',
  score numeric(4,2),
  result jsonb not null default '{}'::jsonb,
  heatmap_path text,
  created_at timestamptz not null default now()
);
create index if not exists qc_results_version_idx on qc_results (artifact_version_id, created_at desc);

alter table artifact_versions enable row level security;
alter table approvals enable row level security;
alter table adlcp_documents enable row level security;
alter table qc_results enable row level security;
drop policy if exists artifact_versions_member_read on artifact_versions;
create policy artifact_versions_member_read on artifact_versions for select using (exists (select 1 from members m where m.id = auth.uid() and m.active));
drop policy if exists approvals_member_read on approvals;
create policy approvals_member_read on approvals for select using (exists (select 1 from members m where m.id = auth.uid() and m.active));
drop policy if exists adlcp_documents_approver_read on adlcp_documents;
create policy adlcp_documents_approver_read on adlcp_documents for select using (exists (select 1 from members m where m.id = auth.uid() and m.active and m.role in ('admin','line_manager','adlcp_approver','reviewer')));
drop policy if exists qc_results_member_read on qc_results;
create policy qc_results_member_read on qc_results for select using (exists (select 1 from members m where m.id = auth.uid() and m.active));
