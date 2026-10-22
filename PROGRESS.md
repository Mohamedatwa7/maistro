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

## Phase 4, milestone M1: security quick wins (commits f4fed8a..abb0ed4, production from dad31d0)

Done-when per `MIGRATION_PLAN.md` M1: characterization tests pass; preview verified; production promoted.

Status: **PASSED** by checker. `main` fast-forwarded to the branch tip (abb0ed4).

- Commits, one per change: bounded outbound HTTP with timeouts/retries and pinned function durations; escaping of every interpolated campaign, deliverable and approval field (`esc` now covers `>"'`); F1X8 proxy SSRF allow-list (media hosts only); constant-time bearer checks and cron detection by `CRON_SECRET`; `/api/ingest` content idempotency; trend-feed and performance empty/unreachable/stale states with a data-age pill; interim single-password login (HttpOnly cookie) gating hermes, director, higgsfield, qc-f1x8, upload, translate; legacy LangGraph engine archived to `legacy/engine` with its CI retired; README rewritten.
- `npm test`: 49 tests, 49 pass (up from 34). `npm run check`: exit 0.
- Production probes (checker, no app password, so stopped at the 401s): `GET /api/login` 200 `{"configured":true,"authenticated":false}`; `POST` to hermes, director, higgsfield, upload, translate and qc-f1x8 without a cookie all 401 `{"error":"login required"}`; `POST /api/ingest` without a key 401; `GET /api/trends` 200 count 10 curatedBy claude; `GET /api/track?days=14` 200; `GET /` 200.
- Preview deployments sit behind Vercel Authentication and report `configured:false` because preview env vars cannot be set until the repo is git-connected; the builder recorded that as a manual step for the owner in `REBUILD_LOG.md`.

Next: M2, Next.js shell and data layer, starting with migrations and the service-side campaign store.

## Phase 4, milestone M2 part 1: Next.js shell and data layer (commits 317ab78..19e48ee, production live, main at tip)

Done-when per `MIGRATION_PLAN.md` M2: login works; a Studio campaign created in the legacy UI is visible in the database.

Status: **PART 1 PASSED** by checker; **part 2 blocked on the owner** (see below).

- Shipped: Next.js 15.5.28 strangler shell owns ma1stro.com (`/` rewrites to a build-time copy of the legacy `index.html`, assets from `public/`, security headers); the twelve legacy endpoints consolidated behind one function `api/[route].js` → `api/_handlers/*` with identical URLs and shapes, because the Vercel project is on the Hobby plan (12 functions per deployment; the first new route could not deploy; ADR-004/009 amended); `/api/health`; `src/domain/stages.ts` state machine with 7 TypeScript tests; `db/migrations/001-006` plus `db/migrate.mjs` written but **not applied**.
- Local: `npm test` 58/58; `npm run typecheck` exit 0; `npm run build` (prebuild syncs the legacy page) exit 0. CI now type-checks and builds the shell; the run for a2d15e5 failed on the `.ts` import specifier issue and the follow-up 19e48ee run is green on both main and the branch.
- Production probes: `GET /` 200 with title "MAISTRO — A→Z Content Creation Platform", `X-Frame-Options: DENY`, HSTS set; `GET /api/health` 200 `ok:true` with the configured-provider map; `GET /api/nope` 404 `unknown route`; `GET /api/login` 200 configured/unauthenticated; `GET /api/trends` 200 count 10 curatedBy claude; `GET /api/track?days=14` 200 with 89 posts; `POST /api/hermes` without cookie 401; `HEAD /assets/landing-smoke.png` 200 image/png.
- Not yet verifiable: "campaign visible in the database" needs the migrations applied, which needs the connection string below.

## Phase 4, milestone M4 core: trends on Trend Radar's agent API (commit 11fd89e, production live, main at tip 3983778)

Done-when per `MIGRATION_PLAN.md` M4: feed shows age; a re-pushed stage creates a new version; external agent unchanged. The versioning part belongs to M2 part 2 (zod ingest) and is not in this drop.

Status: **PASSED** by checker for the two criteria in scope.

- `/api/trends` now reads Trend Radar's agent API (Vercel host of trend-radar, same database; kymah.com sits behind Cloudflare and is not deployable from this machine) with the page scrape as fallback. Upstream, the agent projection gained clips and sound commercial-use (trend-radar main 0747bd5).
- Local: `npm test` 61/61; CI green on main and the branch for 3983778.
- Production: `GET /api/trends` 200, source "TrendRadar agent API", live true, boardGeneratedAt 2026-10-21T08:25:58Z, boardTotal 38, curatedBy claude, count 10; every trend keeps id, name, samsungFit, sound, clips and the other UI fields (external agent contract unchanged) and gains the additive trendId, onBrand, brief, products; fit scores 60-82, 8 of 10 sounds cleared, clips on all 10. `?all=1` returns 38.
- Feed shows age: the Trends header pill renders "LIVE · TRENDRADAR · BOARD 21 Oct 2026, 12:25 GST" (Asia/Dubai per ADR-011) with no STALE pill while the board is under 36 h old. Headless render check: all 11 cards present in the DOM with the right names; they paint only after the scroll-reveal observer fires, which headless Chrome skipped this run, so the screenshot shows the KPI deck and header but not the grid. Not a product issue.

## Phase 4, milestone M6 early items: Gulf time and Arabic rendering (commit c0f4b17, production live, main at tip 49ec084)

Status: **PASSED** by checker.

- Every date label on the live pages is Asia/Dubai with a GST suffix (ADR-011); comments, captions and drill-down snippets render with `dir="auto"` and `unicode-bidi: plaintext`.
- Local: `npm test` 64/64, including the three new tests (Performance DATA AS OF and week labels in Gulf time independent of viewer locale; trends header board time in GST; comments and captions with `dir="auto"`). Served `index.html` is byte-identical to the branch file and contains `BIZ_TZ='Asia/Dubai'`, 5 `dir="auto"` spans, 5 `unicode-bidi:plaintext` rules and the DATA AS OF label.
- Full render with production data embedded (login-bypassed copy of the served page, `/api/track?days=14`, `/api/sentiment`, `/api/projects` and `/api/trends` stubbed from live responses): Performance header "DATA AS OF 20 Oct 2026, 22:46 GST"; week-on-week bars labelled 2 Sept through 21 Oct in Gulf time; KPI deck 48 posts, 87K views, 5.1% engagement, 231 comments, 66% positive, 5 critical alerts, platform split TT 19 / IG 16 / X 7 / FB 6. Trends pill "BOARD 21 Oct 2026, 12:25 GST" verified under M4.
- Observation handed to the builder (not blocking): the Critical Alerts list shows the same complaint twice ("Dear Samsung Pakistan Management…" by the same author), so the twin collapse does not reach that list, or the two copies differ in a field the collapse keys on.

## Phase 4, M2 part 2 (DB-free half): request schemas (commit 5d3d598, log 184a313, production live, main at tip)

Status: **PASSED** by checker, with a compatibility review of `demo-ui/api/_schemas.js` against the producers.

- Local: `npm test` 68/68 (4 new in `tests/api/schemas.test.js`). Production: `/api/health` ok; `/api/ingest` 401 without a key and 401 with a wrong key. The live 422 path was not exercised (no ingest key available to the checker); the local handler test covers it.
- Error contract preserved: ingest still 401 → 400 unknown stage → 400 missing artifact → 422 bad artifact → 400 projectId, same order as before; hermes validates its body after the method, session and "missing trend" checks (400); director after its unknown-stage and campaign-title checks (422). No message a client already relies on changed.
- Studio shapes validate: video artifacts are `{version, dur "Ns", audio, variants [{a, l "720p", k "seedance", st "ready"}], videoUrl, prompt, note, qcRevised?}` (genPoll, index.html 1608-1614) and image artifacts are `{imageUrl, prompt, note}`; both match the schema alternatives. Studio QC `{real, runs, avg}` matches the second qc alternative. `final` has no media-only alternative, which is correct: the renderer and delivTitle read `final.variants` unguarded, so a final without variants would break the page anyway.
- Built-in Hermes generator output maps onto the documented shapes (lowercase platforms, `th`/`g` as `[hex, hex]`, tiles as `[from, to, label]`, board as the frame array, qc `s` as integer); the client calls hermes with stages plan/mood/thumb/brief/board/final/qc and director with mood/thumb/board/final/revise (draft → final), all inside the enums; `campaign.title` is always `p.title`; `userInput` may be empty and is allowed.
- Behaviour change, by design (ADR-010), for the external Hermes agent: pushes that the old presence-only check accepted are now rejected when they carry capitalised platforms, colours not in `#rrggbb`, tiles not exactly `[from, to, label]`, more than 6 tiles or frames, variant kinds outside original|subtitles|voiceover|seedance, strings over the per-field maxima, or an artifact over 64 KB. `API.md` already documents the strict forms, so a conforming agent is unaffected.
- Watch item: the 64 KB artifact cap is fine for every current push, but a real F1X8 QC result with deep analysis could approach it if the Studio ever pushes QC through ingest (heatmaps are already kept out).

## Fix: cross-post twin fold in Critical Alerts and KPI drill-downs (commit 179f9c1, log 14262c4, production live, main at tip)

Status: **PASSED** by checker.

- Cause (builder): `sentiDedupe` runs per post, but Critical Alerts and the KPI drill-downs use `allComments(list)`, which flattens across posts, so one author pasting the same complaint under two posts produced two rows. New `sentiFoldAcross(cmts)` folds the flattened list on author+text, keeps the analysed or most-liked copy and sets `c.across`; the alert row and `rCommentRow` show "× N POSTS" when across > 1. Per-post sections and `s.flags` counts intentionally unchanged.
- Local: `npm test` 69/69 (new test at the end of `tests/page/performance.test.js`). Served `/` byte-identical to the branch (second fetch; the builder's first probe had hit a cold edge).
- Full render with production data: the "Dear Samsung Pakistan Management…" alert appears once in Critical Alerts with "× 2 POSTS". In rendered markup (embedded data excluded) the text occurs 3 times on the base page: the single alert row plus the two per-post sections. Triggering `kpiDrill('alerts')` adds exactly one row (4 total) with its own "× 2 POSTS" label, so the drill lists it once; `kpiDrill('cmts')` (most-liked) adds none.

## Interim fixes for A-02 and B-02: approval documents stored, simulated QC labelled (commit 6ff8ac1, log 32483ce, production live, main at tip)

Status: **PASSED** by checker (code review plus probes; no live document upload, since the checker has no app password).

- A-02: `POST /api/upload` with `kind:"document"` stores the line-manager and ADLCP sign-offs in the private `approvals` bucket (bucket created with `public:false`, `x-upsert:false`), accepts pdf/jpeg/png/webp/eml/msg up to 3 MB, and returns `{path, sha256, size, contentType, name, at}` with no public URL. `GET /api/upload?path=` signs a 600 s URL. Both require the session. Path handling reviewed: the regex `^documents/\d{4}/[a-z0-9]+-[a-z0-9]{6}\.[a-z]{3,4}$` is anchored, allows no slash, dot-segment or percent sequence beyond the single extension dot, and the bucket name is hard-coded, so the path cannot be steered to another bucket or object. `name` is stripped of control characters, capped at 160 and escaped on render.
- Client: `uplOk` uploads on file pick and stores the result in `dataset.doc`; `confirmApprove` refuses while any upload is busy or lacks a stored document; `d.appr.lm` / `d.appr.adlcp` are now objects; `docLabel` renders name, 8-character checksum and an OPEN link that fetches a signed URL; legacy string records render as "name only". The gate is still client-side until the approvals table exists (A-05 remains open).
- B-02: the built-in generator's qc stage no longer invents a reviewer; its map returns `{f1x8, f1x8Note, simulated:true, human:null, humanNote:null}` and the Studio labels it "Pre-flight estimate (Claude) — not an F1X8 result" with AWAITING HUMAN REVIEW. The ingest qc schema now has `human` / `humanNote` optional and `simulated` optional, so external pushers are unaffected.
- Local: `npm test` 73/73. Production: `/` byte-identical to the branch; `/api/upload` 401 without a session on POST and on GET `?path=`; 405 on PUT; `/api/health` ok.
- Minor, not blocking: `/api/upload` still sets `Access-Control-Allow-Origin: *` although it is session-gated; harmless because a wildcard origin cannot carry the HttpOnly cookie, but it can be dropped in the React rebuild.

## Docs: API.md regenerated (commit eef920f, log 541ced7; AUDIT G-05)

Status: **PASSED** by checker against the handlers. The route table lists all 13 handlers with the same auth split the code enforces: session cookie on hermes, director, higgsfield, qc-f1x8, upload, translate (exactly the six that call `requireSession`); ingest key on `/api/ingest`, `/api/sentiment` POST and `/api/track?store=1`; `CRON_SECRET` for the daily cron. New sections for health, login, track, translate and upload are present; the validation contract paragraph states 400 for hermes and 422 for director and ingest with `problems[]`; no section mentions maistro-demo.vercel.app and the base URL is ma1stro.com.

## M2 part 1 applied: migrations 001-006 on Maistro's Supabase (log 7b50e15; REBUILD_LOG Q-006 answered)

Status: **PASSED** for what the checker can reproduce without the secrets. The owner gave the builder the session-pooler connection string, the anon key and the service-role key. `vercel env ls production` now lists `MAISTRO_DATABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_ANON_KEY` (added 2026-10-21, encrypted). No `.env` file is tracked (`.env.local` is ignored), no connection string with a password appears anywhere in the tree, and `db/migrate.mjs` only reads the URL from the environment and never prints it. The migration runner records every file in `schema_migrations` inside a transaction, so a re-run is a no-op. Migration 006 creates the private buckets `assets`, `approvals` and `refs-private` with `on conflict do nothing`, which makes the upload handler's on-the-fly bucket creation redundant (harmless 409, as the builder noted). Not reproduced here: the PostgREST checks on the new tables, because the checker has no service-role key by design; the builder reports all ten tables answer. `/api/health` does not list the three new names because its checked list is fixed and production has not been redeployed since the env add; the next deploy should extend that list.

## M2 part 2 (a): campaign store with the server-side approval gate (commit bfe1942, log c400b0e; ADR-003, AUDIT A-05)

Status: **PASSED** by checker; the M2 done-when row stays open until parts (b) and (c), as the builder said.

- Tests: `npm test` 76/76 green here (30 s), `npm run typecheck` clean, `npm run check` now covers pieces, decisions, `api/_store.js` and `src/domain/stages.js`. CI not yet checked for this push (see next tick).
- Domain: `stages.ts` to `stages.js` is a faithful port. The transition table is unchanged (generate, generated, failed, regenerate, reject with reason, approve with the self-approval rule, final needing both documents and a line-manager/ADLCP/admin role, reopen admin-only). Only additions: a `!t.documents` guard, extracted role lists, `default` branches, and `approverId: string | null` in `stages.d.ts` (the store passes null until member identity exists). The seven domain tests run against the `.js`.
- Store: every write of an `approvals` row and every stage state change goes through `transition()` first; there is no bypass in `decide()` or `reopen()`. `recordVersion` refuses an approved stage with 409 `approved_immutable`. Final documents are accepted only with a `documents/YYYY/<id>-<6>.<ext>` path, a 64-hex sha256 and size > 0, and both `adlcp_documents` rows are inserted before the approval row. Database backstops confirmed in migration 003: the partial unique index `approvals_one_approved_per_version` (one "approved" per version) and `unique (stage_id, version)` (a concurrent version insert fails loudly instead of duplicating).
- Routes and production: `/api/health` reports `MAISTRO_DATABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` true, missing []; `/api/pieces` GET and POST 401 without the cookie; `/api/decisions` 405 on GET, 401 on POST without the cookie; `/api/ingest` still 401 without the key; `/` is byte-identical to the committed `index.html` (sha256 ac1755d3…).

Open items for the builder (none blocks this drop):

1. **Role is self-claimed until part (c).** `req.member` is never set yet, so `decisions.js` takes `role` from the body: any holder of the shared password can claim `admin`, approve final or reopen. The gate now enforces order, documents and one-approved-per-version, but not *who*; ADR-003's "confirmed by a member holding the matching role" is met only after Supabase Auth lands. Keep it in the done-when check for (c).
2. **Ingest to an approved stage diverges.** A push to an approved stage is still accepted into `campaign_events` (what the legacy page reads) while the store answers 409 and the response says `stored:false`. After part (b) either the page reads from the store or ingest refuses pushes to approved stages; otherwise an external push can overwrite what reviewers see after approval.
3. **`listPieces` query size.** The `id=in.(...)` filters carry up to 200 pieces x 8 stage ids in the URL (about 60 KB), which will exceed proxy header limits long before the limit of 200 is reached. Query by `piece_id` in batches or lower the default; fine at today's volume.

## M2 part 2 (b): legacy page writes through, server decides approvals (commits e51807e, 6f237f4; log d8c2394)

Status: **PASSED** by checker. The M2 done-when row ("login works; a Studio campaign created in the legacy UI is visible in the database") is now covered end to end by the harness (`tests/page/sync.test.js` drives the page's sync functions against the fake PostgREST) but still needs one click-through by the owner, because neither session holds the app password.

- Tests: `npm test` 81/81 green here; typecheck and check clean. CI was still running for d8c2394 at verification time.
- Page: `syncStage` is called from `attachTo`, both dispatch-loop points, the Studio plan fill and `qcFinishIfSettled`; QC runs are stripped of `heatmap`/`attention_heatmap` before storage; `confirmApprove` and `confirmReject` are async and only mutate local state after a 200 from `/api/decisions`, with the server's error shown in `#ap-err`/`#rj-err` and the button re-enabled; the approve modal offers only line_manager/adlcp_approver/admin on final; `doLogin` calls `loadPieces`, whose `applyServerPieces` lets the server win and skips external pieces. All helpers it relies on (`delivTitle`, `BOT_STAGE_IDX`, `fmtStamp`, `GEN_AGENT`, `authFetch`) exist in the page.
- Checker items 2 and 3 from part (a) are closed: an ingest push onto an approved stage now answers 409 `approved_immutable` before anything reaches `campaign_events` (test asserts the event count is unchanged); `listPieces` chunks every `id=in.(...)` read at 40 ids, default 100, cap 200 (test: 95 pieces produce 3 chunked reads under 2.5 KB each, and `limit=9999` is capped).
- Production: `/` byte-identical to the committed `index.html` (sha256 1da81d7f…, 291951 bytes); health ok, missing []; pieces GET 401, decisions POST 401, ingest POST 401 without credentials.

Open items (none blocks this drop):

1. **Stage order is still not enforced on the server** (half of AUDIT A-05). `recordVersion` only refuses an approved stage; it never runs the `generate`/`generated` transitions or `readyStages`, so a version can land on a `locked` stage and `final` can be approved while `plan` is unapproved, as long as `final` has a version. The legacy page produces stages in any order, so enforcing this now would break the write-through; the right moment is M3, when generation moves server-side. Record A-05 as half-closed (documents, immutability, one-approved-per-version, roles) rather than closed.
2. **Self-claimed role** stays open for part (c), as agreed.
3. Minor: `syncStage` is fire-and-forget, so an approval clicked within a second of generation can hit 409 `no_version`; the error is shown and a retry succeeds. Awaiting the sync before enabling the approve button would remove it.

## M2 part 2 (c): member sign-in through Supabase Auth, roles, invitations (commit 9851f76, log 4a2af0e; ADR-003)

Status: **PASSED** by checker for everything reproducible without a real member. The "login works" half of the M2 done-when row closes when the owner signs in once with the magic link (owner steps below).

- Tests: `npm test` 87/87 green here; typecheck and check clean (check covers `members.js` and `_members.js`). CI was running for 4a2af0e at verification time.
- `api/_auth.js`: cookie formats `exp.mac` (password) and `exp.memberB64.mac` (member), the MAC covers everything before it, base64url cannot contain a dot so the split is unambiguous; `readSession` rejects an edited payload, an expired cookie and a MAC under another secret (constant-time compare); `requireSession` sets `req.member`; `requireRole` answers 403 `member_required` for password sessions and 403 `role_required` for the wrong role.
- `api/_members.js` and `login.js`: the access token is verified against GoTrue `/auth/v1/user` with the anon key, the members row is looked up by the auth user id, bootstrap admins come from `MAISTRO_ADMIN_EMAILS`, strangers get 403 `not_a_member`, inactive members too; the password path is unchanged while `MAISTRO_APP_PASSWORD` is set and answers 401 "retired" when unset.
- `api/_handlers/members.js`: admin-only through `requireRole`; invite goes through GoTrue `/auth/v1/invite` with the service role and creates the members row with the role; 409 on an existing member, 422 on bad e-mail or role, self-deactivation refused; PATCH changes role, active and name.
- `decisions.js`: a member session supplies role and name, the claimed role is ignored (test: a signed-in viewer claiming admin gets 409 `role_required`); `generated_by` is recorded on pieces POST so `self_approval` can fire; `MAISTRO_REQUIRE_MEMBER=1` answers 403 `member_required` to password sessions.
- `index.html`: AUTH config from GET `/api/login`; the magic-link button hides when not configured; a returning `#access_token` is exchanged at boot and scrubbed with `history.replaceState`; approve and reject modals pre-fill the member's name and lock the role for members; the Members sidebar entry shows only for admins.
- Production: `/` byte-identical to the committed `index.html` (sha256 dafd0a4e…, 299988 bytes); health ok; GET `/api/login` reports magicLink true, password true, the public anon key and the project URL; POST with a junk token 401, wrong password 401; `/api/members` GET and POST 401 without a cookie.

Open items for the builder (1 should land before the team is onboarded):

1. **A member cookie carries its role for 30 days and is never re-checked.** `requireRole` trusts the role inside the signed cookie, so a member whose role is lowered or who is deactivated through PATCH keeps the old rights until the cookie expires. Re-read the members row (active, role) in `requireRole` for members and decisions, or shorten the member TTL, or put a members version/updated_at in the cookie and compare.
2. Minor: an admin can change their own role through PATCH (the page disables it, the server does not), which can lock the last admin out. Refuse self-demotion like self-deactivation.
3. Minor: `requestMagicLink` sends `create_user: true`, so anyone who reaches the login page can create an auth user (never a member). After the owner's first sign-in, turn off "Allow new users to sign up" in Supabase Auth, or switch to `create_user: false`; invitations keep working either way.

## M2 part 2 (c) hardening (commit cd8e9e4, log 422c0ae)

Status: **PASSED** by checker. All three items from the part (c) review are closed.

- Tests: `npm test` 89/89 green here; typecheck and check clean. CI was queued for 422c0ae at verification time.
- Live role check: `refreshMember` re-reads the members row by id and replaces the cookie's role and name; `requireRole` (now async) calls it, and the POST paths of decisions and pieces call it for member sessions. Inactive gives 403 `member_inactive`, a demoted member gets the row's role (test: a cookie claiming admin for a viewer row is refused on `/api/members`), a storage error fails closed with 503.
- Self-demotion: members PATCH refuses `active:false` or a non-admin role on the caller's own id (422).
- Magic links are requested server-side: POST `/api/login` with `{email}` sends the OTP only for an active member or a bootstrap admin and answers 200 `{ok:true}` either way; 422 for a malformed address; GET `/api/login` no longer exposes the anon key or project URL, and the page no longer calls GoTrue directly. `create_user:true` stays on the server call so the bootstrap admin can sign in before an auth user exists; strangers never reach GoTrue.
- Production: `/` byte-identical to the committed `index.html` (sha256 3f6efe30…); GET `/api/login` returns only `magicLink` and `password` flags, no key material; POST `{email:"stranger@evil.example"}` 200 ok, `{email:"nope"}` 422; `/api/members` 401 without a cookie; health missing [].
- Nit, not blocking: the stranger path answers faster than the member path (no GoTrue call), a timing tell for enumeration that only matters if someone cares; GoTrue's own per-address rate limit covers link spam to a member.

## M4: trends_cache with refresh-on-read; health feature switches; plan status line (commit cfdbbb2, log 1dfa175; ADR-005)

Status: **PASSED** by checker. M4 is partial by design: the hourly cron waits on the Pro-plan decision, so refresh-on-read is the whole mechanism on Hobby.

- Tests: `npm test` 91/91 green here; typecheck and check clean. The two new cache tests cover the fill, the in-hour hit without upstream or curation calls, the hour-old refresh and the stale serve on a failed refresh. CI was queued for 1dfa175 at verification time (the previous run for 422c0ae passed on main).
- Migration 007: one row keyed `board` with `payload`, `source`, `board_generated_at`, `fetched_at`, `error`; RLS enabled with no policies, so only the service role reads or writes. The production cache hit proves the table exists.
- Handler: a read younger than 3600 s is served from the row; older, `fetchBoard()` (agent API, then page scrape) runs and the row is upserted through the new `upsertRows` (`resolution=merge-duplicates`); a failed refresh with a cached row answers 200 with `cache.stale:true`, `cache.error`, a shorter `s-maxage=120`, and the row's `error` column set; without a cached row the historical 502 stands. Caching is skipped when the database is not configured, so the earlier trends tests run unchanged.
- Production: `/api/health` has `features` {MAISTRO_ADMIN_EMAILS true, MAISTRO_REQUIRE_MEMBER false, MAISTRO_APP_PASSWORD true}, missing []. Three cache-busted reads of `/api/trends` were all hits (ageS 90, 92, 94) with count 10, curatedBy claude, source agent API; `?all=1` answers 38 raw trends from the same row; `minScore=70` leaves 6 of 10, `limit=3` leaves 3, `id=` leaves 1, all on hits. The client-facing Cache-Control is Vercel's rewrite of `s-maxage` (`public, max-age=0, must-revalidate`), as before.
- `MIGRATION_PLAN.md` carries the requested status line (M0 to M2 code complete, M2 done-when on the owner, order enforcement to M3, M4 partial, M3 and the hourly cron on the plan decision).

Open item for the builder (minor):

1. **A raw read that misses rewrites the row with the old curation.** Line 372 of `trends.js` stores the new raw board together with the previous row's `curated` list and a fresh `fetched_at`. The next curated read within the hour is a hit with a non-empty `curated`, so it serves the old top 10 as fresh for up to an hour, possibly naming trends no longer on the board. Fix: store `curated: []` on a raw miss, and when a hit carries an empty `curated`, curate and write it back keeping the row's `fetched_at`.

## Pro plan: hourly trends cron; raw-miss cache fix (commit ca41ee2, log 8f24ffe)

Status: **PASSED** by checker. First real cron run observed: a cache-busted read at 15:23 UTC returned `cache.hit:true`, `fetchedAt 2026-10-21T15:15:24Z`, count 10, curatedBy claude, so the 15:15 UTC run refreshed the stored board and its curation; the board itself is still the 08:25 UTC upstream publication, as expected. The first `trend_snapshots` rows were written by the same run (the cron response carries the count; only the service role can read the table).

- Tests: `npm test` 92/92 green here; typecheck and check clean. The new test covers the raw-miss storing no curation, the next curated hit curating once and writing back with the row's `fetched_at`, and the cron refreshing unconditionally. CI queued for 8f24ffe at verification time; the M4 run before it passed.
- `vercel crons ls` on the linked project lists both crons: `/api/track` at 06:30 daily and `/api/trends` at 15 past every hour. The deploy carrying an hourly schedule was accepted, which only Pro allows, so the plan question Q-002 is closed by the deploy itself.
- Cron path: `isCron(req)` (bearer `CRON_SECRET`) refreshes the board and curation unconditionally, writes the row, answers `{ok, refreshed, source, boardTotal, curated, curatedBy, at}` with `no-store`, and marks the row's `error` on failure. A forged bearer and a `vercel-cron` user-agent alone both fall through to a normal cached read on production (verified), so nobody outside can force curation calls.
- Cache fix: a raw (`?all=1`) miss now stores `curated: []`; a later curated hit with an empty curation curates once and writes it back keeping the original `fetched_at`; a stale hit never rewrites.

## M3: jobs service (commit a4be00c, log 18f4a4d; ADR-004, ADR-006, AUDIT A-05 order half)

Status: **PASSED** by checker for everything reproducible without a session and without spending Higgsfield credit. The live check is the owner's first Studio generation through the job path; cron runs are visible in Vercel's cron logs.

- Tests: `npm test` 99/99 green here; typecheck and check clean (check covers `jobs.js`, `_jobs.js` and the three adapters). CI green on both branches for 18f4a4d.
- Rows: `createJob` inserts `{piece_id, stage_id, kind, state queued, attempts 0, payload (+pieceId, stage, generatedBy), next_poll_at now}`; migration 004 already carries the `timed_out` and `cancelled` states, the partial due index and a member read policy. Per-kind poll intervals (20 to 90 s) and timeouts (15 to 45 min), three submit attempts with 60 s x attempts backoff, a 4xx on submit fails at once.
- Overlap safety: `claim()` is a conditional PATCH on `id`, `state=eq.<seen>` and `next_poll_at=lte.<now>` that moves `next_poll_at` forward; zero rows back means another caller has it. The test proves the filter is sent and two concurrent advances touch the row once; the atomicity itself is Postgres' per-row UPDATE, as the builder noted. Tick budget 50 s under the 300 s function limit, 25 rows per run, one-minute cron.
- Copy-in: `storage.copyIn` downloads through the F1X8 adapter's allow-listed `fetchAsset` (Higgsfield CDN and the project's Supabase host) and uploads to `assets/pieces/<legacyId>/<stage>/<ts>-<sha12>.<ext>` with sha256 and size on the artifact; signed reads through GET `/api/jobs?asset=` are limited by a path regex to piece assets and expire in an hour.
- Completion: `recordVersion` with `producedBy higgsfield_soul|higgsfield_seedance`, `kind`, `jobId` and `generatedBy`, which sets the stage `generated`; F1X8 results go to `qc_results` against the stage's current version with the heatmap stored as a blob and stripped from the row.
- Order: `prerequisitesMet(stages, kind, {strict, origin})` in the domain; soft on the legacy page (prerequisites must exist), strict for the new pages (approved), external pushes need only the plan; `createJob` refuses with 409 `prerequisites`, `approved_immutable` or the transition code, and a failed or timed-out render returns the stage to `ready`.
- Page: `useJobs()` reads `maistro-legacy-providers`; `jobPoll`/`qcJobPoll` poll `/api/jobs?id=`, attach with the recorded version so no second version is written (test asserts zero `/api/pieces` POSTs); the old `genPoll`/`qcPoll` path and the `/api/higgsfield` and `/api/qc-f1x8` proxies remain and now delegate to the adapters with their characterization tests unchanged.
- Production: `/` byte-identical to the committed `index.html` (sha256 0f983e16…, 306898 bytes); `/api/jobs` 401 on GET, GET `?id=`, POST and GET with a forged cron bearer; `/api/higgsfield` and `/api/qc-f1x8` 401; health ok; `vercel crons ls` shows `/api/jobs * * * * *`, `/api/trends 15 * * * *`, `/api/track 30 6 * * *`.

Open items for the builder (none blocks):

1. **A stage can get stuck in `generating`.** `createJob` patches the stage to `generating` before inserting the job row; if the insert fails, no job exists to fail the stage back to `ready`, and every later attempt answers 409 `not_ready`. Insert the job first and patch the stage after, or treat `generating` with no queued or running job for that stage as `ready`.
2. **A `completed` status without output loops until timeout.** `pollRender` only records when `completed` comes with a video or an image; a completed-but-empty answer is re-polled for the full 15 to 20 minutes. Fail it at once.
3. **Copy-in failure** (the builder's question): keep the job succeeding with `copiedIn:false` as now, because a failed copy should not cost the person their render; but since provider URLs expire, add a reconcile that retries the copy for succeeded jobs with `copiedIn:false` (the ops phase is the natural home). The swallowed `qc_results` insert failure deserves the same treatment.

## M3 robustness fixes; Phase 0 revision 2 (commits 6183893, 62c4af3; log 28ef46a)

Status: **PASSED** by checker. Items 1 and 2 from the M3 review are closed; item 3 (copy-in and qc_results reconcile) is carried to the ops phase of the expanded mandate.

- Tests: `npm test` 100/100 green here. CI was running for 28ef46a at verification time.
- `createJob` now inserts the job row first and patches the stage second; a failed patch is recorded on the row as `failed` and answered 502 `stage_patch`, so nothing is stranded; a stage left `generating` with no queued or running job counts as `ready` (a live job still gives 409 `not_ready`); the inline advance runs after the patch. `pollRender` fails a `completed` status that carries no media at once.
- `ARCHITECTURE_CURRENT.md` revision 2 describes the live system after M0 to M4 with the M3 render data flow and the enforced stage lifecycle; no stale claims about the old demo host, the kymah scrape as primary source, or localStorage as the only state. README refreshed. This is the expanded mandate's Phase 0, reconciled rather than redone.

## Expanded mandate (phases 0 to 13): reconciliation against this log

The builder's plan reuses Phase 0 (revision 2), Phase 1 (AUDIT.md plus a status column with commit ids instead of a re-audit), Phase 2 (ADRs stand, new ones only where phases 5 to 8 need them), Phase 3 (the suite, 100 tests, as the safety net) and Phase 4 (M5 to M10 of MIGRATION_PLAN). Checker's view: nothing recorded here as verified would be redone. Three places to keep single:

1. Phase 5.0's snapshot storage should extend `trends_cache` (one row per fetch, keep history) rather than add a second store for the same board; the hourly cron already produces a snapshot per hour.
2. Phase 11 (security) should start from the AUDIT status column and the verdicts in this log (M1 quick wins, A-02, A-05 half, ADR-003 live role check), not from a fresh scan of what is already closed.
3. Phase 6.0's Higgsfield capability matrix should cite the adapter's characterization tests and recorded fixtures rather than probe the live API, which spends credit.

Release policy: the expanded mandate restores "no production deploy without explicit approval". The builder has asked the owner whether the earlier blanket approval stands. The checker does not relay or interpret approvals between sessions; until the owner answers, the builder does documentation and preview-only work (5.0, 6.0, 7.0), which is the right call.

## Phase 5.0: KYMAH_DATA.md and per-trend snapshots (commit b00dad2; branch only, not on main, not deployed, migration 008 not applied)

Status: **PASSED with two corrections** for the data dictionary; the code half is reviewed and green but unreleased pending the owner's release-policy answer.

Fact-check against the Trend Radar checkout (`D:\Trend Radar\samsungtrend`, main at 0747bd5), not the prose:

- Confirmed: `boardStageOf` at `board-layout.ts:42` (rising, active to peaking, else mature); `growthOf` at `promote.ts:55` (counter growth, else sampled growth, else velocity); `weeklySampledViews` and `engOf` at `board-layout.ts:267-285` (7-day sampled sum; likes per 100 views over clips with both counters); `gateClaimsFit` at `board-enrich.ts:100-107` and the `onBrand` composition at line 506; cron slots 01:07, 02:27 and 04:37 UTC in `daily-collect.yml`; the current board's `generatedAt` 08:25 UTC.
- Confirmed coverage on `apps/web/app/lib/trends.generated.json` (38 trends): fit null 9, viewsWk null 10, tags non-empty 9, products non-empty 8, format 0, sound 29 with `commercialUse.cleared` true 16 and false 13, stage peaking 31 and mature 7, onBrand 11, kind trend 29 and moment 9.
- **Correction 1, the fit threshold:** the doc says `fit.strength >= 50`; the constant is `GATE_PASS_STRENGTH = 55` in `packages/synthesis/synthesis.ts:66` (the comment at `board-enrich.ts:96` records the move from 50 to 55). Change the number in rows `onBrand` and wherever 50 is repeated.
- **Correction 2, the lifecycle numbers are method-dependent:** re-measuring over the same period gives 44 commits touching the file (all with data-style messages), 28 distinct `generatedAt` boards and 132 ids; counting days on board by distinct board dates gives 25 one-day ids, 46 at 2 to 5 days, 53 at 6 to 15, 8 at 16 to 37. The doc's 40 commits, 133 ids and 24/31/50/15 come from a different counting rule (commit days rather than board dates, most likely). Under the board-date rule the median stay is in the 2 to 5 day bucket, not "about a week"; "a quarter are one-day visitors" is closer to a fifth. State the rule in the doc and soften the median claim, or keep the numbers and name the method; the definitional conclusion (enough history to define lifecycle math, too coarse to validate emerging/rising/declining) stands either way.

Corrections applied in 1f8bee8: the onBrand row cites `GATE_PASS_STRENGTH = 55` with its source and the 50 to 55 move, and the lifecycle section names the counting rule, shows both measurements side by side and softens the median claim. Verified by reading the file. Closed.

Code half: `npm test` 101/101. Migration 008 creates `trend_snapshots` (one row per trend per real fetch, indexed by trend id and fetch time, RLS on with no policies); `snapshotRow` maps from fields the normalizer really produces (`momentumPerDay`, `avgEngagementPct`, `viewsPerWeek`, `signalStrength`, `stayingPower`, `onBrand`, `kind`, `sound.musicId`, `sound.cleared`, `status`), rejects records without a name and id, and a write failure is logged without touching the served board; rows are written only on the cron and the read-path refresh, never on hits. The per-trend-row design is accepted over the per-fetch blob: lifecycle math queries by trend over time, and `trends_cache` keeps the single serving row.

## Phase 6.0: HIGGSFIELD.md capability matrix; adapter on the documented REST contract (commit a5bc00d; branch only, not on main, not deployed)

Status: **PASSED** by checker. Every platform and model fact in the doc was checked against the official pages (fetched by the checker, not taken from the builder), and the code half against the adapter, the job service and the tests.

Platform facts confirmed on docs.higgsfield.ai: statuses queued, in_progress, completed, failed, nsfw, canceled with only queued cancelable; Idempotency-Key 1 to 255 visible ASCII, same key and body replays the original request id without a charge, different body answers 422, rejected requests do not consume the key; the limit is concurrency and exceeding it answers 400 with "Maximum number of concurrent requests (N) has been reached", no 429 and no Retry-After; 401 credentials, 403 insufficient credits, 404, 422 validation or key conflict, 423 model blocked, 500, 503 model disabled, X-Correlation-ID on every response; failed and nsfw are not charged and a canceled queued request is refunded; `POST /estimate/<endpoint-id>` returns credits and usd; outputs retained at least seven days; webhooks by `hf_webhook`, envelope request_id, status, error, payload, no signature documented, ten-second response, two-hour retries; presigned uploads at `/files/generate-upload-url` with public_url, upload_url, upload_headers and the retention=temporary tag.

Model facts confirmed: SOUL V2 has no image-reference input, only `custom_reference_id` for a trained character, seed 1 to 1,000,000, batch 1 or 4, aspect 1:1 default; SOUL standard's `image_reference_url` "guides prompt enhancement"; Seedance 2.5 text-to-video has no seed, `generate_audio` default true, duration 4 to 30, the six aspect ratios the adapter allows; image-to-video takes `image_url` and `end_image_url` with no aspect ratio and no camera controls; reference-to-video takes up to 30 image, 10 video and 10 audio URLs, 50 in all, public URLs only.

Code half: `npm test` 102/102. `submit()` POSTs `https://api.higgsfield.ai/<endpoint-id>` through `fetchT` with a 30 s bound, `Authorization: Key`, an `Idempotency-Key` (the job id from the job service; the legacy proxy forwards the browser's header or mints a UUID), and the documented bodies; `classify()` marks the concurrency 400, 423 and 5xx retryable and 401, 403, 404, 422 and other 400s permanent; the job service backs off with jitter on retryable errors under the same key (test: concurrency 400, then 503, then success) and fails at once on permanent ones. No source file imports `@higgsfield/client` any more (the only remaining references are the compiled `.vercel/output` build artifact and `package.json`); removal is a separate dependency commit, as the builder said. The deprecated v1 reference path stays until H-1 is designed in 6.1/6.2.

One risk to record, not a blocker: the errors page advises against parsing `detail` messages for permanent decisions, and `classify()` decides "retryable" for a 400 only when the text contains "concurrent". If Higgsfield rewords that message, concurrency refusals become permanent failures that return the stage to ready. Since submits are idempotent and capped at three attempts, treating any 400 whose detail is a plain string as retryable within the cap (and only a validation list as permanent) would cost nothing and remove the dependency on the wording.

## Phase 7.0: Performance data reconciliation, measured daily (commit 0b1a2e2, log 66dfb0a; released with 5.0 and 6.0 under the owner's delegated gates; migrations 008 and 009 applied)

Status: **PASSED** by checker for the method and the code; the first live evidence is the cron row after 06:30 UTC on 2026-10-22, which the checker will read and report.

- Tests: `npm test` 104/104 green here; typecheck and check clean. CI was running for 66dfb0a at verification time. The 6.0 refinement is in: a plain-string 400 is retryable within the cap under the same key, a validation list is permanent.
- Filter identity, the point that makes the check meaningful: R-1 counts `social_posts?select=external_id&<PLATFORM_FILTERS[plat]>&published_at=gte.<since>` and `readWindow` reads `social_posts?select=<cols>&<PLATFORM_FILTERS[plat]>&published_at=gte.<since>` plus only `order`, `limit` and the keyset cursor; R-3 counts `social_comments?published_at=gte.<floor><excl>` with `floor = now - (days + 3) days` and the same three `external_id=not.like.<prefix>\_*` exclusions the read uses, built by the same expressions. The only difference is that `since` and `floor` are recomputed in `reconcile()` a few milliseconds after the read, which cannot move a row across the boundary in practice. `countRows` is HEAD with `Prefer: count=exact`, `Range-Unit: items`, `Range: 0-0`, parsing the total from Content-Range.
- Gating: `?reconcile=1` returns the report only with the ingest key or the cron bearer; without either the parameter is ignored and the normal read is served (verified on production: 200 with the ordinary payload, no report), so nothing leaks; `?reconcile=latest` needs a session (401 on production) and is `no-store`; the cron run stores a `reconciliation_reports` row (migration 009: at, days, ok, report jsonb, RLS on, no policies) and answers `reconciled:{ok, checks}`.
- Report content matches PERFORMANCE_RECONCILIATION.md section 2: R-1 posts per platform, R-2 sums, R-3 raw comments, R-4 canonical matches as a lower bound with aliasOnly and twinsRemoved, R-6 unique ids, R-7 the three boundary rules on posts within a day of `since`, R-9 freshness per platform; `ok` is R-1, R-3, R-4 and R-6 together.
- Production: `/` byte-identical (sha256 0f983e16…); health ok, missing []; the trends board was still the 14:27 UTC fetch at 15:11 UTC, so the first 15:15 UTC cron run and the first `trend_snapshots` rows are checked on the next tick.

## Phase 5.1: TREND_FRAMEWORK.md (commit 65ca5f8; docs only, builder's initial values under the delegated gate)

Status: **PASSED with two corrections**, checked for consistency with KYMAH_DATA.md and computability from the tables, not for taste.

- Computable as written: velocity from `trend_snapshots.growth_pct_per_day`; acceleration as the delta between distinct `board_generated_at` values; lead time from `content_pieces.created_at` to the final stage's `approvals.decided_at` (join approvals to `artifact_versions.stage_id` to `stages.kind = 'final'`, decision approved); the `durability` column carries the feed's class. V-AUDIO reads the feed the same way KYMAH_DATA does: `commercialUse.cleared` false vetoes, null is "needs review" (the feed's "never read", not safe), true passes. Gulf relevance is capped because no GCC engagement signal exists, which matches the dictionary's gap list.
- **Correction 1, the seed medians:** section 3.4 seeds end of life with "flash about 4 days, ongoing about 10 days". Measured on the board history by distinct board dates (the rule KYMAH_DATA now states): flash n 56, median 3.0, mean 4.7; ongoing n 76, median 6.5, mean 8.3. Use the medians (3 and 6.5) or say the seeds are means; 10 for ongoing matches neither.
- **Correction 2, cold start:** `trend_snapshots` history begins on 2026-10-21, so "first seen" and "days on board" for every trend already on the board are too small until a backfill, and the lifecycle stage rules in 3.2 (days on board <= 2 means emerging) would call current trends emerging. Either backfill first-seen per trend id from the 28 boards in the Trend Radar git history, or state the cold start and suspend the stage rules until a trend has been seen on two distinct boards.

## Phase 5.2 to 5.4: trend profiles, veto-then-score engine, reproducible scores (commit b336851, log 20066c7; released; migration 010 applied; 5.1 corrections applied)

Status: **PASSED** by checker for the code, with four notes (one small bug, none blocking). The first live scoring run happens on the next hourly refresh; the checker cannot read `trend_scores` (service role only, no session), so the builder reads the first run's rows with its connection string and reports status counts and any `inputs.judgeError` texts.

- Tests: `npm test` 114/114 green here; typecheck and check clean; CI green on both branches for 20066c7.
- 5.1 corrections confirmed in code: `SEED_STAY_DAYS` flash 3, ongoing 6.5 (the checker's medians by distinct board dates, cited in the source); lifecycle is `unknown` with momentum 5/10 until a trend has two distinct boards; `scripts/backfill-trend-history.mjs` seeded the snapshots from 27 historical boards (842 rows, plus today's 38 = 880).
- `signals.js`: `boards()` collapses hourly fetches to one point per `board_generated_at`; velocity is the latest `growth_pct_per_day`, acceleration the delta to the previous board; the lifecycle rules, timing (end of life = first seen + class median stay, post-by = end of life - lead time, lead time flagged as assumed until five approved pieces exist), momentum and calendar scores, and `finalScore` normalised over the criteria that have a value with `historical` inactive are as the framework states. Deterministic vetoes: `cleared:false` vetoes, null needs review, expired end of life vetoes, infeasible class vetoes, missing id is a data veto.
- `engine.scoreOne`: vetoes (deterministic plus the judgement's safety, culture, origin and explicit-audio verdicts) are computed before the criteria; status is vetoed, needs_review, scored or unjudged; a vetoed row keeps its inputs; `final_score` only for scored. `cachedJudgements` keys on `board_generated_at` and `prompt_version`, so a second hourly run on the same board makes no model calls (test: only the failed trend is retried).
- `judge.js`: structured output through `output_config.format` of type `json_schema` (the current Messages API shape; `output_format` is deprecated), model `claude-sonnet-5-5`; `validateJudgement` re-checks the answer (scores of 6 or more need evidence, a veto needs evidence); `enforceCaps` holds Gulf at 7/medium without Gulf evidence, a non-catalog product at 4, none at 3. The system prompt and the user turn label the computed numbers as read-only facts; the model is never asked to compute.
- V-EXPIRED fires only when the estimated end of life has passed; a passed post-by date with life left is "late" and scores momentum 2/10. Accepted: with a 6.5-day median stay and a 5-day assumed lead time a veto there would empty the board and hide the real constraint, which is lead time.
- Baseline curation untouched: `claudeCurate`/`ruleCurate`, `trends_cache.curated` and the default `/api/trends` answer are unchanged (production: count 10, curatedBy claude, cache hit).
- Production: `/` byte-identical (sha256 0f983e16…); health ok; `?view=scored` 401 without a session.

Notes for the builder:

1. **Small bug, operator precedence in `scoreBoard`:** `judged < maxJ && process.env.ANTHROPIC_API_KEY !== undefined || opts.judge` parses as `(judged < maxJ && key set) || opts.judge`, so with an injected judge the `maxJudgements` bound is bypassed. Intended: `judged < maxJ && (key set || opts.judge)`. Production is unaffected today.
2. **`max_tokens: 4000` on a model that thinks by default.** On Sonnet 5.5 adaptive thinking is on unless configured and its tokens count against `max_tokens`; a long profile plus thinking can hit the cap and come back as a truncated text block, which the validator reports as malformed JSON. Raise `max_tokens` (16000 is the usual non-streaming default) and set `output_config.effort: 'low'` for this classification-style call; also treat `stop_reason` `max_tokens` and `refusal` as named failure texts so the first live run is diagnosable.
3. **Score scale.** With `historical` inactive the weights sum to 95, and `finalScore` normalises missing criteria onto 95, so a perfect trend scores 95.0, not 100. Either state "out of 95 until the historical criterion activates" on the page, or normalise to 100 and say so in the framework.
4. **Effect of V-AUDIO on today's board, for the owner:** of 38 trends, 9 carry no sound, 16 are cleared, and 13 are flagged not cleared by TikTok, so V-AUDIO alone hard-vetoes 13 of 38 before any judgement. That is the framework's rule as written; the owner's open question 3 (whether null should veto) matters less than whether `false` should veto outright or go to review.

## First live scoring runs and their fixes; Phase 5.5 and 5.7 (commits f2ba829, 4656167; log 7899794; released)

Status: **PASSED** by checker for the code; the 18:15 UTC run is the first real test of the judgement call, which the builder reads and reports.

- First live runs (builder's reading of `trend_scores` with the service role, 16:15 and 17:15 UTC): 38 rows each, vetoed 28, unjudged 10, scored 0, every judgement attempt failing with the same 400 from the API: `output_config.format.schema: For 'integer' type, properties maximum, minimum are not supported`. The vetoes were V-EXPIRED (most) and V-AUDIO (13).
- Fix 1, the schema: the integer bounds are gone from the API-facing schema (prompt version `profile-v1.1`), `validateJudgement` still enforces 0 to 10, and a regression test asserts the schema carries no `minimum`/`maximum`. Checked against the structured-outputs reference: numerical constraints (`minimum`, `maximum`, `multipleOf`), string length constraints and recursive schemas are not supported, while `$ref`/`$defs`, `enum`, `anyOf`, `allOf` and `additionalProperties:false` are. So the builder's open question is answered: the schema's `$ref` to `$defs` is a supported shape and the 18:15 run should get past validation. Note for later: the SDK strips unsupported constraints only on `messages.parse()`; raw `messages.create()` sends the schema as is, which is why the first run failed.
- Fix 2, expiry: `signals.timing()` now uses conditional survival for a trend still on the latest board (median of the historical stays that outlasted its age, at least 10 samples from Maistro's own snapshots), else the class median or at least one more day; a trend that left the board expires at its last board; the basis is stored in `inputs.timing.basis`. The engine passes the per-class samples from `measuredStayDays`. This removes the day-one V-EXPIRED wave the first run showed.
- Checker notes from 5.2 to 5.4 applied: precedence fixed (`judged < maxJ && (key || opts.judge)`), `max_tokens` 16000 with `output_config.effort 'low'`, `stop_reason` named in failure texts (early stop and malformed JSON), final score normalised to 100 over the active weight (framework section 2 updated), V-AUDIO lever logged for the owner.
- 5.5: the scored board on the Trends page (ranked cards with rank, score, lifecycle, post-by or LATE, product mapping with catalog flag, confidence; rejected and needs-review tabs; filters; an honest empty state before the first run) is covered by `tests/page/states.test.js`; `?view=scored` now also returns `scoreId` for decisions.
- 5.7: POST `/api/trends` records a `trend_decisions` row (session required, live member re-check); decisions pick, skip, reject, override_veto, override_score; reject and overrides need a reason code from a fixed list plus written text; member identity when signed in. Covered by `tests/trends/engine.test.js`.
- Tests: `npm test` 117/117 green here; typecheck and check clean; CI was running for 7899794 at verification time. Production: `/` byte-identical (sha256 26c28693…); health ok; `?view=scored` 401 and POST `/api/trends` 401 without a session; the default feed unchanged (count 10, cache hit).

## H-4 signed-URL rendering and Phase 6.1 (a) knowledge base (commits 555e440, d4b4098, c8d816c; released; migration 011 applied)

Status: **PASSED** by checker, with official platform-spec values fetched for the builder to replace the unverified ones, and a note on the caption counts.

- Tests: `npm test` 122/122 green here; typecheck and check clean; CI was running for c8d816c at verification time.
- H-4: `mediaAttrs(artifact, key)` renders `data-asset` plus `data-fallback` and no provider `src` when an `assetPath` exists, else `src` as before; `hydrateAssets` runs on every `route()` render and on `studioRefresh`, marks elements hydrated, signs each path once through GET `/api/jobs?asset=` and caches the URL until two minutes before expiry, falling back to the provider URL on a failed sign; QC assets carry `assetPath` and `_jobs.js assetUrlFor()` signs the stored copy at submit (path regex enforced), with the provider URL as fallback. Production: `/` byte-identical (sha256 225173aa…), `/api/jobs?asset=` 401 without a session.
- 6.1 (a): migration 011 creates `kb_documents` (append-only versions, one active per kind and key, member read policy), `prompt_registry`, `generation_records` and `creative_specs`. `api/_kb/index.js` reads the active documents with a five-minute cache and falls back to the seed; `putDocument` appends a version and deactivates the previous; `seedMissing` is idempotent. `hermes.js` and `director.js` build their system prompt per call from `brandPrompts()`, and the test asserts the seed reproduces today's `PRODUCTS_PROMPT` and `BRAND_PROMPT` byte for byte, so behaviour is unchanged until someone edits a document. Every document carries a `source`; catalog fields without a source are null with explicit gaps; the three `_candidates` (Watch Ultra2, Z Fold8 Ultra, Tab S12 Ultra) sit in a separate document marked hashtag-only evidence, not catalog entries. `/api/kb` GET 401, PUT 401 and seed 401 without a session on production.
- Caption counts: the checker's recount on the public sentiment snapshot (187 posts between 2026-09-25 and 2026-10-20, matching product names or their hashtags) gives Fold8 95, Frame 21, Tab S12 14, Buds4 Pro 12, Laundry Combo 8, Watch9 7, candidates 7 / 3 / 14, versus the builder's 31 / 17 / 7 / 10 / 6 / 4 and 4 / 3 / 7. The rule differs (hashtag-inclusive versus literal name, snapshot rows versus table rows), the ranking is the same under both, and the seed should state its counting rule the way KYMAH_DATA now does.
- Platform specs, official values fetched by the checker (ad specifications from the platforms' own ads guides; organic posting limits such as the 2200-character caption remain unverified):
  - TikTok video ads (`ads.tiktok.com/help/article/video-ads-specifications`): vertical 9:16 at 540 x 960 or more, horizontal 16:9 at 960 x 540 or more, square 1:1 at 640 x 640 or more; .mp4, .mov, .mpeg, .3gp, .avi; 500 MB or less; up to 10 minutes; bitrate 516 kbps or more; safe-zone files provided separately for LTR and Arabic RTL.
  - Instagram Reels ads (`facebook.com/business/ads-guide/update/video/instagram-reels`): 9:16, recommended 1440 x 2560, MP4 or MOV, 4 GB, 0 s to 15 min, constant frame rate required, primary text 44 characters, minimum width 250 px under 30 s and 500 px at 30 s or longer.
  - Instagram feed video ads (`.../instagram-feed`): MP4, MOV or GIF, 4 GB, 1 s to 60 min, primary text 125 characters; the page lists 9:16 with 1920 x 1080, which contradicts itself, so confirm in the ad tools.
  - Instagram Stories ads page answered 404; the TikTok Business Help Center article for organic specs could not be reached either.

## Phase 6.1 (b): generation records, prompt registry, structured rejection reasons, verified ad specs (commit f91ca52, log b3d928b; released; migration 012 applied; 25 document versions reseeded)

Status: **PASSED** by checker.

- Tests: CI green on both branches for b3d928b (the committed suite, 125/125). The checker's local run showed 126 tests with one failure in `tests/api/spec.test.js`, which is the builder's uncommitted Creative Spec work in progress in the shared checkout (untracked `api/_spec.js` and `spec.test.js`, modified `decisions.js`, `pieces.js`, `_jobs.js`), not a regression in f91ca52. From here on the committed suite is read from CI and local runs serve the review only; the checker never touches the builder's working files.
- `api/_records.js`: `registerPrompt` once per instance with `on_conflict name,version` and ignore-duplicates; `recordGeneration` best effort, logs and returns null on a write failure, never throws; kinds claude, higgsfield_image, higgsfield_video, f1x8, trend_judge; `recorded()` wrapper classifies refused and timed-out outcomes.
- Wiring: `hermes.js` and `director.js` register their prompt template with placeholders, store the resolved prompt (system plus user turn), and record success, failure and timeout around `messages.create`; `judge.js` records every outcome including early stop, malformed JSON and validation failure with the problems; `_jobs.js` records render and F1X8 outcomes through `jobRecord` (refused on nsfw, timed_out on timeout, output assets with assetPath, sha256 and versionId; input assets; correlation id).
- Rejections: migration 012 adds `approvals.reason_code`; `decide()` stores the code on rejections and `listPieces` returns it as `decision.reasonCode`; the page loads the rejection taxonomy from GET `/api/kb?kind=rejection_taxonomy` with a seed fallback, `openReject` offers stage-specific codes and `confirmReject` sends the code.
- Seed: the four platform-spec documents carry an `ads` block marked verified with the official URLs the checker fetched and an `organic` block still unverified; the 21 catalog entries state the counting rule (distinct captions deduplicated on text, product name only, hashtags not counted) beside the checker's name-or-hashtag counts.
- Production: `/` byte-identical (sha256 4a588ff6…); health ok; `/api/kb?kind=` 401 without a session; default feed unchanged.
- Note, not blocking: every record stores the full resolved prompt (up to 60 KB) including the brand and catalog text that repeats on every call; a hash of the resolved prompt plus the prompt and knowledge-base versions would reconstruct it and keep the table small. Worth doing before volume grows.

## Phase 6.1 item 5: the Creative Spec; records keep the user turn plus fingerprints (commits 9dbf771, 5142f27; log 5532d15; released)

Status: **PASSED with one likely production bug** in the change detection, which the fake database cannot show.

- Tests: CI green on both branches for 5142f27; the checker's local run is 126/126 now that the working tree is clean; typecheck and check clean. Production `/` byte-identical (sha256 4a588ff6…), health ok, default feed unchanged.
- `api/_spec.js`: `buildSpec` derives the piece head (trend, angle, platforms, markets, inferred languages, products, key message) and per-stage `state`, `current`, `approved` and `lastRejection` from the store, with payload summaries rather than payloads; `syncSpec` writes a `creative_specs` row only when the derived JSON differs from the latest stored one and records the member and a note; synced after pieces POST, after decisions and after render completion in the job service, each wrapped so a failed sync never fails the request.
- Records: `resolved_prompt` now holds the user turn only; `params.promptSha256` and `promptChars` cover the full text and `params.kbFingerprint` names the active brand and catalog documents (ids, versions, seeded marker) through `kb.brandPrompts()`, so the full prompt is reconstructible from `prompt_registry` plus `kb_documents`.

Likely bug for the builder (not visible in tests):

1. **`syncSpec` compares JSON text, and PostgREST returns jsonb with normalised key order.** Postgres stores `jsonb` with keys reordered (by length, then bytewise), so `JSON.stringify(prev.spec)` read back from the database will generally not equal `JSON.stringify(spec)` built in insertion order even when the content is identical; the comparison then says "changed" on every sync and a new version is written on every pieces POST, decision and render. The in-memory fake keeps insertion order, which is why the "re-sync with nothing new writes nothing" test passes. Compare with a canonical stringify (keys sorted recursively) on both sides, or compare a sha-256 of the canonical form stored on the row. Check `creative_specs` in production after the owner's first click-through: more than one version per piece with identical `spec` confirms it.

## Phase 6.2: moodboard as a visual direction, Soul tile set, automated vision checks, recorded selection (commit 91963f7, log 2d9af1e; released; migration 013 applied)

Status: **PASSED with one design flaw to fix** before the moodboard is used for real.

- Tests: CI green on both branches for 2d9af1e; local 130/130 on a clean tree; typecheck and check clean. Production `/` byte-identical (sha256 00572a5e…), health ok, `/api/studio` POST and GET 401 without a session.
- The jsonb finding is closed: `canonical()` sorts keys recursively on both sides and the test feeds a key-reversed copy of the stored spec (stringify differs, canonical equal, no new version).
- Flow confirmed: POST `/api/studio {action:'mood'}` builds a structured visual direction with Claude (schema; `validateDirection` enforces hex palette, exactly four tiles, no competitor names, prompts of at most 110 words), creates one `higgsfield_image` job with `batch 4`, `autoCheck` and the direction on the job; the adapter sends `batch_size 4`; `pollRender` copies every image into the private bucket and lists `artifact.images[]`; a `vision_check` job is queued on the new version and `runVisionCheck` signs the stored copies, asks the vision model the fixed questions (schema without bounds), classifies hard failures versus "unsure" as needs-review, and writes `stage_checks`; GET `/api/studio?checks=` returns them; the approve modal records the tile selection in `approvals.details` through `decide()`. Flags never remove an image; the human decides. The single-image path stays the 6.10 baseline. Vision checks are generation records of kind claude with prompt name `studio.vision.check`, which is distinguishable enough; no dedicated kind needed.

Items for the builder:

1. **The four tiles are four samples of one prompt.** The handler submits one Soul job with `batch_size 4` using `tilePrompt(d, d.tiles[0])`, so all four images render tile 1's prompt, yet `pollRender` tags image i with `tiles[i].tag` and `expectProduct` is derived from those tags. The direction's four facets are never rendered, the tags on the artifact are wrong for images 2 to 4, and the product check is applied to tiles that were never asked to show the product. Either submit one job per tile (four submits under four idempotency keys, same four images of credit) or tag all four images with tile 1 and derive `expectProduct` from tile 1 alone, and say on the artifact that the set is four variations of one facet.
2. **A long vision call can be claimed twice.** `vision_check` jobs keep `state queued` while `runVisionCheck` runs, and the claim only moves `next_poll_at` forward by 30 s; a vision call is bounded at 90 s, so a second tick can re-claim the same row and run a second model call and a second `stage_checks` row. Set the claim window for `vision_check` above the call bound, or patch the row to `running` before the call.
3. Minor: `max_tokens 4000` on the vision call with a thinking model; the same reasoning as the judge applies (effort is already low), 8000 leaves room for four verbose notes. The mood direction call uses `claude-opus-4-8`; `claude-opus-5-5` is the current Opus at a lower price and would be the default choice unless there is a reason for the older model.

Checker's view of the builder's 6.3 (thumbnail) decisions, for the record:

- Consuming the approved moodboard: agreed, and it must read the selected tiles from `approvals.details.selectedImages`, which item 1 makes meaningful only once the tiles differ.
- Product photo through the v1 reference path: pragmatic until H-1 is redesigned; record `v:1` on the generation and keep the v2 text path as the fallback if v1 is withdrawn.
- Headline as a code overlay rendered in the browser: the composited image must become the stored artifact. If the overlay exists only on the client, the bytes the reviewer approves are not the bytes in the private bucket. Composite in the browser if Arabic shaping needs it, then upload the result through `/api/upload` to the private bucket and record it as the version's asset with its sha256, so the approval binds to the exact bytes that will be posted.
- 9:16 when the piece targets TikTok or Reels only: agreed; 4:5 or 1:1 for Instagram feed; 16:9 only for landscape placements. Always 16:9 today is wrong for both.
- Vision check for product accuracy and consistency with the selected tiles: agreed.

## Phase 6.3 thumbnail; 6.2 items folded in; scoring run lost to the function limit and fixed (commits 218d5d5, 880cde4; released)

Status: **PASSED** by checker. The builder's untested concern about bucket CORS is resolved: Supabase Storage answers `Access-Control-Allow-Origin: *` on both the preflight and object reads for the app origin, so the browser canvas can read a signed URL with `crossorigin=anonymous`.

- Tests: CI green on both branches for 880cde4; local 134/134 on a clean tree; typecheck and check clean. Production `/` byte-identical (sha256 d4a11040…), health ok, `thumb-composite` 401 without a session.
- 6.2 items closed: the set renders a direction-level prompt, every image is tagged "variation n" with `artifact.setMode = 'variations'`, and the product expectation is explicit on the job (`meta.expectProduct`) rather than derived from tile tags; `vision_check` polls at 150 s (above the 90 s call bound) and `runVisionCheck` patches the job to `running` before the call; vision `max_tokens` 8000; studio default model `claude-opus-5-5` for mood and thumb. Hermes, director and trends curation still pin `claude-opus-4-8` for behaviour preservation; the checker's view is to leave them until the 6.10 and 5.9 comparisons, then move them with the baselines recorded.
- 6.3: `moodContext()` reads the mood stage's current version and the reviewer's `selectedImages` and `annotations` (unselected tiles dropped); the thumb prompt call is structured (prompt, textSide, note) with a validator that rejects competitor names and any ask for text inside the image; `aspectFor` gives 9:16 unless YouTube, X or Facebook is targeted (1152 x 2048 on Soul); the product photo goes through the v1 reference path; the overlay box sits inside the stricter of the TikTok and Reels safe zones; the vision check v1.1 receives the selected tiles as anchors and the reserved side, with `consistentWithMood` and `textSpaceClear`; 409 `prerequisites` without a moodboard.
- The hard requirement on the headline is met: "Compose cover" draws the headline on a browser canvas (Arabic shaping and RTL by the browser), POSTs the PNG to `/api/studio {action:'thumb-composite'}`, which writes it to the private bucket with sha256 and size and records a new manual version of the thumb stage with the overlay spec and `baseAssetPath`, so the approval binds to those bytes. Routing through `/api/studio` instead of `/api/upload` is right: the version row and the overlay spec belong in one request.
- Scoring: the 18:15 UTC run judged 18 trends successfully in sequence (all succeeded on `claude-sonnet-5-5`, so the `$ref`/`$defs` schema is honoured; about 14 s per call) and then hit the 300 s function limit before the rows were written, losing the run. 880cde4 judges with concurrency 4 under a deadline derived from the function limit (`startedAt + (MAISTRO_FUNCTION_MAX_S || 300) - 45` s), stores trends not reached as `unjudged` with a "deferred" error for the next run to pick up through the per-board cache, and no longer sends deterministically hard-vetoed trends to the judge. With roughly 25 judgeable trends at 14 s and 4 in flight the run needs about 100 s, inside the budget. The 19:15 UTC run is the first that can complete; the builder reads it.

Minor items for the builder:

1. `thumb-composite` checks only the size of the decoded bytes; check the PNG signature (`89 50 4E 47 0D 0A 1A 0A`) before storing as `image/png`, and validate `baseAssetPath` with the same piece-path regex `assetUrlFor` uses so a version cannot name an asset from another piece.
2. For Phase 10/12 as the builder noted: production logs carry `DEP0169 url.parse` deprecation warnings at error level on `/api/projects` and `/api/sentiment` from a dependency; harmless, to be cleaned up.

## Phase 6.4: the brief as a validated contract (commit 9ede313; released)

Status: **PASSED** by checker. The two 6.3 items are closed in the same commit.

- Tests: CI green on both branches for 9ede313; local 138/138 on a clean tree; typecheck and check clean. Production `/` byte-identical (sha256 ea5453aa…), health ok, `brief` and `brief-edit` 401 without a session.
- 6.3 items closed: `thumb-composite` requires the full 8-byte PNG signature, and `baseAssetPath` must match this piece's own asset path pattern or the request is 422 (test present).
- Brief: `briefContext()` gathers the moodboard with the reviewer's selection, the thumbnail's current version and approval state, the trend's board entry from the cache plus its latest judgement, the catalog entry, the GCC market context, platform rules (defaults per platform, overridden by the knowledge base's `organic.sweetSpotS` and `maxHashtags` when present), the brand voice and the do/don't list. The model answer must satisfy `validateShape()` (every field required, deadline format enforced) or the request is 502 with the problems. `codeChecks()` decides in code: product in catalog, claims mapped to approved wording, duration inside the sweet spot, hashtag limit, named audio cleared, Arabic copy for Gulf markets, mandatories complete, deadline within 14 days. `copyCheck()` is one low-effort Sonnet call for Arabic fluency, moodboard consistency and the trend mechanic, stored with the code checks as a `stage_checks` row of kind copy. Human edits go through `brief-edit`, shape-validated, stored as a manual version with `editedBy`, and re-checked without a rewrite call. The artifact keeps the legacy fields so the board and final prompts keep working. 409 `prerequisites` without a moodboard.
- The builder's three "things to look at" are fine as they are: reading `trends_cache` by the literal key `board` duplicates `CACHE_KEY` in `trends.js` (keep them in step); `Date.parse` on "12 Oct 2026" is safe because the shape check enforces the format first and the realism window tolerates a day; the synchronous copy check adds about ten seconds to a request that stays far inside the function limit.
- Two facts for the owner (not defects): the catalog's `approvedClaims` list is empty for every device, so every brief is written with no claims and any claim a person adds fails the check until the owner supplies approved wording; and moodboard approval is recorded but not enforced before a brief is written, the builder's default pending the owner's say. The new `sweetSpotS` and `maxHashtags` seed fields are not yet reseeded in production, so the platform defaults apply, labelled unverified, until the next reseed.

## Phase 6.5: storyboard as a shot list, one keyframe per shot, anchored checks, per-shot review (commit 4546f1c; released)

Status: **PASSED with one concurrency risk to close** before storyboards are rendered for real.

- Tests: CI green on both branches for 4546f1c; local 141/141 on a clean tree; typecheck and check clean. Production `/` byte-identical (sha256 1dcd66a1…), health ok; `board`, `board-shot`, `board-shot-decide` and GET `?board=` all 401 without a session.
- Consumes only the approved brief and the selected mood tiles: `briefFor()` reads the brief's current version and records its approval state on the artifact (409 `prerequisites` without one); `moodContext()` supplies the direction and the reviewer's selected tiles; the shot list (3 to 8 shots with numbering, type and transition enums, product visibility, bilingual text and lines) is shape-validated (502 with problems), then checked in code for duration within 10 percent of the brief, hook inside 3 s, every brief feature in a product-visible shot, key message, CTA in the last two shots, end card last, product visible; one low-effort model call judges the trend mechanic, hook strength and risks; stored as a `stage_checks` row of kind spec.
- Per-frame prompts carry the anchors: `keyframePrompt()` composes shot type, camera, action, the catalog product line (or the reference-image line on product-visible shots), setting, lighting, styling, wardrobe, palette hexes, camera feel and the no-text, no-logo, no-competitor, no-real-people clause; each job carries the selected tiles as anchors, `expectProduct` per shot, and the hook flag.
- Rendering through the job service: one `higgsfield_image` job per shot with `attachTo {versionId, shot}`; `attachKeyframe()` copies the asset into the private bucket, writes the keyframe into the shot slot on the same version (previous keyframe kept in history, review reset), queues a vision check anchored to the selected tiles plus the previous shot's keyframe with a printed label, and an F1X8 check on the hook keyframe; results never carry `artifact`, so the page's generic poll cannot attach a keyframe as a stage artifact; the stage goes `generating` when jobs are queued and `settleBoardStage()` returns it to `generated` when no render job on the stage is alive; a failed keyframe marks only its shot. Review: per-shot approve (needs a rendered keyframe) or reject (reason required, taxonomy code optional) with an `audit_log` row; one-shot re-render with 409 `busy` while it renders and 409 `approved_immutable` after the stage approval; `decide()` refuses the stage approval with 409 `shots_pending` until every shot is approved.

Item for the builder:

1. **Concurrent keyframe completions can overwrite each other.** `attachKeyframe()`, the failure path and the per-shot review each read the version payload, change one shot and PATCH the whole `payload` back. The tick advances jobs one at a time, but page polls (GET `?id=`) and reconcile-on-open run in separate function invocations alongside the tick, so two shots finishing within the same second can lose one keyframe while its job still reads succeeded. Close it with an optimistic revision on the payload (`payload.rev`, PATCH filtered on `payload->>rev=eq.<seen>`, retry on zero rows, the same pattern as `claim()`), or move shots into their own rows. The fake database cannot show this; the first multi-shot storyboard in production can.

The builder's five "things to look at", checker's view: Soul ID is for characters and would not enforce product consistency, so anchors plus vision judgement is the right tool for now; keyframe prompts should carry a recorded seed (Soul V2 accepts one, the reproducibility requirement of 6.9 needs it, and it costs nothing); the placeholder end card is fine until the logo rules arrive; a whole-board regenerate going through the legacy route is a gap to close in 6.6 as planned; filtering in JS after a bounded read is fine.

## Storyboard race and seed items closed (commit 31aa0c2; released)

Status: **PASSED** by checker. CI green on both branches; local 142/142 on a clean tree.

- `updateShots(versionId, mutate)` reads the version, writes the new payload with `rev = seen + 1`, PATCHes filtered on the id and `payload->>rev=eq.<seen>` (`is.null` for a version without a rev), and on zero rows re-reads and re-applies, up to six attempts with jitter, the same shape as `claim()`; `attachKeyframe()`, the keyframe failure path and `board-shot-decide` all go through it, and the fake database now evaluates `payload->>field` filters so the test runs two concurrent updates from the same revision and both land. The approval is bound to the keyframe job the reviewer saw: a keyframe that changed between read and write answers 409 `keyframe_changed`.
- Every keyframe job carries a seed in SOUL V2's documented range, sent on the V2 path and dropped on the v1 reference path (no documented seed there, recorded but not applied, as the builder noted), stored on the keyframe and in the generation record. Whole-board regenerate goes through the studio action.

## First complete scoring run (19:15 UTC); Phase 6.6 (a) first-draft clips (commit 9c7d995; released)

Status: scoring pipeline **works end to end**; 6.6 (a) **PASSED** by checker.

- 19:15 UTC run (builder's reading with the service role): 38 rows at 19:15:27; scored 1, vetoed 22, needs_review 15, unjudged 0; prompt profile-v1.1, model claude-sonnet-5-5 on every judged row; 25 judgements, 13 hard-vetoed trends skipped; 76 s wall at concurrency 4 (12.4 s average, 17.6 s max), 127,584 input and 41,972 output tokens, deferred 0, far inside the deadline. V-EXPIRED is gone: every row's timing has a conditional-median or evergreen basis. Vetoes: V-AUDIO hard 13, V-UNPRODUCIBLE 9, V-SAFETY 2; needs-review flags: V-CULTURE 16, V-AUDIO unknown lyrics 16, V-ORIGIN 13, V-SAFETY 3. One ranked trend (69.3, peaking, Galaxy Z Flip8, medium confidence).
- Checker's read for the builder, before any rubric change: the rubric's "ambiguous is never safe" plus a feed that carries no origin, lyrics or Gulf signal makes needs-review the honest answer for most trends, which empties the board. Keep the honesty, change the semantics in two places: (1) `audioExplicit` with no lyric evidence should answer pass with low confidence or n/a, not needsReview, because the framework already says lyrics cannot be known from the feed and caps confidence instead; needsReview should require a concrete cue in the name, brief or clips. (2) A trend whose only open flags are culture or origin unsure should still be scored and ranked with confidence forced to low and a visible "review before use" badge, with needs_review reserved for safety and audio. Then build the 5.9 eval set with obviously-fine trends that must come back pass on culture and origin. The 29 of 38 trends held by sound clearance (13 flagged not cleared, 16 unknown lyrics) stay the owner's lever.
- 6.6 (a): CI green on both branches for 9c7d995; local 145/145; typecheck and check clean; production `/` byte-identical (sha256 eba63dd5…), health ok, `draft` and `?shots=` 401 without a session. Confirmed: the clip job names the keyframe by private path, the signed URL is minted once (24 h) at the first submit and kept on the job so every retry sends the identical body under the job-id idempotency key (test asserts it); the image-to-video body is `image_url`, prompt, duration clamped 4 to 30, resolution, `generate_audio`, `bitrate_mode high`, optional `end_image_url`, no `aspect_ratio`, on the `seedance-2.5/image-to-video` endpoint while text-to-video is untouched; clips attach through `updateShots()` in a `clip` slot with its own history and the result never carries `artifact`; no vision or hook check on clips (frame checks come with assembly); the draft is refused with 409 `prerequisites` until every storyboard shot is approved and rendered; shot decisions are generalised by stage; the pieces schema accepts shot-based storyboards. Generation records for Seedance carry `seed: null`, which is correct since the model has no seed.

## Phase 6.6 (b): assembly with bundled ffmpeg (commit b7d1234; released) — CI RED

Status: **FAILED in CI** on both branches for b7d1234 (local 147/147 passes on the Windows ffmpeg build). Two tests fail on the Linux runner: `assemble.test.js` and `assemble-flow.test.js`, both with ffmpeg exiting on `[Parsed_xfade] The inputs needs to be a constant frame rate; current rate of 1/0 is invalid`, so no output is written and the assemble job reports failed. Cause: the trimmed inputs reach `xfade` without a declared constant frame rate on that build; insert `fps=30` (and `settb=AVTB`) on every trimmed video chain before `xfade`, so the dissolve gets constant-rate inputs on every ffmpeg build. Production has the same Linux binary, so a real assembly with a dissolve would fail the same way until this lands; cuts without dissolves are unaffected.

Verified otherwise: `vercel.json` bundles `node_modules/ffmpeg-static/ffmpeg` with 2048 MB memory; `/api/health` reports `tools.ffmpeg: true` from inside the production function; `runAssemble` and `draft-assemble` refuse unless every shot has a rendered clip and an approved review (409 `prerequisites` with the pending list, 409 `busy` while an assemble job is alive); `draft-overlays` validates each PNG like `thumb-composite` (8-byte signature, under 2 MB, shot must exist) and stores it under the piece's draft path, and the assembler reads overlays only from those stored paths; the cut is written with sha256 to the private bucket and recorded on the same draft version through `updateShots` with the assembled record and a `stage_checks` row of kind spec; `assemble` and `clip_check` claim windows (290 s and 200 s) exceed any run inside the function and both patch to running first. Production `/` byte-identical (sha256 a0f54e93…), assembly routes 401 without a session. Migration 014 adds the two job kinds. The judge calibration changes (profile v1.2, review-before-use semantics, the 19:15 run exported as the first eval fixture) are agreed and in progress.

## Assembly CI fix (commit aa4b3e8) — CI GREEN

Status: **PASSED** by checker. CI run 39725365872 is green. On Linux ffmpeg 6.x `setpts` itself resets the output rate to unknown, so `fps` must be the last filter of every shot chain and of each `xfade`/`concat` output (`settb,setpts,fps`). The checker's own attempt (aade19f) put `fps` before `setpts` and stayed red in CI; it was superseded by aa4b3e8. Process note: the checker made a source edit in the shared tree while the builder was offline, which collided with the builder's fix; from here on source fixes go to the builder as findings, the checker commits PROGRESS.md only.

## Trend judge calibration (commit 0e8f494; released)

Status: **PASSED** by checker; the live measurement is the 05:15 UTC run on profile v1.2, which the builder reads.

- CI green; local 148/148; production `/` byte-identical (sha256 65241bfe…), health ok.
- Engine: V-CULTURE and V-ORIGIN needs-review flags are marked advisory; `needs_review` now requires a non-advisory flag, so only safety and audio hold a trend out of the ranking; any hard veto still rejects; confidence is forced to low when `reviewBeforeUse` is non-empty, and `latestScores` exposes it from the stored vetoes; the page shows a "review before use" badge.
- Prompt v1.2: "ambiguous is never safe" needs a quoted concrete cue; absent information lowers confidence instead; `audioExplicit` passes with low confidence unless the name, brief or captions carry an explicit cue; clearance stays in code. The version bump invalidates the per-board cache, so the next run re-judges.
- First eval on the recorded 19:15 run (engine change alone, judgements unchanged): needs_review 15 to 14, ranked 1 to 2, hard vetoes unchanged; at least 10 of the remaining 14 are held only by the v1.1 "no lyrics" audio flag, which v1.2 addresses at the prompt level. The live run will show the combined effect.

## Phase 6.7: QC on the stored cut, located fix plan, priced, sign-off bound to the analysed draft (commit 77779a4; released)

Status: **PASSED** by checker. CI green; local 152/152; production `/` byte-identical (sha256 5864ce08…), health ok, `/api/studio?qc=` 401 without a session.

- The cut is consumed by its stored sha256: action qc refuses without `draft.assembled.{assetPath, sha256}`; the F1X8 job carries the draft version id and the expected hash; `f1x8.submit` hashes the downloaded bytes and fails permanently (409) before uploading on a mismatch (test: tampered bytes, job failed, submit never called); `qc_results` bind to the job's version id, not the stage's current one.
- Sign-off is bound: `decide()` answers 409 `qc_stale` unless the draft stage's current version is the report's `draftVersionId` and its assembled sha256 equals `draftSha256`. The report is one qc version built after `finish()`, so a re-claim cannot build it twice.
- Fix plan: one low-effort model call locates fixes; `normalisePlan()` re-derives each shot from the timestamp on a code timeline (dissolve overlap included), coerces the fix type to the smallest allowed unit per element, and lists uncovered risks and failed checks; costs come from Higgsfield's free `/estimate` per re-rendered shot (deduplicated), text edits cost a re-assembly only, and `audio_swap` is blocked as unpriced because no licensed audio library is connected (owner item). Plan edits are new manual versions with coverage and cost recomputed; send-back is a rejection carrying the target.
- Judge audit baseline (04:15 UTC, profile v1.1, builder's reading): needs_review 15, vetoed 22, scored 1; audioExplicit needsReview 16; 16 needsReview flags quote no real cue. The builder counts a flag as cued only when it quotes a non-null string from the evidence, which is the right test. The 05:15 v1.2 run is the comparison.

## Live effect of profile v1.2 (05:15 UTC run) and Phase 6.8 final (commit f3fa45f; released)

**Scoring, v1.2 live (builder's reading):** 38 rows; 25 judged in 66 s; scored 16, vetoed 22, needs_review 0 (v1.1 at 04:15: 1, 22, 15). Safety pass 23, veto 2, needsReview 0 (was 3); culture needsReview 4 (was 16); origin needsReview 0 (was 13); audioExplicit needsReview 0 (was 16). Uncued flags: 3 (was 16). Top ranked: POV Sudden Betrayal 74.3, Setup line then deadpan punchline 71.7, Upside Down Hand Transition 70.7.

Checker's verdict: the audio and origin swings are the intended effect. **Safety going from 3 needs-review to 0 is an overcorrection risk and should be reversed by rule, not by eval alone:** the cue requirement was meant to stop "unknown" from blocking audio, culture and origin, where the feed carries no signal; for safety the framework's "ambiguous is never safe" is the point. Exempt the safety question from the cue rule (ambiguous safety stays needsReview, with the rationale stated), keep the cue rule for the other three, and add the builder's synthetic must-flag trends to the eval as planned (explicit lyric cue in the sound title, a dangerous-challenge name, a competitor-origin brief, a Ramadan music format), with the two prior safety flags ("chaotic or unhinged" reaction clip, referee-complaint trend) as must-review cases.

**6.8 final: PASSED** by checker. CI green; local 155/155; production `/` byte-identical (sha256 420f698f…), health ok. The final refuses without an approved QC stage and applies only the plan's included fixes (test: an excluded fix never reaches the Seedance body); it re-assembles from stored assets through the same overlay and assembly path, refusing with 409 `overlays_stale` while an overlay is stale or a re-rendered clip is unapproved; untouched shots keep the identical clip object (same asset path and sha256), and an unchanged plan reuses the draft cut as is. Verification runs F1X8 on the stored final cut with the expected hash, then answers every original risk (a skipped risk is recorded as not resolved); the per-shot diff is computed in code. The final approval keeps the existing two-document gate keyed by the version id, and the delivery package additionally refuses unless both documents are linked to the current final version; the package is a hashed manifest in the private bucket, audit-logged, with seven-day signed links.

## Judge v1.3, guard-rail eval on the cron, audit_log column fix (commits e71c0c3, 9b48975; released)

Status: **PASSED** by checker; the live eval row comes from the 06:15 UTC run.

- CI green; local 156/156; production `/` byte-identical, health ok.
- Profile v1.3: safety keeps "ambiguous meaning is never safe" (needsReview with what a human must check); the cue rule applies only to culture, origin and audioExplicit. This closes the checker's safety overcorrection finding.
- Eval set (`api/_trends/eval-set.js`, 8 cases): must-flag for each question (explicit sound, dangerous challenge, competitor origin, nightclub and alcohol), must-review for the two prior safety flags rebuilt from the recorded evidence, must-pass for two benign trends. The hourly cron runs it once per prompt version when at least 90 s remain after scoring and stores the result in `audit_log` (`trends.eval`), so any prompt change re-runs the eval automatically.
- Bug found and fixed by the builder: since 6.5 the shot decisions, and since 6.8 the package export, wrote `audit_log` with columns that do not exist (`target`, `details`); a best-effort try/catch hid the 400, so no shot-decision audit rows exist in production for that period. The writes now use `entity`, `entity_id`, `after`; the fake database rejects unknown `audit_log` columns with 42703 and the tests assert the rows. Lesson for the remaining phases: a best-effort write should log and also count its failures somewhere visible (the ops phase).

## Phase 6.9 cost control (commit 37e9963; released; migration 015 applied)

Status: **PASSED with two gaps noted.** CI green; local 159/159; production `/` byte-identical (sha256 94a6b6a4…), health ok.

- Priced equals submitted: `buildRequest()` builds the endpoint and body for both `submit()` and `estimateRequest()`, and the test asserts the estimate body deep-equals the submit body.
- `budgetGate()` runs once per render job before its first submit, stores `jobs.estimate_usd`, refuses when spent (succeeded) plus committed (queued or running, already priced) plus this estimate exceeds the cap, and warns at `budget_warn_pct` (default 80); failed and moderated renders do not count because Higgsfield does not charge them; a refused job keeps its estimate for audit with cost 0 on its generation record. Migration 015 adds `budget_usd` and `budget_warn_pct` on pieces and `estimate_usd` on jobs. The default cap is $25 per piece (builder default, owner to confirm); changing it is limited to line managers and admins and audit-logged.

Gaps:

1. **The gate fails open.** A render with no price (the v1 product-reference path, which has no estimate endpoint, or any estimate call that errors) is submitted unpriced and never counts toward the cap. Product-photo renders therefore escape the budget. Either price v1 renders at the most recent observed cost of the same kind, or count them at a fixed conservative figure until Higgsfield prices them.
2. **Parallel jobs can overshoot the cap.** A job's estimate is written only after its own gate check, so storyboard or draft jobs created together and gated in separate invocations (the tick, an inline submit, page polls) each see the others as unpriced. The overshoot is bounded by one batch of shots; acceptable for now, but a reservation (write the estimate before the comparison, filtered on the job row) would close it.

## Phase 6.9: lineage and stage invalidation; budget gaps closed (commit 03d1263; released; migration 016 applied)

Status: **PASSED** by checker. CI green; local 163/163; production `/` byte-identical (sha256 ec2a07ed…), health ok.

- Lineage: every new version records `inputs`, the current version id of each stage it consumes (`CONSUMES`: mood from plan, thumb from mood, brief from mood and thumb, board from brief and mood, draft from board, QC from draft, final from QC and draft). `staleStages()` is pure and walks the stages in order, so staleness carries transitively through the chain with a `via` list. Versions created before migration 016 have no inputs and are never called stale.
- `decide()` refuses to approve a stale version with 409 `stale_inputs` naming the replaced inputs; approved stages stay immutable, so an upstream change needs an admin reopen, after which everything built on it reads stale; the delivery package refuses while any stage is stale; the pieces list and the Studio show "Out of date". The test walks a full reopen, regenerate and re-approve sequence.
- Budget gaps closed: an unpriced render (v1 reference path or a failed estimate call) is charged at the last observed estimate of the same job kind, else `MAISTRO_UNPRICED_USD` ($1.00), with the basis recorded; the estimate is reserved on the job before the piece total is read, so parallel gates count each other (test: two $1.20 renders against a $2.00 cap, at most one goes through; both refused is the safe failure).
- Note, not blocking: a reopened stage that has not yet been regenerated keeps its old version id, so nothing downstream reads stale until a new version lands. That matches "stale means built from a replaced version", but the page could say "upstream reopened" in the meantime.

## Hermes parity, policy refusals, and a release made on red CI (commits 8171252, 64a44a8, 6f2c435; released)

Status: **PASSED now; one process failure recorded.** Production is on 6f2c435 with CI green (runs 39729726123 branch, 39729802929 main); local 165/165; `/` byte-identical (sha256 4f8a33b9…), health ok.

- Hermes parity (8171252): pushes to `/api/ingest` now run the Studio checks through `api/_studio/parity.js`: mood, thumb and board images are copied into the private bucket and vision-checked (product expected on thumb and board when the piece names one); a structured brief gets the 6.4 code checks and a legacy-shaped brief records a failing copy check; a pushed final is copied and analysed by F1X8 bound to its version. A copy that fails (host outside the allow-list, fetch error) is stored as a failing check, never silence.
- Policy refusals (64a44a8): a moderated render triggers one Sonnet call that names the likely trigger and proposes a compliant rewrite, stored on the failed job and shown in the Studio; cost 0; never resubmitted automatically.
- **Process failure:** 64a44a8 reached production with red CI (runs 39729501053 and 39729569021) because the builder's release command continued after the CI wait. Production behaviour was correct; only a test lookup was wrong, fixed in 6f2c435. The builder now releases through a gate script that stops on a red suite, red CI for the exact SHA, a failed deploy, a failed health check or a served-page mismatch. **The script is not committed**: it should live in the repo (for example `demo-ui/scripts/release.ps1`) so the gate is reviewable and survives the session.

## Release gate committed; Phase 6.9 human override (commit 32094de; released through the gate)

Status: **PASSED** by checker, with three hardening notes on the gate. CI green (39730083761 branch, 39730174559 main); local 166/166; production `/` byte-identical (sha256 ea3536ba…), health ok.

- Override: `override-sign` returns a signed upload URL into the private bucket under `pieces/<piece>/<stage>/override-…` (images up to 15 MB PNG, JPEG or WebP; videos up to 200 MB MP4 or MOV; the browser uploads directly because function bodies cap at 4.5 MB); `override` re-reads the stored bytes, checks the type by magic number and the path against this piece and stage, then records a manual version (mood, thumb) or replaces the shot's keyframe or clip in place through `updateShots` with history, `override: true`, the member, and the shot's approval cleared; the same vision or clip check is queued as for generated assets; audit row with the real columns.
- Gate (`demo-ui/scripts/release.sh`): stops on a red local suite, no CI run for the pushed SHA, a red CI run, a failed deploy, health not ok, or a served page that differs from `index.html`; main moves only after CI is green and the deploy only after main.

Hardening notes for the gate:

1. **The deploy ships the working tree, not the SHA.** `vercel deploy --prod` uploads `demo-ui` as it is on disk, so an uncommitted or untracked file there would go to production even though CI tested the commit. Stop if `git status --porcelain demo-ui` is non-empty before the deploy (ignoring `.vercel`), or deploy from a clean `git worktree` of the SHA.
2. **The checks hit `maistro-demo.vercel.app`, not the domain people use.** Check `https://www.ma1stro.com` (or both), and compare the health `revision` to the SHA once health reports it, so the gate proves the new build is the one answering.
3. `git branch -f main` is safe only because the following push is a plain push that refuses a non-fast-forward; keep it a plain push (never `--force`), or use `git push origin rebuild/phase-0-recon:main` directly.

## Release gate hardened; daily Higgsfield price card (commits 10844b6, 73ae564; released through the gate)

Status: **PASSED** by checker. CI green; local 166/166. Both `www.ma1stro.com` and `maistro-demo.vercel.app` report `revision: 73ae564` in `/api/health`, so a release is now provably the build that answers.

- Gate: stops before the deploy if `git status --porcelain` in `demo-ui` (ignoring `.vercel`) is non-empty; main moves with `git push origin rebuild/phase-0-recon:main`, which refuses a non-fast-forward; the deploy passes `MAISTRO_REVISION=<sha>` and the gate requires ok, the released short SHA as `revision`, and a byte-identical page on both hosts. All three checker notes closed.
- Price card: Higgsfield publishes no prices, so the hourly cron records a daily card in `audit_log` (`higgsfield.prices`) from the free `/estimate` endpoint for the bodies the Studio actually sends (Soul V2 at 1 and 4 images at 1080p, image-to-video at 4, 5 and 8 s at 720p and 5 s at 1080p, text-to-video 5 s). The 6.10 cost estimate will be built from it.

## Test database enforces the real check constraints; second silent failure fixed; lineage view (commits 8682f37, 5b1cb07; released through the gate; migration 017 applied)

Status: **PASSED** by checker. CI green; local 167/167; production reports `revision: 5b1cb07`; `?lineage=` 401 without a session.

- `tests/schema-constraints.js` reads every enum CHECK from the migrations in order (a later `alter table … add constraint` replaces the earlier one) and the fake database rejects violating writes with 23514, unknown audit columns with 42703. It found a second silent production failure: `generation_records.kind 'assemble'` was outside the constraint since b7d1234, so every assembly's generation record was refused and only logged. Migration 017 replaces the constraint with `assemble` added; the builder confirmed through `pg_constraint` that it was replaced, not duplicated. Scope limit of the parser: it covers single-line `text … check (col in (…))` enums only; numeric, multi-column and multi-line checks are not enforced by the fake.
- Lineage view: GET `/api/studio?lineage=<piece>` returns the final (else draft) cut and per shot the clip and keyframe with asset, override flag and generation (kind, model, prompt name and version, seed, status, cost), the storyboard line and review, plus the brief, storyboard and moodboard versions with their inputs, every stage's version and inputs, and the piece angle and trend.

## Upstream-reopened state, numeric CHECKs enforced, GOLDEN_SET draft (commit 491e66a; released through the gate)

Status: **PASSED** by checker. CI green; local 168/168; production reports `revision: 491e66a`.

- `stages[k].upstreamReopened` is set when an input stage still holds the version this one was built from but is back in ready, generating or rejected; the Studio shows an "Upstream reopened" note; stale takes precedence once a new version lands; the invalidation test asserts the window. Closes the checker's reopen-window note.
- The checker's independent scan of the migrations finds exactly two non-enum CHECKs (`adlcp_documents.size_bytes > 0`, `content_pieces.budget_warn_pct between 1 and 100`); both are now enforced by the fake, and `tests/api/constraints.test.js` fails when any CHECK in the migrations is neither enforced nor listed as unenforced (the list is empty). Closes the scope note.
- `GOLDEN_SET.md` (draft): 16 trends from history plus 4 owner-supplied Gulf-Arabic slots (history holds no Arabic trends), a rating rubric to agree with the owner, metrics computed in code, and a budget section waiting for the first price card. The checker reviews it once the budget is filled in.

## Profile v1.3 live, eval 8/8, first price card; gate convergence (commits eeef916, 7563547; released)

- **Scores (06:15 UTC, v1.3, builder's reading):** scored 11, vetoed 22, needs_review 5 (v1.2: 16, 22, 0). All five held trends are V-SAFETY; safety needsReview 11 of 25 judged. **Eval 8/8** (all must-flag, must-review and must-pass cases), recorded as `tests/fixtures/judge-eval-v1.3.json`.
- Checker's call on the swing: v1.3 is now too broad on safety in production even though the eval passes, because "the clip content is unseen" is being used as the cue for benign formats (the deadpan caption reveal is a must-pass in the eval yet held in production). Agreed with the builder's v1.4: safety needsReview requires a descriptive cue (chaotic, shocking, extreme, suggestive, conflict, real people in a dispute, minors), "unseen clips" alone is not one; add the production deadpan trend and the POV twist as must-pass, keep the two must-review cases. The eval must include the production false positives, or it will keep passing while production drifts.
- **Price card:** Soul V2 $0.006 per image, $0.023 per set of four; every Seedance estimate failed to parse. eeef916 reads the usd one level down and otherwise fails naming the response keys; the card retries hourly until complete. The budget gate failed closed meanwhile (fallback price), as designed.
- **Gate:** eeef916's release stopped because `www.ma1stro.com` briefly answered `c9204c4`. Correction to the builder's diagnosis: that was not a git deployment from the checker's PROGRESS push; it was the checker's manual `vercel deploy --prod` at the owner's request to apply the new app password and admin e-mails (the owner's explicit instruction, run from the clean tree at c9204c4). 7563547 makes the gate poll both hosts up to three minutes for ok and the released revision before checking the page. Both hosts now answer `revision: 7563547`, and the latest deploy carries the owner's new settings.

## Reconciliation's first live row; cron hardening; judge v1.4 (commits e245565, e0afa14, 7366658, 2a497e2; released)

- **The 06:30 cron did run.** The builder first reported zero rows and blamed the edge cache; the checker pointed out that `/api/trends` is edge-cached the same way yet its cron runs hourly. The real reason: the 60-day read takes about three minutes and row 1 was written at 06:33:25, after the builder's 06:32 query; earlier days had no rows because 7.0 shipped after yesterday's 06:30. The builder corrected REBUILD_LOG. Kept as hardening: the cron has its own URL (`/api/track?cron=1`), and any non-cron request to it now answers 401 `no-store` (probed by the checker from outside); the one-off verify cron was removed in favour of `vercel crons run`.
- **Row 1 is ok:false.** Posts are equal on every platform (tiktok 121/121, twitter 86/86, facebook 111/111, instagram 79/79) and R-6 holds, but R-3 and R-4 failed because the database-side comment counts errored (`count failed (500) for social_comments`): an exact count over 63 days exceeded the tracker database's statement limit, and 40-id chunks did too. Reader side: 12,489 comments seen, 6,366 after twin collapse, 8,348 matched, 1,982 twins removed, match rate 0.668. 2a497e2 counts R-3 in 7-day windows and R-4 in 10-id chunks; any failed piece still fails the check. A cron run on 2a497e2 was triggered at 06:47; its row is the next evidence.
- **Freshness (R-9):** newest posts x and facebook 2026-10-16, tiktok and instagram 2026-10-20; newest comments x 10-18, facebook 10-17, tiktok 10-20, instagram 10-21. The tracker's ingestion lags by one to six days, a known upstream issue for 7.x.
- **Judge v1.4 (e0afa14):** safety needsReview requires a descriptive cue; unseen clips alone are not one. The eval gains two production cases as the judge saw them: the deadpan caption swap as must-pass (a v1.3 false positive), and the POV twist as must-flag on safety. The checker had proposed the POV twist as must-pass; the builder's evidence overrides that: its brief asks for a payoff "as unhinged as the best examples" and quotes a "deadnamed-by-a-friend" caption, which are real cues. Accepted.
- CI green; production `revision: 2a497e2`.

## Phase 7.0 live: reconciliation ok:true (commit bfb79a0)

Status: **PASSED on live evidence** (builder's reading of `reconciliation_reports`, all 60-day windows):

| Row | Time (UTC) | Code | ok | Failing check |
|---|---|---|---|---|
| 1 | 06:33:25 | 06:30 cron, pre-fix | false | R-3, R-4: database count timed out |
| 2 | 06:44:06 | triggered, pre-fix | false | same |
| 3 | 06:49:35 | 2a497e2 | false | R-3 off by one (reader 12,482 vs database 12,481) |
| 4 | 06:56:40 | bfb79a0 | **true** | none |

Row 3's off-by-one was a future-timestamped comment: the last count window stopped at now + 60 s while the reader has no upper bound. bfb79a0 makes the last window open-ended with the same predicate as the reader. Row 4: posts equal on all four platforms (tiktok 121, twitter 86, facebook 111, instagram 79), comments seen 12,477 on both sides, database canonical matches 6,549 at most the reader's 8,348 (1,799 alias-only), unique ids hold; twins removed 1,982, match rate 0.669. The seen count drifts down between runs (12,489 to 12,477) as comments leave the 63-day floor, which is why both sides are read in the same run. Next for 7.x: per-platform "data as of" on the Performance page from `report.freshness`.

## Performance: "data as of" per platform (commit cdf597a; released through the gate)

Status: **PASSED** by checker. CI green; local 169/169; production `revision: cdf597a`. The Performance header shows one "data as of" pill per platform from the newest post or comment actually loaded (`perfNewestByPlatform`), red past 48 h; with today's data X and Facebook show stale (newest 10-16 and 10-17) and TikTok and Instagram fresh. Deriving it from the loaded data rather than the daily report is the better source because the report can be a day old; the two agree today. The page test computes each platform's expected state from the fixture.

## Judge v1.4 live: calibrated baseline; Seedance cannot be priced by /estimate (commit c5ec98d)

- **07:15 UTC, profile v1.4 (builder's reading):** scored 13, vetoed 22, needs_review 3; all three held trends are V-SAFETY with descriptive cues (POV twist, reaction clip with a suggestive handle, "Sey Mami"); the other safety flags sit on trends already vetoed as unproducible. **Eval 10/10**, recorded as `tests/fixtures/judge-eval-v1.4.json`.

| Profile | Scored | Vetoed | Needs review |
|---|---|---|---|
| v1.1 | 1 | 22 | 15 |
| v1.2 | 16 | 22 | 0 |
| v1.3 | 11 | 22 | 5 |
| v1.4 | 13 | 22 | 3 |

  Checker's view: v1.4 is the calibrated baseline. Agreed to freeze prompt changes until the owner reviews the ranked board; any later change must pass the recorded eval and add the production case that motivated it.
- **Price card:** Soul V2 priced again ($0.006 per image, $0.023 per set of four). Every Seedance estimate answers with a pricing type and description but no USD figure, so `/estimate` cannot price video; c5ec98d keeps the provider's pricing text on the card. Until the rule is read, video renders are budgeted at the fail-closed fallback. **Risk:** the fallback is $1.00 per render for every kind, which is likely far below a Seedance clip's real cost, so the per-piece cap under-protects video. Use a kind-specific fallback for video (a conservative per-second figure, written down as an assumption) until the provider's rule is parsed.

## Kind-specific budget fallback for unpriced renders (commit ee77666; released through the gate)

Status: **PASSED** by checker. Unpriced video is budgeted at an assumed $0.50 per second of clip (duration clamped 4 to 30 s, so a 5 s clip counts $2.50 and an 8 s clip $4.00), unpriced images at $0.05 or the last provider-priced job of the same kind; video never reuses another kind's figure; the basis is recorded on every job including refused ones. The assumption is written in CONTENT_STUDIO.md 6.9 and GOLDEN_SET.md section 5. $0.50 per second is a reasonable deliberately high figure until the provider's rule is parsed.

**Consequence for the owner:** under this assumption one piece with about 7 clips of 5 s costs about $17.50 for the draft alone, so a final that re-renders even a few clips can reach the default $25 cap and be refused. The cap and the per-second assumption should be decided together (owner gate item on the per-piece budget).

## Performance accuracy defect: other tracker projects counted as Samsung Gulf (commits cc3f0c1, 7b5810a; released)

Status: **PASSED** by checker, with an amendment to the 7.0 verdict above. Found by the builder while profiling for 7.2.

- **Defect:** the tracker database also holds another project (`ifold_` prefix: competitor and fan accounts, YouTube and news stored under platform twitter). Comments already excluded it; posts did not, and the `*samsung*` post filters let fan TikTok accounts and news URLs through. 22 of 397 posts carried 3,744,594 of the 4,485,721 TikTok views shown, so **TikTok reach on the Performance page was overstated about six times before 2026-10-22**; X carried 13 news rows. The reconciliation passed because both sides counted the same wrong set: **7.0's ok:true proves the reader and the database agree, not that the population is right.** That limit is now part of how 7.0 is read.
- **Fix (cc3f0c1):** the posts read and the reconciliation post count use the comment filter's exact exclusion expression; account names are normalised (leading "@" stripped, account taken from the X or TikTok URL when the owner field is empty). **7b5810a:** the reconciliation counts over the reader's exact window edges, which removes the recurring off-by-one; `/api/sentiment` skips stored rows with the foreign prefixes.
- **Checker's independent check of the served data (60 days):** every platform shows only `samsunggulf`; tiktok 112 posts, 741,127 views; x 73 posts, 278,233 views; instagram 79 posts, 284,333 views; facebook 110 posts; zero foreign rows in `/api/track` and zero in `/api/sentiment` (375 posts). Builder's live rows: row 5 (07:43) posts equal on all platforms after the fix; row 6 (07:51:30) ok:true with R-3 12,415 on both sides.
- **New finding for 7.x:** all 110 Facebook posts report 0 views, so the Facebook views total shows 0. The tracker does not collect Facebook views; the page should say "not collected" for that platform rather than a zero that reads as no reach.

## Reconciliation R-8 (owned accounts only) and Facebook views marked not collected (commit 8582d85; released through the gate)

Status: **PASSED** by checker. CI green; local 173/173; production `revision: 8582d85`.

- R-8: every counted post's `platform:account` (lower-cased, "@" stripped) must be in `MAISTRO_OWNED_ACCOUNTS` (default samsunggulf on tiktok, instagram, facebook, x, twitter); the report carries `population {owned, foreign, sample}` and `ok` now requires R-8. A wrong population now fails the report. Live row 7 (08:09:25, builder's reading): ok:true, R-1, R-3, R-4, R-6 and R-8 all true, foreign 0.
- Facebook: `viewsNotCollected()` marks any platform whose posts never carry views above zero; those zeros stay out of Total views, the KPI says "excludes Facebook (views not collected)", and post lines read "views not collected".

## Video pricing from the provider's own rule (commit af5f558; released through the gate)

Status: **PASSED** by checker.

- The Seedance estimate returns a pricing description instead of a USD figure, identical for every video body: about **$0.2056 per second at 480p, $0.4622 at 720p, $1.1372 at 1080p** for 16:9 video without video input (a token formula is also given). `parsePerSecond()` accepts only that documented phrasing and prices a render as duration times the rate for the body's resolution, with the basis recorded ("provider rule: $0.4622/s at 720p x 8 s"); any other wording falls back to the $0.50 per second assumption rather than guessing. Checker's arithmetic matches the tests: 8 s at 720p = $3.6976, 5 s at 1080p = $5.686. Using the per-second figures rather than the token formula is reasonable; the provider calls them approximate, so the cap keeps its margin. Images unchanged ($0.006 each, $0.023 per set of four). Confirmed live on the 09:15 UTC card (builder's reading): complete:true, every video body priced from the rule (4 s 720p $1.8488, 5 s 720p $2.311, 8 s 720p $3.6976, text-to-video 5 s 720p $2.311, 5 s 1080p $5.686), so the hourly retry has stopped.
- Cost of one full piece (5 shots of 5 s, 2 draft re-renders, 2 final re-renders, images), from GOLDEN_SET.md section 5: about **$20.87 at 720p** and **$51.24 at 1080p**; a 20-piece golden run about $420 at 720p. The $25 default cap leaves about $4 of margin at 720p and refuses any 1080p piece. The builder proposes $30 at 720p and $60 at 1080p; not changed in code pending the owner.

## Twin-collapse audit, step 1: sample recorded by the reconciliation (commit 0b82631; released through the gate)

Status: **PASSED** for this step; the audit itself is open. CI green; local 175/175; production `revision: 0b82631`. The collapse rule is unchanged. The report now stores `twins`: window-wide counts of merged groups and of near-duplicates kept apart (same author with case, punctuation or zero-width differences; a truncated copy; the same text under another author within 10 minutes) and a seeded sample stratified by platform (up to 12 per outcome per platform). Reading the sample needs the service-role connection, which neither session should pull from old transcripts; the builder asked the owner to run the reader. Labelling, the anonymised fixture with labeller attribution, and the false-merge and missed-duplicate rates follow.

## Twin-collapse audit: labelled sample, new message key (commit 35604bd; released through the gate)

Status: **PASSED** by checker. CI green; local 177/177; production `revision: 35604bd`. The owner's saved file is deleted.

- Population (09:24 report, 60 days, 8,332 matched comments): the old exact-text rule merged 301 groups (1,979 rows removed) and kept apart 947 near-duplicate pairs (320 punctuation or case, 419 one text extending the other, 208 same text under another author); TikTok had none.
- Labelled sample of 72 (36 merged, 36 kept apart, stratified over Facebook, Instagram and X), labelled by the builder session on a written rule, committed as `tests/fixtures/twin-audit-2026-10-22.json`. Checker's check of the fixture: every handle is tokenised (`@u…`) except `@SamsungGulf`, no comment ids remain, one employee's name is redacted.
- Old rule: 0 false merges of 35 verifiable groups; **23 of 36 duplicate pairs missed** (all 14 punctuation-only, 9 of 14 extensions such as emoji, mentions or a repeated paste). The premise that twins are storage duplicates did not hold: none of the merged groups had mixed id forms; they are mostly re-posted giveaway entries.
- New `messageKey` (server) and `sentiKey` (page), kept in step by a parity test: the author plus the message with punctuation, symbols, emoji, marks, mentions, whitespace and case removed and a repeated paste folded; emoji-only text keeps its exact form; blank text never merges. On the sample: 0 false merges, 0 missed. The 402-row golden moves from 374 to 373 with the reason in the test.

Caveats for the owner:

1. **The labels are the builder's (a model), not a person's.** The fixture says the owner may re-label any disputed case; a human spot-check of the 72 is advisable before the rates are quoted.
2. **Definitional choice:** most merged groups are the same person re-posting a giveaway entry. Collapsing them counts people, not entries, which lowers comment totals on giveaway posts. That is the right reading for sentiment, but if comment volume is reported as engagement, the uncollapsed count should be shown alongside.

## Owner's budget caps live: $20 at 720p, $50 at 1080p (commit 8b4b06d; released through the gate)

Status: **PASSED** by checker, with one loophole to close. CI green; local 178/178; production `revision: 8b4b06d`. A piece's own cap (set by a line manager or admin) wins; otherwise the default follows the piece's resolution ($20 for 720p, $50 once any of its video jobs is 1080p), env-overridable; warning at 80 %. The budget view reports the cap's basis; a refusal names the cap, its basis and how to raise it; the page gained a "Set cap" control (role check stays on the server). The sizing assumption is written in GOLDEN_SET.md and CONTENT_STUDIO.md, including that the 5-shot golden-set pieces exceed the defaults and need their caps raised for that run.

Loophole: the 1080p default applies as soon as one 1080p video job exists on the piece, and the job under consideration is itself counted. A 720p piece that has reached its $20 cap can therefore request a 1080p render and jump to the $50 cap. Decide the resolution from the piece's setting (or from its first video job) rather than from any job, or require a line manager or admin to switch a piece to 1080p.

## Cap loophole closed; collected comments shown beside the collapsed count (commit 09c88b8; released through the gate)

Status: **PASSED** by checker. CI green; local 179/179; production `revision: 09c88b8`.

- A piece's resolution is now its first video job's, so a 720p piece cannot reach the $50 default by requesting a 1080p render; the test refuses a 5 s 1080p clip on a 720p piece with $19 spent at $24.69 of its $20 cap (checker's arithmetic: 19 + 5 x 1.1372 = 24.69). Moving a piece up goes through "Set cap" by a line manager or admin.
- Every `/api/track` post carries `commentsCollected` (rows stored before the collapse); the page shows "N comments analyzed · M collected" when they differ. Checker's independent count on production (14 days): 88 posts, all with the field, 200 collected, 192 after collapse, and no post with more collapsed than collected.

## 7.0 closed: the 14-day / 60-day merge keeps everything (commit 7a26881; released through the gate)

Status: **PASSED** by checker. CI green; production `revision: 7a26881`. The page used to replace its 14-day read with the 60-day read whenever the latter had at least as many posts, so a partial 60-day comment page could drop comments. `sentiMergeWindows()` now keeps every post from either read; a post in both takes the later read's metrics and the union of comments. The golden test covers the checker's two edge cases, single-read posts and both fetch orders; the builder's live comparison found 88 of 88 posts present, no metric differences and no comments lost.

## Phase 7.2 benchmarks (commits 042aa39, b1ec22d; released through the gate); docs commit af4ada7 outside the gate

Status: **PASSED** by checker.

- CI green for 042aa39 and b1ec22d on both branches; local 186/186; both hosts report `revision: b1ec22d`.
- `GET /api/track?benchmarks=1` (computed by `api/_perf/benchmarks.js`): per platform and format, age-banded nearest-rank P25, median, P75 and P90, no means; percentiles only at n of 20 or more, counts below; ER only where views are collected and at least 500; Instagram engagements are likes plus comments (shares never collected), labelled; raw share zeros kept as `sharesRaw`. Checker's independent nearest-rank on 1..10 gives 3, 5, 8, 9 and on 1..20 gives 5, 10, 15, 18, matching the module. The live route answers 200 and shows "no recent data" for the stale platforms.
- Giveaway pattern (b1ec22d): requires prize-entry wording; the builder's hand-read of 732 live captions found 3 false positives and 2 misses in the first pattern, corrected; the false-positive lists in both languages are tested; a suspected giveaway stays in the organic cell until a person confirms it.
- Live benchmarks (10:09, builder's reading): TikTok ER median 6.91 % (n 114), Instagram video 4.19 % (83), X video 1.08 % (53), Instagram image engagements median 98 (37), Facebook engagements median 66 (177). No young age band has reached n 20 yet, so mature rankings are labelled "not boost advice".
- **Process note:** af4ada7 (PERFORMANCE_INSIGHTS.md only) reached main by a plain push instead of the gate. Checker's verification: the CI workflow is path-filtered to `demo-ui`, so a root docs commit triggers no run by design; no deploy happened (both hosts still answer b1ec22d). Harmless, recorded so the rule stays: everything goes through the gate.

## Benchmark panel and per-post standing; headline engagement is a median (commit dadc7a1; released through the gate)

Status: **PASSED** by checker, verified independently because the builder's own checks are blocked: CI run 39763479605 green; both hosts report `revision: dadc7a1` and serve a page byte-identical to `index.html`.

- The panel shows the server's cells exactly as computed (no statistic derived in the browser): n and P25, median, P75, P90 for mature organic cells; "n < 20: count only" below that; the count excluded for views under 500; young-band counts with their expected dates; giveaways counted separately; a line saying "a benchmark, not boost advice". Each post shows one standing line or why it is not ranked, and a suspected-giveaway note to confirm.
- A further breach of the no-means rule fixed: the headline "Avg engagement" was a mean over every post including those under 500 views; it is now "Median engagement", nearest-rank over posts with at least 500 views, with the count shown.

## Phase 7.1: Decisions strip, comments marked handled, product sentiment labelled (commit e685a60; released through the gate)

Status: **PASSED** by checker, verified independently: CI run 39764367563 green; both hosts report `revision: e685a60` and serve a page byte-identical to `index.html`; the handled routes answer 401 without a session (GET `?handled=1` and POST `comment-handled` on `/api/sentiment`).

- Role: marking a comment handled is allowed to reviewer, line manager and admin (server-side; a viewer gets 403). This is a builder ASSUMPTION flagged to the owner: no "responder" role exists, and adding one needs a migration and an ADR-003 amendment. Under the shared password the mark records "password session (no member sign-in)", so anyone with the password can mark until member sign-in is enforced.
- Key: post id without the platform prefix, the author lower-cased, and the twin-collapse message key (blank text keyed by time), so a re-collected or twin copy stays handled; a page/server parity test covers the variants.
- Append-only: each mark or undo is an `audit_log` row (`comment.handled` or `comment.unhandled`) with who, when and an optional note; the newest row per key is the state; ordered by identity id. Note: the state read takes the newest 5,000 rows, so after 5,000 handled events older marks fall out of view; move the state to its own table or page the read before volume reaches that.
- Product sentiment is labelled "mapped from caption text" with the unmapped share and each device's analysed count.
- The Decisions strip covers Respond (flagged and handled counts), Boost (not yet supportable, with the earliest expected date), Mix, Product and Trust (stale platforms listed).

## Stop and product-by-market cards; handled read in full; Phase 7.3 sentiment quality (commits d5eaf57, 37f06cd; released through the gate)

Status: **PASSED** by checker, verified independently: CI green on both commits and branches; both hosts report `revision: 37f06cd` and serve a page byte-identical to `index.html`.

- d5eaf57: the Decisions strip gains "Stop" (mature organic posts below P25 of their own cell, labelled a benchmark) and "what works for which product and market: not yet supportable, needs 7.5 attribution"; the handled state now pages through every row (test: a mark older than 2,500 later events stays handled; the fake caps reads at 1,000 rows like Supabase); every comment carries `sentimentSource`.
- 37f06cd, the audit: 200 comments sampled (20 per language bucket and label source) out of 6,067, labelled blind (text only, reshuffled, stored labels joined afterwards), authors tokenised, no ids, two named people redacted. Checker recomputed the Wilson 95 % intervals: tracker 84/100 = 0.756 to 0.899 (0.90 weighted by bucket share), keyword fallback 43/100 = 0.337 to 0.528 (0.638 weighted); both match. Tracker by bucket: Arabic 13/20, Arabizi 17/20, mixed 17/20, English 18/20, emoji 19/20; its main error is neutral comments called positive, mostly giveaway entries. Arabic, Gulf, Arabizi, mixed and sarcasm results are marked as needing a native speaker's check.
- **Product change (builder default):** the keyword fallback is dropped; comments without a tracker label show "NOT ANALYSED" and are left out of every rate. Checker's count on production over 60 days: 1,975 comments tracker-labelled, **4,092 not analysed (67 %)**. In the 7-day default view about 96 % are labelled. Cause, read-only in the tracker repo: the sync labels 500 comments a day, newest first, from the last 30 days only (coverage 96 % under 7 days, 81 % at 7 to 14, 51 % at 14 to 30, 30 % beyond). Consequence: 60-day sentiment rates rest on about a third of the comments, weighted toward recent ones; the page states the analysed count. The fix (backfill with a cost estimate first, separate corpus caps, prompt changes, a native re-label) is a proposal in PERFORMANCE_INSIGHTS section 3, no change to the tracker repo.

## [GATE] Owner items (only the user can do these)

1. **Supabase Auth redirect** (new, from 4a2af0e): in the Supabase dashboard, Authentication, URL Configuration, set the Site URL to `https://www.ma1stro.com` and add `https://www.ma1stro.com/` to the redirect allow-list. Then open www.ma1stro.com, enter your e-mail, click "Email me a sign-in link", and follow the link once: your address is in `MAISTRO_ADMIN_EMAILS`, so that first sign-in creates your admin membership. This closes the "login works" half of M2.
2. **Click-through for the database half of M2:** while signed in, create one Studio campaign; the builder confirms it in the database.
2b. ~~Per-piece budget~~ **decided by the owner on 2026-10-22: $20 per piece at 720p, $50 at 1080p** (warning at 80 %), sized for an average video of 10 to 15 s (replaces the owner's first answer of $10 and $20). Basis: a 15 s piece generates about 35 s of video including four re-rendered clips, about $16.18 at 720p and $39.80 at 1080p, plus about 20 % headroom. Implementation handed to the builder. **Live in 8b4b06d.**
2f. **Sentiment coverage** (from 7.3): over 60 days two thirds of comments have no tracker label, so the page leaves them out (the keyword fallback was 43 % accurate). Decide whether to fund a labelling backfill in the tracker (proposal and cost in PERFORMANCE_INSIGHTS section 3), and arrange a native Arabic speaker to check the Arabic, Gulf, Arabizi and sarcasm labels.
2e. **Who may mark comments handled** (from 7.1): today reviewer, line manager and admin. Say whether to add a dedicated responder role instead.
2d. **Twin-collapse sample** (from 0b82631): run the reader the builder gave you so the duplicate-comment audit can be labelled.
2c. **TikTok reach was overstated** on the Performance page before 2026-10-22 (about six times, from another project's fan and news accounts in the tracker). Any figure taken from the page before that date should not be reused.
3. **Licensed audio library** (from 6.7): QC fixes of type audio swap stay blocked until a licensed audio source is connected.
3b. **Approved claims and mood approval policy** (from 6.4): supply the approved claim wording per device for the product catalog (every list is empty today, so briefs carry no claims), and say whether a brief may be written before the moodboard is approved (recorded but not enforced today).
4. **After the team is invited** (Members entry in the sidebar, admins only): set `MAISTRO_REQUIRE_MEMBER=1` on Vercel so decisions need a member session, and later unset `MAISTRO_APP_PASSWORD` to retire the shared password. (Turning off public sign-ups in Supabase Auth is now optional: since cd8e9e4 the login page only requests links for members and bootstrap admins.)
5. **App password and admin e-mails** changed on 2026-10-22 at the owner's request (password set by the owner; `mohamedymay7@gmail.com` added to `MAISTRO_ADMIN_EMAILS`). The owner to confirm the new password works at www.ma1stro.com.
5b. **Rotate the pasted secrets** (from 7b50e15): the database password, the anon key and the service-role key were pasted in chat. Reset the password (Supabase, Project Settings, Database) and rotate the keys when convenient, then re-add with `vercel env add`. Hygiene, not an outage.
6. ~~Vercel plan decision (Q-002)~~ answered 2026-10-21: the project is on Pro; the hourly trends cron is live and M3 has started.
7. ~~Supabase connection string and anon key (Q-006)~~ answered 2026-10-21; migrations applied.

## For the user to know (no action required unless you disagree)

- **Manual step from M1:** connect the GitHub repo to the Vercel project (Vercel dashboard, project settings, Git) and add the preview environment variables, so previews get real config and releases stop depending on a developer's working tree. Details in `REBUILD_LOG.md`.
- **App password:** the interim login password lives only in Vercel env; neither session has it, by design.

- **M1 changes how releases happen:** production deploys move from the CLI working tree to git-connected Vercel with previews (ADR-009).
- **ADR-003 roles:** the builder's proposal stands until you amend it.
- **State lives only in browser localStorage** (key `maistro-gen-v2`) for studio campaigns, approvals, rejections and the ADLCP attachment (file name only, no bytes). Flagged Critical, assigned to the Phase 1 audit.
- **`vercel env pull`** is blocked for the builder session, so production credentials stay out of reach there by design.
