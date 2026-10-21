-- 009 — reconciliation_reports (Phase 7.0): the daily cron's reader-vs-
-- database reconciliation of the Performance data, kept as a row per run
-- so accuracy is a measured series, not a claim (PERFORMANCE_RECONCILIATION.md).
create table if not exists reconciliation_reports (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  days integer not null,
  ok boolean not null,
  report jsonb not null
);
create index if not exists reconciliation_reports_at_idx on reconciliation_reports (at desc);
alter table reconciliation_reports enable row level security;
-- No policies: the service role (server) is the only reader and writer.
