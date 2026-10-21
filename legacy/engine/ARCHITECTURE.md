# Maistro — Architecture Specification

**Version:** 1.0-draft · **Date:** 2026-09-04 · **Status:** For review
**Timeline:** 5 months (Sept 2026 – Jan 2027, Feb as buffer)

Maistro is a unified content-automation platform that orchestrates the full
lifecycle of a content piece: trend selection → creative brief → human content
creation → pre-publish scoring → revision loop → approval → publishing →
post-publish measurement → learnings that improve the next cycle.

It is built **on top of** four existing production tools, not by merging them.

Companion documents:

| Document | Contents |
|---|---|
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | All service, MCP, data, and publishing contracts |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | Campaign state machine, Postgres schema, LangGraph state |
| [docs/ACCURACY.md](docs/ACCURACY.md) | Accuracy definitions, golden datasets, eval harnesses, targets |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Month-by-month plan with quality gates |

---

## 1. System context

### 1.1 The four upstream tools (existing, production)

| Tool | Pipeline role | Stack | Interface Maistro uses |
|---|---|---|---|
| **Trend Radar** (`D:\Trend Radar`, kymah.com) | Trend detection + brief generation. TikTok-primary, measurement-first (LLMs name what measurement surfaced; they never decide admission). | Next.js on Cloudflare Workers, Supabase/Postgres, Claude, TikHub/Apify/TikTok Business API | `GET /api/agent/trends`, `GET /api/agent/feed/{sounds\|terms}`, `POST /api/agent/brief` |
| **F1X8** (`D:\F1X8`) | Pre-publish engagement scoring of images/video. Returns 0–10 score, funnel-aware KPIs, and a `revision_brief`. | Next.js frontend; Modal GPU FastAPI backend (async job model); Claude vision, Qwen-VL, Whisper | `POST /api/analyze/image`, `POST /api/analyze/video`, `POST /api/video/url`, `GET /api/job/{id}` |
| **SamsungSentiment** (`D:\SamsungSentiment`) | Post-publish audience sentiment across IG/TikTok/FB/X + reviews. | Next.js/Vercel, Supabase, OpenAI gpt-4o-mini, Apify scrapers | `GET /api/comments`, `GET /api/dashboard/data`, `POST /api/apify/trigger` |
| **Lenceus** (`D:\Lenceus`) | Post-publish visibility / share-of-voice on retailer surfaces + social SOV. | Express (Node) + FastAPI (Python), Playwright/Patchright, Claude vision, Supabase, Modal | `GET /api/sites`, `GET /api/log`, `POST /api/run` |

### 1.2 Human actors

- **Content creator** — external collaborator who produces the actual content.
  Interacts with Maistro exclusively through the **MCP server** (from Claude
  Desktop/Code or any MCP client): pulls briefs, submits drafts, receives
  scores and revision feedback.
- **Approver** — reviews and approves content before publishing. The approval
  gate is a **permanent** design decision (brand-adjacent publishing), not a
  temporary safety wheel.
- **Operator** — runs the platform, monitors campaigns via the Maistro
  dashboard, handles escalations.

### 1.3 What Maistro adds that no tool has today

1. Campaign state and orchestration across the whole lifecycle.
2. The creator interface (MCP + REST).
3. **Publishing** — none of the four tools posts content. TikTok Content
   Posting API, Meta Graph API, X API v2. Platform app approvals have
   multi-week lead times → filed in Month 1 (see roadmap).
4. The **learnings loop**: predicted score vs. actual performance, persisted
   per campaign and injected into future brief generation.

---

## 2. Architecture overview

```
                     ┌────────────────────────────────────────────────┐
                     │                 MAISTRO CORE (Python)          │
                     │                                                │
 Content creator ────┼─► MCP Server ──┐                               │
 (Claude Desktop /   │  (scoped keys) │                               │
  any MCP client)    │                ├─► LangGraph Engine            │
                     │  REST API  ────┘   • campaign graph            │
 Approver / ─────────┼─► (FastAPI)        • PostgresSaver checkpoints │
 Operator UI         │                    • interrupt() for humans    │
                     │                                                │
                     │  Adapters (typed, contract-tested)             │
                     └───┬──────────┬───────────┬───────────┬─────────┘
                         │          │           │           │
                   Trend Radar    F1X8    SamsungSent.   Lenceus
                   (HTTP+key)  (HTTP+key)  (HTTP+key)   (HTTP+key)
                         │
                     ┌───┴────────────────────────────────────────────┐
                     │ Maistro Postgres (Supabase, dedicated project)  │
                     │ campaigns · content_versions · learnings ·      │
                     │ publish_records · approvals · langgraph ckpts   │
                     └────────────────────────────────────────────────┘
                                        │
                              Publisher module ──► TikTok / Meta / X
                              (idempotency-keyed, approval-gated)
```

### 2.1 Monorepo layout

```
D:\MAISTRO\
├── ARCHITECTURE.md, docs/          # this spec
├── packages/
│   └── contracts/                  # OpenAPI specs, JSON Schemas, generated types
│       ├── openapi/                #   trend-radar.yaml, f1x8.yaml, sentiment.yaml,
│       │                           #   lenceus.yaml, maistro-api.yaml
│       ├── schemas/                #   campaign.json, brief.json, score-result.json, ...
│       └── generated/              #   pydantic models + TS types (codegen output)
├── services/
│   └── core/                       # FastAPI + MCP server + LangGraph engine
│       ├── adapters/               #   one module per upstream tool
│       ├── graph/                  #   nodes, edges, state, checkpointing
│       ├── mcp/                    #   creator-facing MCP tools
│       ├── publisher/              #   platform posting (TikTok/Meta/X)
│       ├── api/                    #   REST routes (dashboard, approvals, webhooks)
│       └── evals/                  #   eval harnesses (see ACCURACY.md)
├── apps/
│   └── dashboard/                  # Next.js operator/approver UI (Month 5)
├── db/                             # SQL migrations (numbered, forward-only)
├── datasets/                       # golden datasets for evals (versioned)
└── .github/workflows/              # CI: typecheck, tests, contract tests, evals
```

---

## 3. Key decisions (ADR summary)

| # | Decision | Rationale | Rejected alternative |
|---|---|---|---|
| D1 | **Orchestration layer, not a merge.** The four tools stay independent services; Maistro talks to them over HTTP. | All four are production-deployed and actively evolving; merging trades proven code for unproven code and couples four release cycles. | Monolith rebuild — slower, riskier, no accuracy benefit. |
| D2 | **LangGraph (Python) as the workflow engine**, with `PostgresSaver` checkpointing. | Native `interrupt()` for the human-in-the-loop pauses (days-long waits for creator/approver); cyclic graphs model the revise loop; Postgres checkpointing gives durable resume + audit trail. | LangChain alone (component lib, not an engine); Temporal (more robust, far heavier ops for a small team). |
| D3 | **Python 3.12 + FastAPI for Maistro core**; MCP server mounted in the same process (official MCP Python SDK). | LangGraph is most mature in Python; FastAPI serves REST + MCP together; the analytical halves of F1X8/Lenceus are already Python. | LangGraph.js — viable, but weaker checkpointer/ecosystem parity. |
| D4 | **API-only integration; never read another tool's database directly.** | DB schemas are those tools' private internals; direct reads create invisible coupling that contract tests can't protect. | Shared-DB integration — faster today, unmaintainable by Month 3. |
| D5 | **Dedicated Supabase Postgres project for Maistro.** | Clean blast radius, own migration history, RLS scoped to Maistro; existing tools keep their own projects. | Piggybacking on SamsungSentiment's Supabase — entangles lifecycles. |
| D6 | **Contract-first at every boundary** (see CONTRACTS.md). Typed clients are *generated* from specs; contract tests run in CI against staging. | Maistro is glue between five moving parties; seams are where it fails. Breakage must surface in CI, not in a broken campaign. | Ad-hoc HTTP calls — faster for 2 weeks, then permanent drift risk. |
| D7 | **Permanent human approval gate before publish.** | Brand-adjacent publishing; "who approved this and when" must be answerable forever. | Full auto-publish — not acceptable for this brand context. |
| D8 | **Idempotency keys on every publish**, stored in `publish_records` before the platform call. | A resumed checkpoint must never double-post. Structural guarantee, not a convention. | Best-effort dedup — fails exactly when checkpoint resume happens. |
| D9 | **Maistro reads Trend Radar's warm stores / agent endpoints; it never triggers fresh collection.** | Trend Radar has real per-day API spend with hard caps ($7/day TikHub, $40/day Anthropic); collection cadence is its own concern. | On-demand collection — burns budget, breaks TR's spend governance. |
| D10 | **Every LLM touchpoint is eval-gated** (see ACCURACY.md). Prompts in version control; golden-dataset regression runs in CI. | "Highest accuracy" is only real if measured; prevents silent prompt/model regressions. | Vibes-based prompt iteration. |
| D11 | **LangSmith for graph tracing** + structured JSON logging + Sentry. Revisit Langfuse (self-hosted) at Month 3 if data-residency becomes a requirement. | Deepest LangGraph integration, zero ops burden; small team. | Langfuse self-host from day 1 — ops cost before there's traffic. |
| D12 | **Secrets in one place**: local `.env` per developer, GitHub Environments for CI, and the deploy platform's secret store for prod. A `SECRETS.md` inventory (names only, never values) is kept current. | ~25 keys today scattered across Vercel/GitHub/Modal/Cloudflare; drift is an outage class. | Per-tool scatter (status quo). |

---

## 4. Component design

### 4.1 Adapters (`services/core/adapters/`)

One module per upstream tool. Each adapter:

- Is generated-typed from the tool's OpenAPI spec in `packages/contracts/`.
- Validates every response against the schema **at the boundary** — malformed
  data is rejected before it can enter a checkpoint (bad data persisted in a
  checkpoint resurfaces days later, far from its cause).
- Implements retry with exponential backoff + jitter (idempotent GETs only),
  circuit-breaking, and per-tool timeouts.
- Authenticates with a per-service API key (see §6).
- Emits structured logs: tool, endpoint, latency, outcome, campaign id.

Tool-specific notes:

- **F1X8** — image analysis is **synchronous** (`POST /api/analyze/image`
  blocks ~10–30s); video is async (`POST /api/analyze/video/submit` or
  `/api/analyze/video-url/submit` → poll `GET /api/job/{id}`, statuses
  `fetching|analyzing|done|error|not_found`). The adapter exposes both
  shapes; the *graph* owns video polling via a timer-driven node, so a long
  GPU job never blocks a worker or breaks resume.
- **Trend Radar** — read-only consumption of `/api/agent/*` (D9). Auth is
  TR's agent key (`Authorization: Bearer` / `x-agent-key`). Brief authoring
  is rate-limited by TR (4/min, 30/hr per key) — the adapter enforces a
  client-side budget below that. TR also exposes a full MCP server at
  `POST /api/mcp` (tools: `list_trends`, `get_trend`, `author_brief`,
  `list_sounds`, `list_keywords`) — Maistro uses REST, but the MCP surface
  is available to the creator directly if useful.
- **SamsungSentiment / Lenceus** — read-side polling for the monitoring stage;
  `POST /api/apify/trigger` may be used to request an early comment sync on a
  just-published post (bounded: max 1 trigger per campaign per day).

### 4.2 LangGraph engine (`services/core/graph/`)

The campaign graph (state schema and node contracts in DATA-MODEL.md):

```
pick_trend ──► generate_brief ──► await_draft ⏸ ──► submit_to_f1x8
                                                          │
                                        ┌─────────────────┘
                                        ▼
                                   poll_f1x8 ◄──┐ (timer, until job done
                                        │       │  or timeout 30 min)
                                        ▼       │
                                  evaluate_score┘
                                   │         │
                     score < threshold      score ≥ threshold
                     & iter < max_iter               │
                                   ▼                 ▼
                          request_revision ⏸   approval_gate ⏸
                                   │             │        │
                                   └─► submit_to_f1x8   rejected ─► request_revision
                                              approved
                                                 ▼
                                             publish ──► schedule_monitoring
                                                              │
                                                              ▼
                                                    monitor ◄──┐ (daily, for
                                                        │      │  N=14 days)
                                                        ▼      │
                                                 write_learnings┘──► close
```

⏸ = `interrupt()` — durable pause, state checkpointed to Postgres, resumed by
an MCP tool call (creator) or REST call (approver).

Rules:

- **Every node is idempotent.** Nodes that cause external effects (publish,
  F1X8 submit, Apify trigger) check for an existing effect record keyed by
  `(campaign_id, node, attempt_key)` before acting.
- **Revision loop bound:** `max_iterations = 4` (configurable per campaign).
  Exhaustion routes to `approval_gate` with a `loop_exhausted` flag — a human
  decides, the graph never spins.
- **Interrupt hygiene** (chaos-tested in CI, see §7): double-submit to the
  same interrupt is rejected with a clear error; submit to an
  expired/cancelled campaign is rejected; process kill mid-node resumes
  cleanly from the last checkpoint.
- **State schema is versioned** (`state_version` field). Checkpoints persist
  for days; any state-shape change ships with a migration for in-flight
  campaigns or is additive-only.

### 4.3 MCP server (`services/core/mcp/`)

The creator's entire interface. Tools (full I/O schemas in CONTRACTS.md §2):

`list_assigned_briefs`, `get_brief`, `submit_draft`, `get_feedback`,
`submit_final`, `get_campaign_status`.

- Auth: per-creator scoped API key; a creator sees only campaigns assigned to
  them.
- `submit_draft` resumes the paused graph run, triggers F1X8 scoring, and
  (because scoring is async) returns immediately with `status: "scoring"`;
  the creator calls `get_feedback` to retrieve the score + `revision_brief`.
- Every tool call is audit-logged (who, what, when, campaign).

### 4.4 Publisher (`services/core/publisher/`)

- Normalized `PublishRequest` / `PublishResult` contract (CONTRACTS.md §5)
  over per-platform drivers: TikTok Content Posting API, Meta Graph API
  (IG/FB), X API v2.
- Hard precondition: a `publish` node runs only with a recorded, unrevoked
  approval (`approvals` row referencing the exact `content_version_id`).
  Approving version 3 does not authorize publishing version 4.
- Idempotency: `publish_records` row (key = `campaign_id + platform +
  content_version_id`) is written **before** the platform call; the call is
  skipped if a completed record exists (D8).
- OAuth token storage: encrypted at rest in Maistro Postgres; refresh handled
  by the publisher module. Trend Radar's existing TikTok Business OAuth flow
  is the reference implementation.

### 4.5 REST API + dashboard (`services/core/api/`, `apps/dashboard/`)

- REST API serves: approval queue (approve/reject with note), campaign list +
  detail (full timeline: trend → brief → versions → scores → publish →
  metrics), accuracy metrics, manual controls (cancel campaign, force-close,
  re-run monitoring).
- Dashboard is a Next.js app (Month 5). Until then the REST API +
  existing tool dashboards are the operator surface. Existing dashboards are
  linked, not rebuilt.

### 4.6 Monitoring & learnings

- `schedule_monitoring` registers the published post (platform post id, URL)
  with the monitoring poller.
- Daily for 14 days: pull sentiment breakdown (SamsungSentiment) and
  engagement metrics (platform APIs) for the post; snapshot into
  `campaign_metrics`.
- `write_learnings` computes predicted-vs-actual (F1X8 score vs. realized
  engagement percentile), stores a `learnings` row, and the top-K recent
  learnings are injected into the next `generate_brief` call. This loop is
  the accuracy engine of the platform — see ACCURACY.md.

---

## 5. Environments

| Env | Purpose | Data |
|---|---|---|
| **local** | Development. Adapters point at staging tools or recorded fixtures (VCR-style cassettes committed for offline dev). | Synthetic only |
| **staging** | CI contract tests, integration tests, chaos tests. Own Supabase project. Publishing drivers run in **dry-run mode** (full flow, no real post). | Synthetic + copied-down anonymized samples |
| **prod** | Live campaigns. | Real |

Never develop against prod data. Staging exists from Week 2 (roadmap gate).

---

## 6. Security & auth

- **Service-to-service:** every adapter call carries a per-service API key
  (`Authorization: Bearer`), issued and rotated by Maistro's operator. Trend
  Radar already enforces this on `/api/agent/*` (AGENT_API_KEY). **Verified
  gap (2026-09-04):** SamsungSentiment's API routes and Lenceus's Express API
  currently have **no auth at all** — adding minimal key-check middleware to
  the consumed endpoints is a named M1-W3 deliverable, not optional.
- **Creator (MCP):** per-creator scoped keys; least privilege (assigned
  campaigns only); revocable.
- **Approver/operator (REST + dashboard):** Supabase Auth with role claims
  (`approver`, `operator`). Approvals record the authenticated identity.
- **Audit log:** append-only `audit_events` table — every state transition,
  every human action, every publish. Retained indefinitely (D7 rationale).
- **Secrets:** per D12. No secret ever committed; CI secret-scan enforced.
- **Platform tokens:** encrypted at rest (pgsodium), scoped to the minimum
  posting permissions each platform allows.

---

## 7. Engineering standards

- **CI on every PR:** typecheck (mypy strict + tsc), unit tests, schema
  validation of `packages/contracts`, secret scan, prompt-regression evals
  (changed prompts only). **Nightly:** full contract tests against staging
  tools, full eval suite, chaos suite.
- **Testing pyramid:**
  - Unit — node logic, adapters (against recorded fixtures), publisher
    drivers (against platform sandbox/mocks).
  - Contract — live staging endpoints validated against OpenAPI specs.
  - Integration — full graph runs on staging with dry-run publishing.
  - Chaos — kill process mid-node and assert clean resume; double-submit,
    stale-submit, and expired-interrupt scenarios; F1X8 timeout path;
    checkpoint-migration replay of an in-flight campaign.
- **Observability:** LangSmith tracing on every graph run (node, prompt
  version, inputs/outputs); structured JSON logs with `campaign_id`
  correlation everywhere; Sentry for exceptions; a `campaign_health` view
  flags stuck campaigns (e.g., `scoring` > 1h, `awaiting_draft` > deadline).
- **Migrations:** numbered, forward-only, applied by CI (staging) and by
  operator command (prod). LangGraph checkpoint-schema changes require a
  documented migration note (§4.2).
- **Docs:** ADRs for every decision of D-table weight; runbooks (Month 5) for
  every operational scenario; `SECRETS.md` inventory.
- **Definition of done** for any feature: typed, tested at the right pyramid
  level, traced, documented, and behind a quality gate in ROADMAP.md.

---

## 8. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Platform API app approvals slip (TikTok/Meta/X review) | High | File applications in **Month 1**; dry-run publishing keeps everything else unblocked; manual-posting fallback path exists through Month 4. |
| Upstream tool changes break integration | High (they're active) | D6 contract tests (nightly) + boundary validation; each tool's owner notified via failing-contract report. |
| Sentiment accuracy on Gulf Arabic insufficient (gpt-4o-mini) | Medium | Golden dataset + eval in Month 3 measures it; model upgrade path is isolated inside SamsungSentiment's analyze route. |
| F1X8 score doesn't correlate with actual engagement | Medium | This is measured, not assumed (ACCURACY.md); shadow-mode campaigns in Month 3 produce the data before we rely on the threshold. |
| Trend Radar spend caps block reads at wrong moment | Low | D9 (reads only, warm stores); stale-read fallback already exists in TR. |
| Checkpoint/state-schema drift breaks in-flight campaigns | Medium | Versioned state, additive-first changes, chaos-suite replay test. |
| Gold-plating infra while accuracy work (labeling, calibration) slips | Medium | Accuracy deliverables are named roadmap gates with equal weight to infra gates. |

---

*Next artifact after this spec is approved: `packages/contracts/` — the
OpenAPI specs and JSON Schemas in CONTRACTS.md turned into actual spec files
with codegen wired into CI (Roadmap M1-W2).*
