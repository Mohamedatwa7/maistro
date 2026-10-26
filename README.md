# MAISTRO

Content-automation platform for Samsung Gulf's social media: a trend from kymah.com (Trend Radar) becomes a content piece, goes through stage-by-stage approvals, is posted, and its performance is tracked — all in one place. Live at **https://www.ma1stro.com**.

The product today is `demo-ui/`: a single-file app (`index.html`) plus Vercel serverless functions (`api/`). It was rebuilt in 13 phases on `rebuild/phase-0-recon` (see FINAL_REVIEW.md); read these first:

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
npm run local     # http://localhost:3000, password "local": the product on seeded fakes, no keys, no network
npm test          # the whole suite (237 tests) on recorded fixtures and an in-memory PostgREST — no network, no paid APIs
npm run evals     # the accuracy suite (EVALS.md); rendering evals are disabled (owner: no Higgsfield spend for testing)
npm run lint && npm run typecheck && npm run check
vercel env pull .env.local && vercel dev   # against the real services; needs access to the Vercel project
```

`npm run local` (`demo-ui/scripts/local.js`) runs the page and all 20 API routes against in-memory doubles:
- the Maistro database is the tests' fake PostgREST (empty at start, lost on exit);
- the tracker serves the recorded 14-day fixture, its dates shifted to end yesterday;
- Trend Radar serves the recorded agent feed.

Anthropic, Higgsfield, F1X8, storage, Sprinklr and member sign-in are **not** faked: their calls answer 503 naming
the host. `MAISTRO_NO_RENDER=1` is forced, and keys in your shell are dropped, so nothing paid or real can run from
it.

## Deploy and operate

- **Release:** only `bash demo-ui/scripts/release.sh <commit-message-file> <paths…>`, from the repo root. It runs the
  suite, commits, pushes the branch and waits for CI to be green on that exact SHA. It then fast-forwards `main`,
  deploys, and checks that both hosts serve that revision and the same page. Never `vercel deploy` by hand or push
  `main` directly.
- **Rollback:** `bash demo-ui/scripts/rollback.sh <deployment-url>` (code only; migrations stay applied).
- **Migrations:** `node demo-ui/db/migrate.mjs` with `MAISTRO_DATABASE_URL`, applied **before** the release that needs
  them.
- **Incidents, crons, monitoring, backups, secret rotation and environments:** [RUNBOOK.md](RUNBOOK.md).
- **Security model:** [SECURITY.md](SECURITY.md).
- **Where it stands:** [FINAL_REVIEW.md](FINAL_REVIEW.md).

## Environment variables (names; values live in Vercel, never in the repo)

`GET /api/health` reports which of the required ones are set. It shows names only, never values.

| Variable | Required | Default | What it is |
|---|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | yes | — | The Maistro database and storage (server-side only) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | — | Member sign-in (Supabase Auth e-mail link) |
| `MAISTRO_DATABASE_URL` | migrations and backups | — | Direct Postgres URL for `db/migrate.mjs` and the backup workflow |
| `MAISTRO_SESSION_SECRET` | yes | — | HMAC key for the session cookie |
| `MAISTRO_APP_PASSWORD` | interim | — | The shared password. It cannot do member-only actions |
| `MAISTRO_ADMIN_EMAILS` | first sign-in | — | Bootstrap admins (comma-separated) |
| `MAISTRO_REQUIRE_MEMBER` | no | off | `1` closes password-session claims once everyone has a member sign-in |
| `CRON_SECRET` | yes | — | How cron calls are recognised (Vercel sets it) |
| `ANTHROPIC_API_KEY` | yes | — | Trend judge, Studio writing and vision checks |
| `MAISTRO_TREND_JUDGE_MODEL`, `MAISTRO_STUDIO_MODEL`, `MAISTRO_VISION_MODEL` | no | `claude-sonnet-5-5`, `claude-opus-5-5`, `claude-sonnet-5-5` | Model per job |
| `HF_CREDENTIALS` | yes | — | Higgsfield, `key-id:key-secret` |
| `MAISTRO_NO_RENDER` | no | off | `1` makes the Higgsfield adapter refuse every submit (403 `renders_disabled`) |
| `MAISTRO_PIECE_BUDGET_USD`, `MAISTRO_PIECE_BUDGET_USD_720P`, `…_1080P` | no | $20 at 720p, $50 at 1080p | Per-piece render cap; the 80 % warning is fixed |
| `MAISTRO_DAILY_SPEND_USD` | no | 100 | Account-wide render ceiling per Gulf day |
| `MAISTRO_UNPRICED_VIDEO_USD_PER_S`, `MAISTRO_UNPRICED_IMAGE_USD` | no | 0.5, 0.05 | Conservative price when `/estimate` gives none |
| `MAISTRO_F1X8_BASE_URL` | no | the Modal deployment | F1X8 QC |
| `QC_ASSET_HOSTS` | no | — | Extra media hosts the F1X8 proxy may fetch (comma-separated) |
| `TRENDRADAR_BASE_URL`, `TRENDRADAR_AGENT_KEY` | key yes | trend-radar-iota-one.vercel.app | Trend Radar agent API (bearer) |
| `MAISTRO_TREND_SCORING` | no | on | `0` stops scoring on the hourly cron |
| `MAISTRO_JUDGE_CONCURRENCY`, `MAISTRO_JUDGE_BUDGET_S`, `MAISTRO_FUNCTION_MAX_S` | no | 4, 180, 300 | Trend-scoring pacing within the function limit |
| `TRACK_SUPABASE_URL`, `TRACK_SUPABASE_KEY` | yes | — | The Consumer Sentiment Tracker (read-only) |
| `MAISTRO_OWNED_ACCOUNTS` | no | `samsunggulf` on each platform | Which accounts count as ours (reconciliation R-8) |
| `MAISTRO_BRAND_AUTHORS` | no | `samsunggulf,samsung` | Brand replies left out of comment themes |
| `MAISTRO_INGEST_KEY` | yes | — | Bearer for `/api/ingest` (Hermes) and the tracker's pushes |
| `MAISTRO_IP_SALT` | no | the session secret | Salt for hashed addresses in the login throttle |
| `MAISTRO_ALERT_WEBHOOK` | no | — | Slack-compatible webhook for monitor alerts |
| `MAISTRO_PREVIEW_DB` | no | — | `1` in the Preview scope once Preview has its own database |
| `SPRINKLR_API_KEY`, `SPRINKLR_ACCESS_TOKEN`, `SPRINKLR_ENV` | no | — | Sprinklr v3 credentials (`Key` header, Bearer token, environment such as `prod2`). Until all three are set, publishing is manual/export and shown as "not connected" |
| `SPRINKLR_DRAFTS`, `SPRINKLR_CAMPAIGN_ID`, `SPRINKLR_ACCOUNT_GROUPS` | no | — | Drafts mode (ADR-008): `1`, the campaign the drafts are filed under, and `platform:account=accountGroupId,…`. An export then also creates the Sprinklr draft; Maistro never schedules or posts |
| `MAISTRO_FFMPEG` | no | bundled `ffmpeg-static` | ffmpeg path override for assembly |
| `MAISTRO_REVISION` | set by `release.sh` | — | The released SHA, which `/api/health` reports |

## What is where

- `demo-ui/api/` — one Vercel function (`[route].js`) dispatching 20 routes to `_handlers/`:

  | Area | Routes |
  |---|---|
  | Trends | trends |
  | Hermes | hermes, director, ingest, projects |
  | Generation and QC | higgsfield, qc-f1x8, upload |
  | Performance | sentiment, track, translate |
  | Sign-in | login, members |
  | Pieces | pieces, decisions |
  | Jobs, knowledge base, Studio | jobs, kb, studio |
  | Operations | health, monitor |

  Alongside the handlers:
  - the campaign store (`_store.js`) and the job service (`_jobs.js`);
  - sessions and members (`_auth.js`, `_members.js`) and the login throttle (`_throttle.js`);
  - adapters (`_adapters/`);
  - trends (`_trends/`), the Studio stages (`_studio/`), performance analytics (`_perf/`) and the monitor (`_ops/`).

  Contracts are in `demo-ui/API.md`; the stage machine is in `demo-ui/src/domain/stages.js`; migrations are in
  `demo-ui/db/migrations/`.
- `demo-ui/tests/` — characterization, golden, contract, accuracy and page tests with their recorded fixtures. CI is
  `.github/workflows/demo-ui.yml` (tests, lint, `npm audit`, typecheck, evals, build, gitleaks).
- `legacy/engine/` — the September 2026 Python/LangGraph design and scaffold. Not used by the product, kept for reference only (owner decision 2026-10-21).
- Upstream tools (separate repositories, read-only from here): Trend Radar (`Mohamedatwa7/trend-radar`, kymah.com), the Consumer Sentiment Tracker (`Mohamedatwa7/SamsungSentiment`), F1X8 (Modal).
