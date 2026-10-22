-- 020 — perf_payloads (Phase 10): the 60-day Performance read, computed by the 06:30 track cron right after the
-- tracker's daily sync and served from here in well under a second instead of a 1–2 minute live read. It holds
-- customer comment text, so row-level security is on with NO policies (service role only) and it is served only
-- through the session-gated /api/track read. One row per kind (upserted); the reader falls back to the live
-- read when the row is missing or older than 26 h.
create table if not exists perf_payloads (
  kind text primary key check (kind in ('track_60d')),
  days integer not null,
  computed_at timestamptz not null,
  tracker_newest timestamptz,
  comments_partial boolean not null default false,
  payload jsonb not null
);
alter table perf_payloads enable row level security;
