-- 008 — trend_snapshots (Phase 5.0): one row per trend per board fetch, so
-- Maistro builds its own lifecycle history (velocity, acceleration, age,
-- days on board) in code instead of reading a single point in time.
-- Written by the hourly refresh and by refresh-on-read; the board changes
-- once a day upstream, so rows repeat the same generated_at until it moves
-- (that repetition is the "still on the board" evidence).
create table if not exists trend_snapshots (
  id bigint generated always as identity primary key,
  fetched_at timestamptz not null,
  board_generated_at timestamptz,
  source text not null,
  trend_id text not null,            -- Trend Radar's id (snd-…, top-…, ig-…) or the name slug when absent
  name text not null,
  stage text,
  kind text,
  category text,
  growth_pct_per_day numeric(8,3),
  eng numeric(6,2),
  views_wk bigint,
  fit_strength smallint,
  on_brand boolean,
  signal_strength smallint,
  durability text,
  sound_music_id text,
  sound_cleared boolean,
  raw jsonb not null default '{}'::jsonb
);
create index if not exists trend_snapshots_trend_idx on trend_snapshots (trend_id, fetched_at desc);
create index if not exists trend_snapshots_fetched_idx on trend_snapshots (fetched_at desc);
alter table trend_snapshots enable row level security;
-- No policies: the service role (server) is the only reader and writer.
