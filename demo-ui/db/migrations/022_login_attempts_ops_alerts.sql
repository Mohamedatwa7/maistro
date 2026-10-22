-- 022 — login throttling (SECURITY.md F-G) and operational alerts (Phase 12 monitoring).
-- login_attempts holds a salted hash of the client IP, never the IP itself; rows older than 7 days are pruned.
-- ops_alerts is what the monitor (and the login throttle's global counter) writes; an alert is posted to the
-- owner's webhook once and marked sent_at. Both service role only (RLS on, no policies).
create table if not exists login_attempts (
  id bigint generated always as identity primary key,
  ip_hash text not null,
  ok boolean not null,
  at timestamptz not null default now()
);
create index if not exists login_attempts_ip_idx on login_attempts (ip_hash, at desc);
create index if not exists login_attempts_at_idx on login_attempts (at);
alter table login_attempts enable row level security;

create table if not exists ops_alerts (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  kind text not null,
  severity text not null default 'warning' check (severity in ('info','warning','critical')),
  message text not null,
  details jsonb not null default '{}'::jsonb,
  sent_at timestamptz,
  resolved_at timestamptz
);
create index if not exists ops_alerts_kind_idx on ops_alerts (kind, at desc);
alter table ops_alerts enable row level security;
