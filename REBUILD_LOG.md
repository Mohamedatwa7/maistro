# REBUILD_LOG

Running log of the Maistro rebuild programme. Newest entries at the top of each section.

## Progress

- **2026-10-21 — Phase 0 (reconnaissance) complete.** Deliverable: `ARCHITECTURE_CURRENT.md` on branch `rebuild/phase-0-recon`. No product code changed. Local run attempted and documented (page serves; every secret-backed function 503s locally).
- 2026-10-20 — pre-programme fixes already on `main` (for context): Performance page loads a 14-day window first (`ec1d17b`), twin-comment collapse on author+text (`8a552eb`), landing-page toast removed, git identity corrected, full history re-authored.

## Decisions

- D-001 (2026-10-21): Work on branches named `rebuild/<phase>-<topic>`; one logical change per commit; production deploys only on the owner's explicit approval (hard constraint 5).
- D-002 (2026-10-21): Phase 0 exercised only read-only endpoints and validation paths. No paid API (Anthropic, Higgsfield, Modal) and no write endpoint (`/api/ingest`, `/api/sentiment` POST, `/api/upload`, `/api/track?store=1`) was called with real data — those traces are documented from code and will be executed in Phase 3 with recorded fixtures.
- D-003 (2026-10-21): The legacy Python/LangGraph engine (`services/`, `packages/`, `db/`, root `ARCHITECTURE.md`, `docs/CONTRACTS.md` …) is treated as out of scope and untouched until the owner confirms nothing depends on it (hard constraint 2). Evidence so far: Vercel builds only `demo-ui/`; CI still runs the legacy suite on every push to `main`.

## Assumptions (to be confirmed)

- A-001: The Vercel project is on a plan whose default function `maxDuration` is enough for director/higgsfield/qc-f1x8/upload (none pin a timeout). Unverified — check the dashboard.
- A-002: Higgsfield-hosted asset URLs do not expire within the life of a campaign. Unverified.
- A-003: The tracker's Supabase schema (`social_posts`, `social_comments`) and the F1X8 Modal API are stable external contracts; Maistro adapts to them, never the reverse (hard constraint 6).
- A-004: kymah's homepage flight payload structure is stable; today's one-trend board is an upstream data condition, not a parser break (verified by payload inspection on 2026-10-21 and Trend Radar's `board-publish.ts`).

## Open questions for the owner

- Q-001 **(P0, blocks trend intake)**: Production `/api/trends` returns zero trends because kymah currently publishes a single trend with `fit: null`, which the rule fallback drops and Claude curation cannot select. Options: (a) wait for kymah's next board; (b) hotfix the feed to also surface unfit trends when the curated set is empty, clearly labelled; (c) switch to Trend Radar's `/api/agent/*` API. (b) changes product behaviour and needs approval; (c) is a Phase 2 decision.
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
