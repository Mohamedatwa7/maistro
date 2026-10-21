-- 010 — trend_scores and trend_decisions (TREND_FRAMEWORK.md §6): every
-- scoring run stores, per trend, the exact inputs, the prompt/model/weights
-- versions, the vetoes, the criteria and the final score, so a ranking is
-- reproducible and auditable; every human pick/skip/override is a row.
create table if not exists trend_scores (
  id bigint generated always as identity primary key,
  at timestamptz not null,
  trend_id text not null,
  name text not null,
  board_generated_at timestamptz,
  prompt_version text not null,
  model text,
  weights_version text not null,
  status text not null check (status in ('scored','vetoed','needs_review','unjudged')),
  final_score numeric(5,1),
  lifecycle text,
  post_by timestamptz,
  product text,
  confidence text,
  vetoes jsonb not null default '[]'::jsonb,
  criteria jsonb not null default '{}'::jsonb,
  judgement jsonb,
  inputs jsonb not null default '{}'::jsonb
);
create index if not exists trend_scores_at_idx on trend_scores (at desc);
create index if not exists trend_scores_trend_idx on trend_scores (trend_id, at desc);
create index if not exists trend_scores_board_idx on trend_scores (board_generated_at, prompt_version);

create table if not exists trend_decisions (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  trend_id text not null,
  score_id bigint references trend_scores (id),
  decision text not null check (decision in ('pick','skip','reject','override_veto','override_score')),
  reason_code text,
  reason text,
  decided_by uuid references members (id),
  name_as_signed text
);
create index if not exists trend_decisions_trend_idx on trend_decisions (trend_id, at desc);

alter table trend_scores enable row level security;
alter table trend_decisions enable row level security;
-- No policies: the service role (server) is the only reader and writer.
