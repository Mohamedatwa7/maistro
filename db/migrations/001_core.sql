-- Maistro core schema (DATA-MODEL.md §2). Forward-only migration 001.
-- UUIDs: UUIDv7 is generated app-side (Python uuid6/uuid7); gen_random_uuid()
-- is the DB-side fallback so ad-hoc inserts still work.
-- LangGraph's PostgresSaver manages its own checkpoint tables in schema
-- "langgraph" (created by the library in M2, not here).

create extension if not exists pgcrypto;

create table campaigns (
  campaign_id      uuid primary key default gen_random_uuid(),
  status           text not null check (status in (
                     'trend_selected','brief_generated','awaiting_draft',
                     'scoring','score_evaluated','revising','awaiting_approval',
                     'approved','publishing','published','monitoring',
                     'learnings_written','closed','cancelled','escalated')),
  trend_ref        jsonb not null,          -- frozen AgentTrend snapshot
  brief_id         uuid,                    -- FK added after briefs exists
  creator_id       text not null,
  current_version  int  not null default 0,
  max_iterations   int  not null default 4,
  score_threshold  numeric(3,1) not null default 7.0,
  publish_targets  text[] not null default '{tiktok}',
  state_version    int  not null default 1,
  created_at       timestamptz not null default now(),
  closed_at        timestamptz
);

create table briefs (
  brief_id     uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references campaigns(campaign_id),
  body         jsonb not null,              -- Brief schema (contracts/schemas/brief.json)
  learnings_applied uuid[] not null default '{}',
  generated_at timestamptz not null default now()
);

alter table campaigns
  add constraint campaigns_brief_fk foreign key (brief_id) references briefs(brief_id);

create table content_versions (
  content_version_id uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references campaigns(campaign_id),
  iteration     int  not null check (iteration >= 1),
  asset_ref     text not null,              -- storage key: {campaign_id}/{iteration}/{filename}
  media_type    text not null check (media_type in ('image','video')),
  submitted_by  text not null,
  submitted_at  timestamptz not null default now(),
  creator_notes text,
  f1x8_job_id   text,                       -- null for synchronous image analysis
  analysis_result jsonb,                    -- frozen F1X8 AnalysisResult
  validation_report jsonb,                  -- postability gate output (docs/POSTABILITY.md)
  asset_sha256  text,                       -- sealed-artifact identity (score-what-you-post)
  unique (campaign_id, iteration)
);

create table approvals (
  approval_id        uuid primary key default gen_random_uuid(),
  campaign_id        uuid not null references campaigns(campaign_id),
  content_version_id uuid not null references content_versions(content_version_id),
  decision    text not null check (decision in ('approved','rejected')),
  approver_id text not null,
  note        text,
  brief_fit_rubric jsonb,                   -- J4 rubric (contracts/schemas/approval.json)
  decided_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

create table publish_records (
  publish_record_id  uuid primary key default gen_random_uuid(),
  idempotency_key    text not null unique,  -- {campaign_id}:{platform}:{content_version_id} (ADR D8)
  campaign_id        uuid not null references campaigns(campaign_id),
  content_version_id uuid not null references content_versions(content_version_id),
  approval_id        uuid not null references approvals(approval_id),
  platform         text not null check (platform in ('tiktok','instagram','facebook','x')),
  status           text not null check (status in
                     ('pending','published','failed','skipped_duplicate','unknown')),
  platform_post_id text,
  post_url         text,
  published_at     timestamptz,
  error            jsonb,
  created_at       timestamptz not null default now()
);

create table campaign_metrics (             -- daily monitoring snapshots
  campaign_id  uuid not null references campaigns(campaign_id),
  snapshot_day date not null,
  platform     text not null,
  views bigint, likes bigint, shares bigint, comment_count bigint,
  engagement_rate numeric,
  sentiment jsonb,
  raw jsonb not null,                       -- full source payloads (forensics)
  primary key (campaign_id, snapshot_day, platform)
);

create table learnings (
  learning_id  uuid primary key default gen_random_uuid(),
  campaign_id  uuid not null references campaigns(campaign_id),
  predicted_score numeric not null,
  predicted_percentile numeric,
  actual_metrics jsonb not null,
  actual_percentile numeric,
  delta numeric,
  insight text not null,
  insight_status text not null default 'candidate'
    check (insight_status in ('candidate','confirmed','retired')),
  created_at timestamptz not null default now()
);

create table effect_records (               -- node idempotency (ARCHITECTURE §4.2)
  campaign_id uuid not null,
  node        text not null,
  attempt_key text not null,
  result      jsonb,
  created_at  timestamptz not null default now(),
  primary key (campaign_id, node, attempt_key)
);

create table audit_events (                 -- append-only; enforced below
  event_id    uuid primary key default gen_random_uuid(),
  campaign_id uuid,
  actor       text not null,                -- service | creator:<id> | approver:<id> | operator:<id>
  event       text not null,
  detail      jsonb,
  at          timestamptz not null default now()
);

create table creators (
  creator_id   text primary key,
  display_name text not null,
  api_key_hash text not null,               -- scoped MCP key, hashed
  active       boolean not null default true
);

-- Append-only guard on the audit log (ADR D7: answerable forever).
create or replace function forbid_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end $$;

create trigger audit_events_no_update before update or delete on audit_events
  for each row execute function forbid_mutation();

-- Indexes for the hot paths.
create index campaigns_status_idx on campaigns (status);
create index content_versions_campaign_idx on content_versions (campaign_id);
create index audit_events_campaign_idx on audit_events (campaign_id, at);
create index learnings_status_idx on learnings (insight_status, created_at);
create index publish_records_campaign_idx on publish_records (campaign_id);

-- Stuck-campaign detection (DATA-MODEL.md §1). Timestamps of the last
-- transition come from audit_events.
create view campaign_health as
select c.campaign_id,
       c.status,
       c.creator_id,
       last_event.at         as last_transition_at,
       now() - last_event.at as time_in_status,
       case
         when c.status = 'scoring'     and now() - last_event.at > interval '1 hour'   then true
         when c.status = 'publishing'  and now() - last_event.at > interval '15 min'   then true
         when c.status = 'escalated'   and now() - last_event.at > interval '24 hours' then true
         else false
       end as stuck
from campaigns c
left join lateral (
  select at from audit_events e
  where e.campaign_id = c.campaign_id
  order by e.at desc limit 1
) last_event on true
where c.status not in ('closed','cancelled');
