# Maistro Data Model

**Version:** 1.0-draft · **Date:** 2026-09-04
**Parent:** [../ARCHITECTURE.md](../ARCHITECTURE.md) · Schemas: [CONTRACTS.md §3](CONTRACTS.md)

Maistro owns a dedicated Supabase Postgres project (ADR D5). This document
defines the campaign state machine, the table schema, and the LangGraph state
object. Migrations live in `db/` (numbered, forward-only).

---

## 1. Campaign state machine

The `campaigns.status` column is a contract: only the transitions below are
legal, each is triggered by a named event, and every transition writes an
`audit_events` row. Illegal transitions raise and page the operator.

```
                         trend_selected
                               │ brief.generated
                               ▼
                        brief_generated
                               │ brief.assigned (creator notified via MCP)
                               ▼
                 ┌──────► awaiting_draft ⏸
                 │             │ draft.submitted (MCP submit_draft)
                 │             ▼
                 │          scoring ────────────── f1x8.failed (after retry)
                 │             │ f1x8.done                 │
                 │             ▼                           ▼
                 │       score_evaluated                escalated ⏸
                 │        │           │                (operator resolves)
                 │  below threshold   │ ≥ threshold, or
                 │  & iter < max      │ submit_final, or loop_exhausted
                 │        ▼           ▼
                 └──── revising ⏸   awaiting_approval ⏸
                        (creator)     │            │
                                      │ approved   │ rejected → revising
                                      ▼
                                  approved
                                      │ publish.requested
                                      ▼
                                  publishing ── publish.failed → escalated ⏸
                                      │ publish.confirmed
                                      ▼
                                  published
                                      │ monitoring.scheduled
                                      ▼
                                  monitoring        (daily × 14 days)
                                      │ monitoring.complete
                                      ▼
                                learnings_written
                                      │ campaign.closed
                                      ▼
                                    closed

  Any non-terminal state ──cancel (operator, with note)──► cancelled
```

⏸ = maps to a LangGraph `interrupt()`; the graph is durably paused and
resumes on the named event.

Invariants (enforced in code + DB constraints where possible):

- `awaiting_approval` requires a `content_versions` row with a `score_result`
  **or** an explicit `submit_final` / `loop_exhausted` flag.
- `approved → publishing` requires an unrevoked `approvals` row for the
  **current** `content_version_id`.
- `published` requires a completed `publish_records` row.
- A campaign in `revising` with `iteration ≥ max_iterations` cannot loop —
  only `awaiting_approval` or `cancelled`.
- Terminal states: `closed`, `cancelled`. No transitions out.

Stuck-state alerting (`campaign_health` view): `scoring` > 1h,
`publishing` > 15min, `awaiting_draft` past `brief.deadline`,
`escalated` > 24h.

---

## 2. Tables

```sql
-- 001_core.sql (abridged; authoritative DDL lives in db/)

create table campaigns (
  campaign_id      uuid primary key default gen_uuidv7(),
  status           text not null check (status in (
                     'trend_selected','brief_generated','awaiting_draft',
                     'scoring','score_evaluated','revising','awaiting_approval',
                     'approved','publishing','published','monitoring',
                     'learnings_written','closed','cancelled','escalated')),
  trend_ref        jsonb not null,          -- frozen Trend snapshot
  brief_id         uuid references briefs(brief_id),
  creator_id       text not null,
  current_version  int  not null default 0,
  max_iterations   int  not null default 4,
  score_threshold  numeric(3,1) not null default 7.0,
  state_version    int  not null default 1,
  created_at       timestamptz not null default now(),
  closed_at        timestamptz
);

create table briefs (
  brief_id     uuid primary key default gen_uuidv7(),
  campaign_id  uuid not null references campaigns(campaign_id),
  body         jsonb not null,              -- Brief schema (CONTRACTS §3.2)
  learnings_applied uuid[] not null default '{}',
  generated_at timestamptz not null default now()
);

create table content_versions (
  content_version_id uuid primary key default gen_uuidv7(),
  campaign_id   uuid not null references campaigns(campaign_id),
  iteration     int  not null,
  asset_ref     text not null,              -- object-storage key
  submitted_by  text not null,
  submitted_at  timestamptz not null default now(),
  creator_notes text,
  f1x8_job_id   text,
  score_result  jsonb,                      -- frozen ScoreResult (CONTRACTS §1.2)
  unique (campaign_id, iteration)
);

create table approvals (
  approval_id        uuid primary key default gen_uuidv7(),
  campaign_id        uuid not null references campaigns(campaign_id),
  content_version_id uuid not null references content_versions(content_version_id),
  decision    text not null check (decision in ('approved','rejected')),
  approver_id text not null,
  note        text,
  decided_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

create table publish_records (
  publish_record_id  uuid primary key default gen_uuidv7(),
  idempotency_key    text not null unique,   -- campaign+platform+version (ADR D8)
  campaign_id        uuid not null references campaigns(campaign_id),
  content_version_id uuid not null references content_versions(content_version_id),
  approval_id        uuid not null references approvals(approval_id),
  platform         text not null check (platform in ('tiktok','instagram','facebook','x')),
  status           text not null check (status in ('pending','published','failed','skipped_duplicate','unknown')),
  platform_post_id text,
  post_url         text,
  published_at     timestamptz,
  error            jsonb,
  created_at       timestamptz not null default now()
);

create table campaign_metrics (           -- daily monitoring snapshots
  campaign_id  uuid not null references campaigns(campaign_id),
  snapshot_day date not null,
  platform     text not null,
  views bigint, likes bigint, shares bigint, comment_count bigint,
  engagement_rate numeric,
  sentiment jsonb,                        -- CommentAggregate.sentiment
  raw jsonb not null,                     -- full source payloads (forensics)
  primary key (campaign_id, snapshot_day, platform)
);

create table learnings (
  learning_id  uuid primary key default gen_uuidv7(),
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

create table effect_records (             -- node idempotency (ARCHITECTURE §4.2)
  campaign_id uuid not null,
  node        text not null,
  attempt_key text not null,
  result      jsonb,
  created_at  timestamptz not null default now(),
  primary key (campaign_id, node, attempt_key)
);

create table audit_events (               -- append-only; no updates, no deletes
  event_id    uuid primary key default gen_uuidv7(),
  campaign_id uuid,
  actor       text not null,              -- service | creator:<id> | approver:<id> | operator:<id>
  event       text not null,              -- e.g. draft.submitted, publish.confirmed
  detail      jsonb,
  at          timestamptz not null default now()
);

create table creators (
  creator_id  text primary key,
  display_name text not null,
  api_key_hash text not null,             -- scoped MCP key (hashed)
  active      boolean not null default true
);

-- LangGraph PostgresSaver manages its own checkpoint tables (checkpoints,
-- checkpoint_writes, checkpoint_blobs) in schema `langgraph`.
```

RLS: service role for Maistro core; `approver`/`operator` roles get scoped
read + approval-write via the REST API only (no direct table grants to
creators — MCP is their sole surface).

Asset storage: Supabase Storage bucket `campaign-assets`, keys
`{campaign_id}/{iteration}/{filename}`; referenced by `asset_ref`.

---

## 3. LangGraph state object

```python
class CampaignState(BaseModel):
    """Versioned graph state. Additive-only changes, or ship a checkpoint
    migration + chaos-suite replay (CONTRACTS.md §4)."""
    state_version: int = 1

    campaign_id: UUID
    status: CampaignStatus                  # mirrors DB; DB is source of truth
    trend: TrendSnapshot
    brief: Brief | None = None

    iteration: int = 0
    max_iterations: int = 4
    score_threshold: float = 7.0

    current_draft: DraftRef | None = None   # asset_ref + version id
    f1x8_job_id: str | None = None
    score_result: ScoreResult | None = None
    loop_exhausted: bool = False
    final_submitted: bool = False           # creator called submit_final

    approval: ApprovalRef | None = None
    publish_targets: list[Platform] = ["tiktok"]
    publish_results: list[PublishResult] = []

    monitoring_until: date | None = None
    learnings_context: list[str] = []       # confirmed insights injected at brief time

    last_error: ProblemDetail | None = None
    escalation_reason: str | None = None
```

Node read/write declarations (enforced by reducer + lint):

| Node | Reads | Writes |
|---|---|---|
| `pick_trend` | learnings_context | trend, status |
| `generate_brief` | trend, learnings_context | brief, status |
| `await_draft` ⏸ | brief | current_draft, iteration, status |
| `submit_to_f1x8` | current_draft | f1x8_job_id, status |
| `poll_f1x8` | f1x8_job_id | score_result / last_error |
| `evaluate_score` | score_result, iteration, threshold, final_submitted | status, loop_exhausted |
| `request_revision` ⏸ | score_result | current_draft, iteration, status |
| `approval_gate` ⏸ | score_result, loop_exhausted, final_submitted | approval, status |
| `publish` | approval, current_draft, publish_targets | publish_results, status |
| `schedule_monitoring` | publish_results | monitoring_until, status |
| `monitor` | publish_results, monitoring_until | (writes campaign_metrics rows) |
| `write_learnings` | score_result, campaign metrics | status |

Consistency rule: the **database `campaigns.status` is the source of truth**;
the graph state mirrors it. Every status write goes through a single
`transition(campaign_id, event)` function that validates the state machine,
writes the DB row + audit event, then updates graph state — never the
reverse order.
