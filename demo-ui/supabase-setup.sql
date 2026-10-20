-- Maistro campaign store — run once in the Supabase SQL Editor.
-- Holds every artifact the external Hermes agent pushes via POST /api/ingest.

create table if not exists campaign_events (
  id bigint generated always as identity primary key,
  project_id text not null,
  stage text not null check (stage in ('plan','mood','thumb','brief','board','final','qc')),
  agent text,
  trend jsonb,
  artifact jsonb not null,
  at timestamptz not null default now()
);

create index if not exists campaign_events_project_idx
  on campaign_events (project_id, stage, at desc);

-- Lock the table down: RLS on with no policies means the anon/public key can
-- do nothing. Maistro's API uses the service-role key, which bypasses RLS.
alter table campaign_events enable row level security;

-- Consumer Sentiment Tracker integration: post performance + comment snapshots.
-- The tracker POSTs snapshots to /api/sentiment; latest snapshot per post wins.
create table if not exists sentiment_posts (
  id bigint generated always as identity primary key,
  post_id text not null,
  platform text,
  account text,
  caption text,
  url text,
  posted_at timestamptz,
  metrics jsonb not null default '{}'::jsonb,
  sentiment jsonb not null default '{}'::jsonb,
  comments jsonb not null default '[]'::jsonb,
  at timestamptz not null default now()
);

create index if not exists sentiment_posts_idx
  on sentiment_posts (post_id, at desc);

alter table sentiment_posts enable row level security;
