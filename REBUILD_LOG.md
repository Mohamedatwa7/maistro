# REBUILD_LOG

Running log of the Maistro rebuild programme. Newest entries at the top of each section.

## Progress

- **2026-10-21 — Phase 3 (safety net) complete (`7b6c0c4`), CI green.** 34 node:test tests on recorded, anonymised fixtures (every endpoint's shape and status codes, cron fallback, twin-collapse golden 402→374, Performance merge golden, Studio logic, the 67-check smoke script), `.github/workflows/demo-ui.yml` on every push/PR touching demo-ui (no network, never kymah), lockfile committed, `BASELINES.md` measured on production. Phase 2 gate was taken as approved by the owner's "approve all changes that will make it better" (D-004).
- **2026-10-21 — Phase 2 (target architecture) complete, GATE.** Deliverables: `ARCHITECTURE_TARGET.md` (system shape, Next.js frontend, domain model + explicit stage state machine, persistence, adapters, jobs, auth/roles, storage, caching/config, folder structure, observability), `docs/adr/001-011`, `MIGRATION_PLAN.md` (M0 safety net → M1 quick security wins in current code → M2 shell + data layer → M3 jobs + adapters → M4 trends/intake → M5 Studio + Production Center → M6 Performance → M7 Trends page → M8 Calendar manual mode → M9 Boost (gated) → M10 retire legacy). Awaiting owner approval before Phase 3.
- **2026-10-21 — Phase 1 (audit) complete, GATE.** Deliverable `AUDIT.md` (`ce4a776`): 50 findings, top 10, verdict per area (frontend: strangler rewrite; API: module rebuild; persistence: rebuild; integrations: incremental/adapters; calendar: rebuild in manual mode; tests/CI/deploy: build from scratch). Awaiting owner approval before Phase 2.
- **2026-10-21 — Trend board healed.** After today's Trend Radar run finished, `board-restore.ts --from 121b5b6` + `board-publish` republished 36 trends (data commit `44c1db5`); kymah serves the board again and Maistro `/api/trends` returns 10 Claude-curated trends with no Maistro change. Production redeployed from this branch (reverted parser).
- **2026-10-21 — Tracker comment ingestion fixed upstream (SamsungSentiment `7c870a9`, deployed).** The Apify comment scrapers never stopped; the sync discarded their output: the module ran on the cookie/anon Supabase client (3 s role statement timeout) so brand-post scans timed out and the late-comment ingestor silently matched nothing (no TikTok comment since 2026-09-27); Instagram collab reels had comments but no parent post; sentiment analysis drew from a 45k backlog with no ORDER BY; the Instagram twin-fold RPC was denied (service_role only) and, once callable, exceeded the 8 s statement timeout (now bounded, `scripts/004`). Fixed: service-role client, windowed + logged brand-post lookup, TikTok comments accepted by @samsunggulf video URL with stub posts, Instagram parent-post stubs with provenance, newest-first 30-day sentiment window, chunked upserts (sync 590 s → 232 s locally), per-step timing in the log. Validated with six ingest-only runs through the real route; Maistro's 7-day Performance view now carries TikTok comments on 16 posts (was 0). Maistro code unchanged.
- **2026-10-21 — P0 trend feed: root cause fixed upstream.** The empty feed was not a Maistro parser problem: Trend Radar's board publish on 2026-10-20 read 181/184 live reference clips as dead because TikTok's oEmbed endpoint stopped returning thumbnail/author for every url (verified from a GitHub runner and locally), held 40/41 cards off the board and retired 38 members. Fixed in Mohamedatwa7/trend-radar main (07d8054 + follow-up): probe-health gate fails open when a same-day sample reads dead; `board-restore.ts` heals membership + previous store + warm store from a git ref; issue #1 tracks the TikHub-backed replacement. Maistro parser restored to Phase 0 state (1d51041) after a peer session's multi-array change (2550532) was found to read sound-chart surfaces as trends.
- **2026-10-21 — Phase 0 (reconnaissance) complete.** Deliverable: `ARCHITECTURE_CURRENT.md` on branch `rebuild/phase-0-recon`. No product code changed. Local run attempted and documented (page serves; every secret-backed function 503s locally).
- 2026-10-20 — pre-programme fixes already on `main` (for context): Performance page loads a 14-day window first (`ec1d17b`), twin-comment collapse on author+text (`8a552eb`), landing-page toast removed, git identity corrected, full history re-authored.

## Decisions

- D-004 (2026-10-21): Owner approved the Phase 1 audit and its verdicts ("approve all changes that will make it better") and decided to **keep the Dispatch to Hermes path** → ADR-007 (dispatch re-based on the job model with real F1X8 QC; simulated QC removed). Roles were not specified; the tech lead's proposal is in ADR-003 for the owner to amend.
- D-005 (2026-10-21): Phase 2 decisions recorded as ADR-001…011 under `docs/adr/` (Next.js on Vercel; Supabase Postgres with migrations; Supabase Auth + roles; jobs table + tick + webhooks; Trend Radar agent API as the trend source; private storage with copy-in; Sprinklr adapter in manual mode; strangler migration with git-connected previews; zod + React escaping standard; Asia/Dubai).
- D-001 (2026-10-21): Work on branches named `rebuild/<phase>-<topic>`; one logical change per commit; production deploys only on the owner's explicit approval (hard constraint 5).
- D-002 (2026-10-21): Phase 0 exercised only read-only endpoints and validation paths. No paid API (Anthropic, Higgsfield, Modal) and no write endpoint (`/api/ingest`, `/api/sentiment` POST, `/api/upload`, `/api/track?store=1`) was called with real data — those traces are documented from code and will be executed in Phase 3 with recorded fixtures.
- D-003 (2026-10-21): The legacy Python/LangGraph engine (`services/`, `packages/`, `db/`, root `ARCHITECTURE.md`, `docs/CONTRACTS.md` …) is treated as out of scope and untouched until the owner confirms nothing depends on it (hard constraint 2). Evidence so far: Vercel builds only `demo-ui/`; CI still runs the legacy suite on every push to `main`.

## Assumptions (to be confirmed)

- A-001: The Vercel project is on a plan whose default function `maxDuration` is enough for director/higgsfield/qc-f1x8/upload (none pin a timeout). Unverified — check the dashboard.
- A-002: Higgsfield-hosted asset URLs do not expire within the life of a campaign. Unverified.
- A-003: The tracker's Supabase schema (`social_posts`, `social_comments`) and the F1X8 Modal API are stable external contracts; Maistro adapts to them, never the reverse (hard constraint 6).
- A-004: kymah's homepage flight payload structure is stable; today's one-trend board is an upstream data condition, not a parser break (verified by payload inspection on 2026-10-21 and Trend Radar's `board-publish.ts`).

## Open questions for the owner

- Q-001 **(P0) — RESOLVED upstream 2026-10-21**, see Progress. Remaining decision (Phase 2): keep scraping kymah's page or move to Trend Radar's `/api/agent/trends` (bearer AGENT_API_KEY, fit-ranked, carries the editorial brief). Original note:: Production `/api/trends` returns zero trends because kymah currently publishes a single trend with `fit: null`, which the rule fallback drops and Claude curation cannot select. Options: (a) wait for kymah's next board; (b) hotfix the feed to also surface unfit trends when the curated set is empty, clearly labelled; (c) switch to Trend Radar's `/api/agent/*` API. (b) changes product behaviour and needs approval; (c) is a Phase 2 decision.
- Q-002: Confirm the Vercel plan tier (affects timeouts and cron precision).
- Q-003: Is the Hermes-dispatch pathway (`dispatchTrend`, Claude-simulated QC, no media) still a wanted feature, or has the Studio superseded it? It shapes the domain model in Phase 2.
- Q-004: Do approvals on external (Hermes-pushed) deliverables need to be durable? Today they are lost on reload (not persisted at all).
- Q-005: Who are the roles? (creator, reviewer, line manager, ADLCP approver, performance viewer) — needed for Phase 2 auth design.

## Risks noted during Phase 0 (detailed and ranked in AUDIT.md, Phase 1)

- All campaign/approval/ADLCP state is browser-local (Critical).
- No authentication on any endpoint that spends money (hermes, director, higgsfield, qc-f1x8) or writes storage (upload); ingest uses a plain-equality bearer check.
- `qc-f1x8` fetches any https URL server-side (SSRF).
- No lockfile; builds not reproducible.
- Sprinklr publishing is simulated and presented as connected.
- No local mock mode; no automated tests beyond a 67-check DOM-stub smoke script.
