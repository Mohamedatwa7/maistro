-- 011 — Phase 6.1 shared foundations: versioned knowledge documents (brand
-- knowledge base, product catalog, market and cultural context, platform
-- specs, rejection taxonomy), the prompt registry, generation records and
-- creative specs. Documents are append-only versions; the active one per
-- (kind, key) is what prompts read. Nothing here is hardcoded in a prompt
-- once seeded (CONTENT_STUDIO.md).
create table if not exists kb_documents (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('brand_kb','product_catalog','market_context','platform_specs','rejection_taxonomy')),
  key text not null,                     -- e.g. 'voice', 'colors', 'Galaxy Z Fold8', 'UAE', 'tiktok'
  version integer not null,
  content jsonb not null,
  note text,                             -- why this version exists
  source text,                           -- provenance (playbook page, owner edit, caption evidence)
  created_by uuid references members (id),
  created_at timestamptz not null default now(),
  active boolean not null default true,
  unique (kind, key, version)
);
create index if not exists kb_documents_active_idx on kb_documents (kind, key) where active;

create table if not exists prompt_registry (
  id bigint generated always as identity primary key,
  name text not null,                    -- e.g. 'director.system', 'trends.profile'
  version text not null,
  template text not null,
  variables jsonb not null default '[]'::jsonb,
  note text,
  changed_at timestamptz not null default now(),
  unique (name, version)
);

create table if not exists generation_records (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  piece_id uuid references content_pieces (id),
  legacy_piece_id text,
  stage text,
  shot_id text,
  kind text not null check (kind in ('claude','higgsfield_image','higgsfield_video','f1x8','trend_judge','trend_curation')),
  model text,
  prompt_name text,
  prompt_version text,
  resolved_prompt text,
  params jsonb not null default '{}'::jsonb,
  seed bigint,
  input_assets jsonb not null default '[]'::jsonb,
  output_assets jsonb not null default '[]'::jsonb,
  status text not null check (status in ('succeeded','failed','refused','timed_out')),
  error text,
  latency_ms integer,
  cost_usd numeric(10,4),
  usage jsonb,
  job_id uuid,
  member_id uuid references members (id),
  correlation_id text
);
create index if not exists generation_records_piece_idx on generation_records (piece_id, at desc);
create index if not exists generation_records_at_idx on generation_records (at desc);

create table if not exists creative_specs (
  id bigint generated always as identity primary key,
  piece_id uuid not null references content_pieces (id) on delete restrict,
  version integer not null,
  spec jsonb not null,
  changed_by uuid references members (id),
  change_note text,
  created_at timestamptz not null default now(),
  unique (piece_id, version)
);
create index if not exists creative_specs_piece_idx on creative_specs (piece_id, version desc);

alter table kb_documents enable row level security;
alter table prompt_registry enable row level security;
alter table generation_records enable row level security;
alter table creative_specs enable row level security;
drop policy if exists kb_documents_member_read on kb_documents;
create policy kb_documents_member_read on kb_documents for select using (exists (select 1 from members m where m.id = auth.uid() and m.active));
drop policy if exists creative_specs_member_read on creative_specs;
create policy creative_specs_member_read on creative_specs for select using (exists (select 1 from members m where m.id = auth.uid() and m.active));
-- prompt_registry and generation_records: service role only.
