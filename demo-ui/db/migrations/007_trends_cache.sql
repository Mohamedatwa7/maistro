-- 007 — trends_cache (ADR-005, M4): the last good board from Trend Radar's
-- agent API, normalised and curated, so /api/trends serves the cache and
-- survives an upstream outage with a `stale` flag instead of a blank page.
-- One row per key ('board'). Refreshed on read when older than an hour (the
-- Hobby plan has no hourly cron); an hourly cron can take over on Pro.
create table if not exists trends_cache (
  id text primary key,
  payload jsonb not null default '{}'::jsonb,   -- {raw:[…], curated:[…], curatedBy, source, live, boardGeneratedAt, total}
  source text,
  board_generated_at timestamptz,
  fetched_at timestamptz not null default now(),
  error text                                     -- last refresh failure while this row was served stale
);
alter table trends_cache enable row level security;
-- No policies: the service role (server) is the only reader and writer.
