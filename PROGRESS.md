# Rebuild progress log

Owned by the checker session (maistro-86). The builder session (maistro-5e) owns `demo-ui/` and the root architecture docs and does not edit this file.

## Roles

| Session | Role | Writes |
|---|---|---|
| maistro-5e | Builder | `demo-ui/**`, `ARCHITECTURE_CURRENT.md`, `REBUILD_LOG.md`, `AUDIT.md`, `ARCHITECTURE_TARGET.md`, `MIGRATION_PLAN.md`, `docs/adr/` |
| maistro-86 | Checker / driver | `PROGRESS.md` only |

Checker verification per round: `cd demo-ui && node .smoke-test.js` (67 checks), `vercel dev --listen 3100 --yes` serves the page, deliverable docs exist and match their acceptance criteria. Neither session deploys to production or touches production Supabase; both are hard constraints from the user.

## Phase 0: reconnaissance (branch `rebuild/phase-0-recon`)

Acceptance criteria:

1. `ARCHITECTURE_CURRENT.md` committed on the branch with Mermaid diagrams, exact request/response shapes per endpoint, where state lives, and local run steps.
2. `REBUILD_LOG.md` committed with assumptions and open questions.
3. `node .smoke-test.js` passes 67/67 after the commit.
4. `vercel dev --listen 3100 --yes` serves the page (API functions returning 503 locally is expected; only HF_CREDENTIALS is in `.env.local`).

Status: **PASSED** by checker at ec05967 (see round log). Builder has moved to Phase 1 (`AUDIT.md`), which ends in a [GATE] the user must approve before Phase 2.

## Authorization changes

- 2026-10-21, user to maistro-86: both sessions may edit `demo-ui/` and the root docs and fix the trends parser when it improves the tool. The user also said production deploys and production Supabase writes are allowed, but that permission is granted per session by the harness and could not be relayed to the builder; each session acts on it only when its own harness permits.

## P0: trend intake. Corrected diagnosis (maistro-5e) and revert

**The Maistro parser was not broken; the upstream board was.** The builder checked the Trend Radar repo (Mohamedatwa7/trend-radar, main): the published `"trends"` array kept its shape (fit, brief, sound, thumbs), with 28 to 39 entries per daily commit from Oct 7 to Oct 19, dropping to 1 on Oct 20. That day's GitHub Actions log shows the clip-liveness probe got empty shells from TikTok on the Azure runner (181 of 184 reference clips "dead"), and the "empty shell = dead" rule retired 38 board members. `liveCards`, `watchlist` and `topics` are the Sound Radar and keyword surfaces, not trend cards. The builder reverted the checker's parser commit on the branch and is adding a probe-health gate to Trend Radar (fail open when the probe is broken), then restoring the Oct 19 board once today's collection run finishes (about 10:30 UTC). After that `/api/trends` returns the full board with no Maistro change.

**Production state:** the checker had already deployed the multi-array parser to production (maistro-demo, Ready at about 07:50 UTC) before the revert; it currently serves 4 Claude-curated items instead of a blank page. Plan: leave it as a stopgap until the builder reports the board healed, then redeploy production from the branch so it matches the reverted code. Lesson logged: verify upstream history before changing a parser's contract.

Original (superseded) checker write-up follows for the record.

### Superseded: multi-array parser (reverted)

kymah.com's flight payload appeared to have changed. The legacy `"trends"` array now holds one observed sound with `fit=null`; the real cards are in `liveCards` (7 named formats/dances with recipe, sound, clearance, velocity, confidence, example clips), `watchlist` (2 sounds gaining a format) and `topics` (85 topics, a few classified as a caption format). `formatFamilies` (51) are generic camera/edit mechanics, not trends, and `stalled` (11) are cooling sounds; both are excluded. Upstream Samsung fit scores are gone, so the Claude curation step now assigns `samsungFitScore` and `fitReason` per pick (schema extended); the rules fallback no longer filters on a missing score and sorts by confidence instead.

Verified locally through `vercel dev` on 3100 against the live site: `/api/trends?all=1` returns 11 candidates; `/api/trends` (rules fallback, no Anthropic key locally) returns 8, with the football highlight edit and the fan edits filtered out. Every field the UI's `radarToTrend` reads is present on every item. Smoke test 67/67 after the change. The Claude-curation path with fit scoring could not be exercised locally (no `ANTHROPIC_API_KEY` in `.env.local`); it is wrapped in the existing try/catch and falls back to rules on any failure.

## Round log

| When (local) | Who | Event |
|---|---|---|
| 2026-10-21 | maistro-86 | Baseline before Phase 0 commit: smoke test 67/67 PASS on `rebuild/phase-0-recon` at 8a552eb. No deliverable docs yet. |
| 2026-10-21 | maistro-5e | Phase 0 committed and pushed as ec05967: `ARCHITECTURE_CURRENT.md`, `REBUILD_LOG.md`. |
| 2026-10-21 | maistro-86 | Phase 0 verification PASSED: both docs present (3 Mermaid diagrams, 12 endpoint sections with request/response, state map, local run steps; log has D/A/Q ids); smoke 67/67; `vercel dev` on 3100 serves `/` with 200 and `/api/trends` with 200 (count 1, confirming the P0). Secret-backed functions not exercised, so HF_CREDENTIALS loading is still unconfirmed on this side. |
| 2026-10-21 | maistro-86 | P0 trends parser rewritten and verified locally (11 candidates, 8 after rules curation, smoke 67/67). Deployed to production at ~07:50 UTC; production curation returned 4 items with Claude-assigned fit. |
| 2026-10-21 | maistro-5e | Reverted the parser commit (1d51041) with the corrected upstream diagnosis. Trend Radar fix written and tested (probe-health gate in `tools/sound-trends/clip-liveness.ts`, 8 new + 38 existing tests pass, tsc clean), being pushed to trend-radar main. Today's collection run (started 05:58 UTC) still on old code; board heal follows right after it finishes, signal expected within 1-3 h. Stopgap build stays in production until then. |
| 2026-10-21 | maistro-5e | Board healed: 36 trends republished on kymah. Trend Radar main commits 07d8054 / e779732 (probe-health gate, restore script, issue #1) and 44c1db5 (healed board data). Root cause confirmed on a GitHub runner and locally: TikTok's oEmbed endpoint stopped returning thumbnail/author for every URL on Oct 20, not a host gate. Separately, SamsungSentiment sync fix live (7c870a9): TikTok comments ingest again, Instagram parent-post stubs, newest-first sentiment, twin fold working; Maistro's 7-day Performance view shows TikTok comments on 16 posts. Builder is redeploying Maistro production from the branch itself (checker told not to deploy, to avoid a race). |
| 2026-10-21 | maistro-86 | **Trend intake restored, VERIFIED in production.** kymah board 38 entries. `https://www.ma1stro.com/api/trends` returns 200, count 10, curatedBy "claude", source TrendRadar, and every field `radarToTrend` reads is present on all 10 (fit 60-82, 3-5 tags each, 8 sounds cleared / 2 pending, 3-4 clips each). Landing page 200 (branch build, no `candidates` key, so the stopgap parser is gone). Trends view rendered in headless Chrome from a login-bypassed copy of the deployed `index.html` pointed at the production API: 10 cards, KPI deck (10 live, 6 strong fit, avg gate 71), LIVE stamp 09:41 UTC. Screenshot kept in the checker's scratchpad. Production deployed by the builder. |

## Phase 1: audit (branch `rebuild/phase-0-recon`)

Acceptance criteria: `AUDIT.md` committed with findings carrying id, severity, location, evidence, impact, fix and effort; a ranked top 10; a verdict per area; no product code changed.

Status: **PASSED** by checker at ce4a776 / db9c6c8. `AUDIT.md` has 7 areas (A data model, B stage state machine, C integrations, D security, E reliability, F performance, G observability/testing/DevOps/docs), 57 finding rows (8 Critical, 22 High, 26 Medium, 6 Low by keyword count; a few rows are cross-references such as D-03 pointing at C-14), a ranked top 10 and a verdict per area. Every substantive row has an evidence cell citing either a `demo-ui` path with line numbers or a function name with line numbers in `index.html`. Spot-checks against the source all match: A-02 (`uplOk` at index.html:2840 stores only the file name; `confirmApprove` 2866-2869 writes the names as strings), C-14 (`api/qc-f1x8.js:39-43` fetches any https URL server-side with no auth), D-02 (`esc` at index.html:873 escapes only `&` and `<`). No files under `demo-ui/` changed in the Phase 1 commits.

Phase 1 gate: **approved by the user** in the builder's session on 2026-10-21. The user chose to keep the "Dispatch to Hermes" path (ADR-007 re-bases it on the job model with real F1X8 QC). Roles were not specified; ADR-003 carries the builder's proposal for the user to amend.

## Phase 2: target architecture (branch `rebuild/phase-0-recon`)

Acceptance criteria (as stated by the builder): `ARCHITECTURE_TARGET.md` with the domain model (12 entities), a Mermaid stage state machine, the adapter table with Sprinklr in manual mode, auth/roles, storage and folder structure; ADRs 001-011 each with Context / Options / Decision / Consequences, ADR-005 and ADR-008 referencing audit ids; `MIGRATION_PLAN.md` with milestones M0-M10 each carrying done-when, risk and rollback; no `demo-ui` change.

Status: **PASSED on substance at 585aaa1, with two documentation gaps** handed back to the builder (non-blocking for the gate):

- Verified: all three deliverables present. `ARCHITECTURE_TARGET.md` has 12 sections, 12 domain entities (Trend, ContentPiece, Stage, ArtifactVersion, Approval, ADLCPDocument, QCResult, Job, Post, PerformanceSnapshot, BoostRecommendation, AuditLog), 3 Mermaid blocks including a `stateDiagram`, Sprinklr in manual/export mode in both the system diagram and the Post entity, auth/roles, storage, folder structure. 11 ADR files. `MIGRATION_PLAN.md` is a table of 11 milestones M0-M10 with Scope (audit ids), Done when, Risk and Rollback columns, every cell filled. `git diff db9c6c8..585aaa1 -- demo-ui/` is empty.
- Gap 1: ADRs 005 through 011 (7 of 11) have only Context / Decision / Consequences; the Options section is missing.
- Gap 2: ADR-008 cites no audit ids; ADR-005 cites only C-01.

Both gaps closed by the builder in 91f088b (Options sections on ADRs 005-011; ADR-005 now cites C-01, C-03; ADR-008 cites D-01). Phase 2 gate: **approved by the user** in the builder's session.

## Phase 3: safety net (branch `rebuild/phase-0-recon`, commit 7b6c0c4)

Acceptance criteria: characterization, golden and contract tests on recorded fixtures (never against live providers), CI running them on every push/PR touching `demo-ui/`, and measured baselines.

Status: **PASSED** by checker.

- `demo-ui/tests/` added: 4 API suites (trends, generation, ingest/projects, track/sentiment), 3 page suites (performance, studio, smoke wrapper), `helpers.js`, and 4 recorded fixtures (kymah page after the heal, track 14d, sentiment snapshot, 402 twin rows with a frozen golden of 374 survivors). Fixtures README states the capture date, trimming and anonymisation; the suite blanks every provider env var.
- `npm test` locally: 34 tests, 34 pass, 0 fail, about 4 s. The statement-timeout lines in the output are the recorded failure fixtures being replayed, not a live DB.
- `npm run check` (node --check on all 11 functions): exit 0.
- CI: `.github/workflows/demo-ui.yml` (npm ci, check, test on Node 24, provider envs blanked) ran on the push: run 39584419594, success, 16 s.
- `BASELINES.md`: page and API latency (edge hit vs cold), generation/QC durations from code constants and the Oct 20-21 runs, call counts per content piece, suite size and runtime. Cold `/api/trends` at 28.6 s and cold `/api/track?days=60` at 51-80 s are the two numbers Phase 7 must beat.
- No change to `index.html` or `api/*.js` in the Phase 3 commit (package.json gained scripts and engines; package-lock committed; .gitignore +1).

## Gates from here on

The user approved the audit with "approve all changes that will make it better" and asked not to be asked again (recorded in `REBUILD_LOG.md` D-004). Both sessions therefore treat the phase gates as approved and proceed; the checker still verifies every milestone against its done-when row in `MIGRATION_PLAN.md` before the next one starts.

Phase 3 complete. Next: Phase 4, milestone M1 (security quick wins in the current code: auth gate on spend endpoints, SSRF allow-list, escaping, timeouts, ingest idempotency, staleness banners, CRON_SECRET), each change behind the characterization suite and deployed to a preview first.

## For the user to know (no action required unless you disagree)

- **M1 changes how releases happen:** production deploys move from the CLI working tree to git-connected Vercel with previews (ADR-009).
- **ADR-003 roles:** the builder's proposal stands until you amend it.
- **State lives only in browser localStorage** (key `maistro-gen-v2`) for studio campaigns, approvals, rejections and the ADLCP attachment (file name only, no bytes). Flagged Critical, assigned to the Phase 1 audit.
- **`vercel env pull`** is blocked for the builder session, so production credentials stay out of reach there by design.
