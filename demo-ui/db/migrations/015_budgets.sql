-- 015 — Phase 6.9 cost control: a per-piece budget (warning threshold + hard
-- cap) and the provider's estimate on every render job.
alter table content_pieces add column if not exists budget_usd numeric(10,2);          -- null = the configured default
alter table content_pieces add column if not exists budget_warn_pct integer not null default 80 check (budget_warn_pct between 1 and 100);
alter table jobs add column if not exists estimate_usd numeric(10,4);                  -- Higgsfield /estimate for the exact submitted body
