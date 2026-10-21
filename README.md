# MAISTRO

Content-automation platform for Samsung Gulf's social media: a trend from kymah.com (Trend Radar) becomes a content piece, goes through stage-by-stage approvals, is posted, and its performance is tracked — all in one place. Live at **https://www.ma1stro.com**.

The product today is `demo-ui/`: a single-file app (`index.html`) plus Vercel serverless functions (`api/`). It is being rebuilt in the open on the `rebuild/*` branches; read these first:

| Document | What it is |
|---|---|
| [ARCHITECTURE_CURRENT.md](ARCHITECTURE_CURRENT.md) | How the live product actually works (Phase 0 reconnaissance): every endpoint, where state lives, workflows, diagrams |
| [AUDIT.md](AUDIT.md) | Findings with severity, evidence and fixes; ranked top 10; verdict per area (Phase 1) |
| [ARCHITECTURE_TARGET.md](ARCHITECTURE_TARGET.md) · [docs/adr/](docs/adr/) · [MIGRATION_PLAN.md](MIGRATION_PLAN.md) | Where it is going and in which order (Phase 2) |
| [BASELINES.md](BASELINES.md) | Measured latencies, payloads, durations and call counts the rebuild is judged against (Phase 3) |
| [REBUILD_LOG.md](REBUILD_LOG.md) | Running log: decisions, assumptions, open questions, progress |
| [demo-ui/API.md](demo-ui/API.md) | Public contracts for the external Hermes agent (`/api/trends`, `/api/ingest`) |

## Run it

```
cd demo-ui
npm ci
npm test          # 99 tests on recorded fixtures and an in-memory PostgREST — no network, no paid APIs
npm run check     # syntax check of every function
vercel dev        # local server; functions need the environment variables below
```

Deploy (until the project is git-connected, see MIGRATION_PLAN M1): from a clean checkout of the commit you mean to ship, `cd demo-ui && vercel deploy` for a preview, `vercel deploy --prod` to promote.

## Environment variables (names; values live in Vercel)

`ANTHROPIC_API_KEY` · `HF_CREDENTIALS` (`key-id:key-secret`) · `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` · `NEXT_PUBLIC_SUPABASE_ANON_KEY` · `MAISTRO_DATABASE_URL` (migrations only) · `TRACK_SUPABASE_URL` · `TRACK_SUPABASE_KEY` · `MAISTRO_INGEST_KEY` · `TRENDRADAR_AGENT_KEY` · `TRENDRADAR_BASE_URL` (default) · `MAISTRO_F1X8_BASE_URL` (optional) · `QC_ASSET_HOSTS` (optional) · `CRON_SECRET` · `MAISTRO_SESSION_SECRET` · `MAISTRO_APP_PASSWORD` (interim) · `MAISTRO_ADMIN_EMAILS` · `MAISTRO_REQUIRE_MEMBER` (optional). The full table is in `ARCHITECTURE_CURRENT.md` §1.3.

## What is where

- `demo-ui/api/` — one Vercel function (`[route].js`) dispatching 17 routes to `_handlers/` (trends, hermes, director, higgsfield, qc-f1x8, ingest, projects, sentiment, track, upload, translate, login, health, pieces, decisions, members, jobs); the campaign store (`_store.js`), job service (`_jobs.js`), sessions and members (`_auth.js`, `_members.js`), adapters (`_adapters/`), schemas and helpers. Contracts in `demo-ui/API.md`; the domain state machine in `demo-ui/src/domain/stages.js`; migrations in `demo-ui/db/`.
- `demo-ui/tests/` — characterization, golden and contract tests with their recorded fixtures; CI in `.github/workflows/demo-ui.yml`.
- `legacy/engine/` — the September 2026 Python/LangGraph design and scaffold. Not used by the product, kept for reference only (owner decision 2026-10-21).
- Upstream tools (separate repositories, read-only from here): Trend Radar (`Mohamedatwa7/trend-radar`, kymah.com), the Consumer Sentiment Tracker (`Mohamedatwa7/SamsungSentiment`), F1X8 (Modal).
