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

Status: **PASSED** by checker, with the first real cron run still to observe (next run 15:15 UTC).

- Tests: `npm test` 92/92 green here; typecheck and check clean. The new test covers the raw-miss storing no curation, the next curated hit curating once and writing back with the row's `fetched_at`, and the cron refreshing unconditionally. CI queued for 8f24ffe at verification time; the M4 run before it passed.
- `vercel crons ls` on the linked project lists both crons: `/api/track` at 06:30 daily and `/api/trends` at 15 past every hour. The deploy carrying an hourly schedule was accepted, which only Pro allows, so the plan question Q-002 is closed by the deploy itself.
- Cron path: `isCron(req)` (bearer `CRON_SECRET`) refreshes the board and curation unconditionally, writes the row, answers `{ok, refreshed, source, boardTotal, curated, curatedBy, at}` with `no-store`, and marks the row's `error` on failure. A forged bearer and a `vercel-cron` user-agent alone both fall through to a normal cached read on production (verified), so nobody outside can force curation calls.
- Cache fix: a raw (`?all=1`) miss now stores `curated: []`; a later curated hit with an empty curation curates once and writes it back keeping the original `fetched_at`; a stale hit never rewrites.

## [GATE] Owner items (only the user can do these)

1. **Supabase Auth redirect** (new, from 4a2af0e): in the Supabase dashboard, Authentication, URL Configuration, set the Site URL to `https://www.ma1stro.com` and add `https://www.ma1stro.com/` to the redirect allow-list. Then open www.ma1stro.com, enter your e-mail, click "Email me a sign-in link", and follow the link once: your address is in `MAISTRO_ADMIN_EMAILS`, so that first sign-in creates your admin membership. This closes the "login works" half of M2.
2. **Click-through for the database half of M2:** while signed in, create one Studio campaign; the builder confirms it in the database.
3. **After the team is invited** (Members entry in the sidebar, admins only): set `MAISTRO_REQUIRE_MEMBER=1` on Vercel so decisions need a member session, and later unset `MAISTRO_APP_PASSWORD` to retire the shared password. (Turning off public sign-ups in Supabase Auth is now optional: since cd8e9e4 the login page only requests links for members and bootstrap admins.)
4. **Rotate the pasted secrets** (from 7b50e15): the database password, the anon key and the service-role key were pasted in chat. Reset the password (Supabase, Project Settings, Database) and rotate the keys when convenient, then re-add with `vercel env add`. Hygiene, not an outage.
5. ~~Vercel plan decision (Q-002)~~ answered 2026-10-21: the project is on Pro; the hourly trends cron is live and M3 has started.
6. ~~Supabase connection string and anon key (Q-006)~~ answered 2026-10-21; migrations applied.

## For the user to know (no action required unless you disagree)

- **Manual step from M1:** connect the GitHub repo to the Vercel project (Vercel dashboard, project settings, Git) and add the preview environment variables, so previews get real config and releases stop depending on a developer's working tree. Details in `REBUILD_LOG.md`.
- **App password:** the interim login password lives only in Vercel env; neither session has it, by design.

- **M1 changes how releases happen:** production deploys move from the CLI working tree to git-connected Vercel with previews (ADR-009).
- **ADR-003 roles:** the builder's proposal stands until you amend it.
- **State lives only in browser localStorage** (key `maistro-gen-v2`) for studio campaigns, approvals, rejections and the ADLCP attachment (file name only, no bytes). Flagged Critical, assigned to the Phase 1 audit.
- **`vercel env pull`** is blocked for the builder session, so production credentials stay out of reach there by design.
