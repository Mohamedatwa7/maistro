# FINAL_REVIEW — Phase 13: the Phase 1 audit re-run on the rebuilt system

Status 2026-10-22, production revision `aab4439` (www.ma1stro.com, maistro-demo.vercel.app).
- **Sources:** AUDIT.md (Phase 1: 57 findings in 7 dimensions), REBUILD_LOG.md, the code at `aab4439`, the test suite
  (`npm test`, 236 tests) and `npm run evals`.
- **Checker:** the checker session (maistro-86) verified every release listed in PROGRESS.md.
- **Statuses:**
  - **fixed**;
  - **partly** — what remains is stated;
  - **open** — with the reason;
  - **owner** — needs an owner action;
  - **won't fix**.
- **Evidence:** the commit that made the change, then the test file or the probe that shows it.

## 1. Scorecard per audit dimension

| Dimension | Findings | Fixed | Partly | Open | Owner | Won't fix / no defect |
|---|---|---|---|---|---|---|
| A — Data model and persistence | 9 | 6 | 2 (A-06, A-07) | 1 (A-08) | — | — |
| B — Workflow and approvals | 5 | 2 | 1 (B-02) | 2 (B-04, B-05) | — | — |
| C — Integrations | 23 | 15 | 5 (C-10, C-12, C-16, C-21, C-23) | 1 (C-13) | — | 2 (C-09 won't fix; C-02 a proof that holds) |
| D — Security | 7 | 5 | 1 (D-04) | — | 1 (D-05) | — |
| E — Reliability | 4 | 2 | 2 (E-02, E-03) | — | — | — |
| F — Performance | 3 | — | 1 (F-02) | 1 (F-01) | — | 1 (F-03 no defect) |
| G — Engineering | 6 | 3 | 2 (G-01, G-05) | 1 (G-04) | — | — |
| **Total** | **57** | **33** | **14** | **6** | **1** | **3** |

By severity:
- **Critical (6):** all fixed (A-01, A-02, A-05, C-14, D-01, D-03).
- **High (21):** 15 fixed. Six are partly fixed: A-06, B-02, C-23, D-04, E-02, G-01. None of the six is open.

## 2. Every original finding

| # | Sev | Status | Commit | Evidence |
|---|---|---|---|---|
| A-01 | Critical | **fixed** | bfe1942, e51807e | Pieces, stages, versions and approvals live in Supabase and the page writes through. Tests: `tests/api/pieces-decisions.test.js`, `tests/page/sync.test.js` |
| A-02 | Critical | **fixed** | 6ff8ac1 | The document **bytes** go to the private `approvals` bucket with a sha256, bound to the version; a final approval without both is refused. Tests: `pieces-decisions.test.js`; checker-verified (eebe7c2) |
| A-03 | High | **fixed** | e51807e | Decisions are store-backed for external (Hermes) pieces too. Test: `pieces-decisions.test.js` |
| A-04 | High | **fixed** | bfe1942, 03d1263 | `artifact_versions` keeps every version with its inputs; an approved stage is immutable until an admin reopens it. Tests: `tests/domain/invalidation.test.js`, `tests/studio/lineage.test.js` |
| A-05 | Critical | **fixed** | 8e6b26e, bfe1942 | A server-side stage machine (order, prerequisites, roles, no self-approval, documents). Tests: `tests/domain/stages.test.ts`, `pieces-decisions.test.js` |
| A-06 | High | partly | 09459b8 | Ingest is idempotent. Still open: `/api/projects` aggregates the newest 1,000 events. Its future depends on owner question Q-003 (the Hermes path) |
| A-07 | Medium | partly | 465b390, db929fe | The 60-day data is served from the stored cron copy, and reads are paged (`queryAll`). Still open: the snapshot table stays append-only by design |
| A-08 | Medium | open | — | Reference photos stay in the public `refs` bucket because Higgsfield needs a fetchable URL; upload needs a session. Roadmap: short-lived signed URLs |
| A-09 | Medium | **fixed** | 555e440 | Generated media is copied into private storage with a sha256 and served through signed URLs. Test: `tests/api/jobs.test.js` |
| B-01 | High | **fixed** | f91ca52 | Reasons and reason codes are stored on the approval and drive the regeneration. Test: `tests/api/records.test.js` |
| B-02 | High | partly | 6ff8ac1, 77779a4 | The Studio uses real F1X8 QC (`tests/studio/qc.test.js`). Still open: Hermes-dispatch QC is still simulated, labelled `simulated: true`, with no invented reviewer. Depends on Q-003 |
| B-03 | High | **fixed** | f3fa45f | Final verification re-runs F1X8 on the stored cut and answers every original risk. Test: `tests/studio/final.test.js` |
| B-04 | Medium | open | — | The external 6-stage path is still remapped onto the 7-stage UI (depends on Q-003) |
| B-05 | Medium | open | — | Drafts made while planning are still not persisted (`index.html` filters `!p.planning`). The loss is one planning call. Accepted until the page is strangled |
| C-01 | High | **fixed** | 11fd89e, e012f0c | Trends come from the Trend Radar agent API, with the page scrape as a fallback; empty or stale is shown. Tests: `tests/api/trends.test.js`, `tests/trends/engine.test.js` |
| C-02 | Medium | holds | — | A proof, not a defect. Nothing triggers kymah's collection (an owner rule); there is only a GET of the board/agent API |
| C-03 | Medium | **fixed** | cfdbbb2, 880cde4 | Scored on the hourly cron, with stored scores served: cold read 28.6 s → 1.8 s (BASELINES.md) |
| C-04 | High | **fixed** | f91ca52, e0afa14 | `prompt_registry` versions the prompts; the judge v1.4 is frozen behind a 10-case eval; every call is in `generation_records`. Tests: `tests/trends/calibration.test.js`, `records.test.js` |
| C-05 | Medium | **fixed** | 5d3d598, 4656167 | Outputs are schema-validated; malformed ones are counted and never silently replaced. Test: `tests/api/schemas.test.js` |
| C-06 | Medium | **fixed** | 37e9963, 61d381e | Every render is priced before submission, under a per-piece cap and the daily ceiling. Tests: `tests/api/budget.test.js`, `tests/api/no-paid-renders.test.js` |
| C-07 | High | **fixed** | a4be00c | Durable server-side jobs on the per-minute cron. Test: `jobs.test.js` |
| C-08 | Medium | **fixed** | a5bc00d, 0b1a2e2 | Retryable vs permanent classification, an idempotency key, backoff, and one nsfw rewrite retry. Tests: `jobs.test.js`, `tests/api/generation.test.js` |
| C-09 | Medium | won't fix | a5bc00d | The two paths are the provider's API shape; both sit behind one adapter (`api/_adapters/higgsfield.js`) |
| C-10 | Low | partly | — | The prepended fidelity instruction no longer exists (no match in `api/`). The public reference URL is A-08 |
| C-11 | High | **fixed** | 09459b8 | An identical re-push is acknowledged (`duplicate: true`). Test: `tests/api/ingest-projects.test.js` |
| C-12 | Medium | partly | bbcb70e | The bearer compare is timing-safe. Still open: no per-key rate limit on ingest; the body is capped only by the platform (4.5 MB) |
| C-13 | Medium | open | — | The Hermes path remains a second product path (depends on Q-003) |
| C-14 | Critical | **fixed** | c5686df, 555e440 | The F1X8 proxy takes stored assets or the media-host allow-list only, behind a session. Test: `tests/api/generation.test.js` (SSRF guard cases) |
| C-15 | High | **fixed** | 77779a4 | Results and heatmaps are in `qc_results`. Test: `qc.test.js` |
| C-16 | Medium | partly | f4fed8a | The asset is still buffered, but capped at 50 MB with a timeout |
| C-17 | High | **fixed** | c0f4b17 | One business timezone (ADR-011). Test: `tests/page/tz-rtl.test.js` |
| C-18 | High | **fixed** | e012f0c | "Data as of" and STALE pills, "no recent data" and coverage warnings. Tests: `tests/page/states.test.js`, `tests/page/performance.test.js` |
| C-19 | Medium | **fixed** | 35604bd | The message-key twin collapse has 0 false merges and 0 misses on the labelled sample (was 23 of 36 missed). Test: `track-sentiment.test.js` (twin-audit fixture) |
| C-20 | Medium | **fixed** | 7a26881, 0b1a2e2 | The 14→60-day merge never replaces; reconciliation R-1…R-8 at zero tolerance, all true in the newest row |
| C-21 | Medium | partly | c0f4b17 | `dir="auto"` is used (`tz-rtl.test.js`). Still open: translation uses the unofficial gtx endpoint |
| C-22 | Low | **fixed** | 465b390, 6ae67f8 | The stored 60-day and 90-day copies replace cold reads |
| C-23 | High | partly | dad31d0, 6ff8ac1 | Upload needs a session, approval documents are type-allow-listed, and the composite checks PNG magic bytes. Still open: a reference image's declared type is coerced, not sniffed |
| D-01 | Critical | **fixed** | dad31d0, 9851f76, acca74f | A session gate everywhere and members with roles; privileged actions are member-only. Tests: `tests/api/auth.test.js`, `members-auth.test.js`, `security.test.js` |
| D-02 | High | **fixed** | f1af2b6 | Every interpolation is escaped. Tests: `tests/page/studio.test.js` (hostile title), `tests/page/sync.test.js` |
| D-03 | Critical | **fixed** | c5686df | As C-14 |
| D-04 | High | partly | db929fe | RLS is on with no policies (service role, server-side only); customer data is gated. Still open: no per-role database policies |
| D-05 | Medium | owner | ef8415a, d81d6e7 | gitleaks runs over the full history in CI (one pinned localhost hit). The owner must rotate the DB and app passwords that were pasted into chat |
| D-06 | Medium | **fixed** | 7b6c0c4, ef8415a | Lockfile, `npm ci`, `npm audit --audit-level=high` in CI (0 findings) |
| D-07 | Low | **fixed** | bbcb70e | Crons are recognised by `CRON_SECRET`. Test: `auth.test.js` |
| E-01 | High | **fixed** | f4fed8a | Bounded `fetchT` on every outbound call. Test: `tests/api/http.test.js` |
| E-02 | High | partly | e012f0c, 27ee9f9 | Visible degradation everywhere audited, plus the hourly monitor (`tests/api/monitor.test.js`). Still open: no automatic failover for F1X8 or Higgsfield (the jobs stop at their cap) |
| E-03 | Medium | partly | 09459b8, a5bc00d | Ingest and submits are idempotent. The sentiment and track stores stay append-only by design |
| E-04 | Medium | **fixed** | a4be00c | Job state is server-side. Test: `jobs.test.js` |
| F-01 | Medium | open | — | Whole-page `innerHTML` re-renders remain (G-04) |
| F-02 | Medium | partly | 465b390 | The 60-day payload is served stored and cached privately. Still open: the size is unchanged |
| F-03 | Low | no defect | — | — |
| G-01 | High | partly | f91ca52, 27ee9f9 | `generation_records` (correlation ids, latency, cost), `audit_log`, `ops_alerts` and the monitor. Still open: no external error tracker |
| G-02 | High | **fixed** | 7b6c0c4 | 236 tests plus the accuracy suite in CI (`.github/workflows/demo-ui.yml`) |
| G-03 | High | **fixed** | 5d36d6c, 27ee9f9 | `release.sh` (CI green for the SHA, fast-forward, both hosts), `rollback.sh` and `release.yml` with approval |
| G-04 | Medium | open | — | The single-file page remains; the Next.js shell is strangling it (ADR-001) |
| G-05 | Medium | partly | many | README, RUNBOOK, SECURITY, EVALS, API.md and per-phase docs. Still open: a full env-var table in the README |
| G-06 | Low | **fixed** | 38577ea | The legacy engine is archived under `legacy/`; no LangGraph or Lenceus |

## 2b. Defects the audit missed, found later

| Defect | Severity (as audited) | Found | Fixed in | Evidence |
|---|---|---|---|---|
| **Population defect:** the tracker's other projects were counted as Samsung posts, so TikTok reach was overstated about 6× | Critical (wrong numbers in every KPI) | Phase 7.0 reconciliation | cc3f0c1, 8582d85 (R-8: every counted post is from an owned account) | R-8 true daily; `track-sentiment.test.js`; checker bd1bb9f |
| **Hidden write failures:** `audit_log` writes used column names that don't exist, and `generation_records` rows were rejected by a CHECK constraint (the `assemble` kind). Both were swallowed, so the trail had gaps | High (the audit trail is a DoD item) | Phase 5/6 | 9b48975 (columns), 8682f37 (migration 017; the test fake enforces CHECKs) | `tests/api/constraints.test.js`, `tests/schema-constraints.js` |
| **Public comment read:** customer comment text was served without a session, publicly cacheable and with open CORS | High (customer data) | Phase 7.4 | 315c2c9, db929fe | `security.test.js`; checker b313d15 |
| **Approval spoofing:** a shared-password session could claim any role, including line manager, on a final approval | Critical (approval integrity) | Phase 11 | acca74f (finals, reopen, budget, package and members are member-only; `role_as_signed` records "password session claim") | `security.test.js`, `members-auth.test.js`; checker 4297575 |
| **Keyword sentiment:** 64 % of labels were keyword guesses, 43 % accurate on a blind sample | High (wrong insight) | Phase 7.3 | 37f06cd (fallback dropped; "not analysed" shown) | `tests/perf/sentiment-audit.test.js` |
| **Facebook views** shown as 0 instead of "not collected" | Medium | Phase 7.0 | 8582d85 | `performance.test.js` |
| **1,000-row truncation:** PostgREST caps responses at 1,000 rows, and several reads silently stopped there | High | Phase 11 | db929fe (`queryAll` paging; the fake mirrors the cap) | `tests/fake-postgrest.js`, `comment-handled.test.js` |
| **Budget cap loophole:** a piece's resolution could change after its first render to get the higher cap | Medium (money) | Phase 6.9 | 09c88b8 | `budget.test.js`; checker d50c174 |
| **Simulated Sprinklr calendar** presented as live | High (DoD: no faked integration) | Phase 8b | 868268a (manual/export mode; "not connected") | `tests/api/publishing.test.js` |
| **Backups are an allowlist**, so a new table would silently go unbacked up | Medium | checker, Phase 12 | this review | `tests/api/backup-tables.test.js` |

## 3. Quality scorecards (before → after)

| Area | Before (Phase 1, 2026-10-21) | After (2026-10-22) | Basis |
|---|---|---|---|
| **Trends** | page scrape; prompt unversioned; no eval; v1.1 ranked 1 of 38 with 15 "needs review" | agent API; hourly stored scoring; prompt v1.4 frozen; eval **10/10** live and recorded; ranked 13, needs-review 3, vetoed 22 | TREND_FRAMEWORK.md, `trend_scores`, `trends.eval` |
| **Content** | browser-only state, no versions, simulated QC, unverified fixes | server stage machine, versions with inputs and staleness, per-shot checks, real F1X8 QC + verify, priced renders with caps and a daily ceiling, lineage | CONTENT_STUDIO.md. **Output quality not measured:** the golden-set run is **not authorised** (owner: no Higgsfield spend for testing) |
| **Performance insight** | no reconciliation; mean ER over everything; 64 % of sentiment labels were keyword guesses (43 % accurate); twin rule missed 23 of 36; FB views shown as 0 | reconciliation R-1…R-8 all true; benchmarks by platform × format × age (nearest rank, n ≥ 20); tracker labels only (84/100; Arabic inconclusive); twins 0/0; themes 0.95/0.95 complaints, 1.00/0.97 issues (optimistic); attribution and learnings built and gated (0 of 30) | PERFORMANCE_INSIGHTS.md, EVALS.md |

## 4. Definition of done — where it stands

| Criterion | Status |
|---|---|
| Runs from a clean clone with one documented command | **Partly.** `cd demo-ui && npm ci && npm test` runs the suite from a clone; running the app needs Vercel env (`vercel env pull`, then `vercel dev`). A one-command local dev with seeded fakes is roadmap item 1 |
| All tests and evals pass; Must Not Break covered | Tests 236/236. Evals: frozen ones pass; tracker-sentiment bars are inconclusive at n = 20 (the tracker's, not Maistro's) |
| All Critical and High findings resolved | Critical: **all fixed**. High still open: A-06, B-02 (Q-003), C-23 (partly), D-04 (mitigated), E-02 (partly), G-01 (partly) |
| No behaviour regressions vs ARCHITECTURE_CURRENT.md except approved changes | Changes are logged and checker-verified; the deliberate ones are listed in REBUILD_LOG (e.g. password sessions can no longer approve finals; keyword sentiment dropped; the simulated calendar retired) |
| Trend, content and performance quality measurably above baseline | Trends and performance: measured, above baseline (§3). Content: **not measurable** without renders |
| Every approval rule server-side with a full audit trail | **Yes:** stage machine + `approvals` + `audit_log`; final approval member-only |
| Full lineage from posted performance back to the trend | **Built** (`?lineage=`, attribution); real data waits on migration 018 and linked posts |
| No integration faked | **Yes:** Sprinklr is shown "not connected — manual mode"; simulated QC labelled; the simulated calendar removed |
| README covers setup, architecture, env vars, deployment, operations | Partly (env-var table to complete) |
| A new engineer productive in a day | Plausible with RUNBOOK, ARCHITECTURE_TARGET and the tests; the single-file page is the main obstacle |

## 5. Remaining technical debt
1. The single-file legacy page (~410 KB, whole-page re-renders) — F-01, G-04.
2. The Hermes-dispatch path: simulated QC, 6-stage remap, newest-1,000-events aggregation — B-02, B-04, A-06,
   C-13 (decision Q-003).
3. A public reference-photo bucket (A-08); the unofficial translation endpoint (C-21); in-memory F1X8 asset
   buffering (C-16).
4. No external error tracker (G-01); no per-key ingest rate limit (C-12).
5. Owner-blocked: migrations 018–022, secret rotation, member sign-in, the production release environment, backup
   secrets, a preview database, Sprinklr credentials, the tracker fixes (TRACKER_INGESTION P1–P7).

## 6. Roadmap (3–6 months)

| When | Item |
|---|---|
| Month 1 | Owner gate: migrations 018–022, rotations, member sign-in and `MAISTRO_REQUIRE_MEMBER=1`, the release environment, backup secrets + first restore drill, the preview DB. Sprinklr: read-only probe, then the real adapter from the vendored v3 spec (media → draft → schedule), recorded-response tests. Tracker P1 (X / Facebook scrapers) and P2 (freshness alarm) |
| Month 2 | One-command local dev with seeded fakes (DoD); README env-var table; an error tracker (e.g. Sentry free tier) wired to `ops_alerts`. A held-out themes sample, then freeze the theme thresholds. A native-speaker re-label of the 7.3 / 7.4 Arabic buckets |
| Month 3 | Boost (8a) once young bands reach n ≥ 20: backtest precision / recall, then ship behind the owner's sign-off. First attributed posts → attribution analysis |
| Months 4–5 | Strangle the legacy page: move Performance, then Calendar, then Studio, into the Next.js shell, one route at a time, with the characterization tests as the guard. Decide Q-003 (Hermes path) and retire or rebuild it |
| Month 6 | Learnings (7.6) from ≥ 30 attributed posts into trend calibration as eval-gated prompt changes; a golden-set run if the owner authorises renders |
