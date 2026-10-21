# MAISTRO — Phase 1 audit

Date: 2026-10-21 · Branch: `rebuild/phase-0-recon` · Baseline: `ARCHITECTURE_CURRENT.md` (Phase 0). Every finding cites a file and line in `demo-ui/` unless stated otherwise; lines refer to the branch tip. Severity: Critical (data loss, money loss, or security exposure reachable today) · High (wrong product behaviour or an outage path) · Medium (reliability/maintainability debt with a known trigger) · Low (hygiene). Effort: S (< 1 day) · M (1–3 days) · L (> 3 days).

Two upstream defects found during Phase 0 were fixed out of band on 2026-10-21 because they were blocking the product (trend board collapse in Trend Radar; comment ingestion in the tracker). They are recorded in `REBUILD_LOG.md` and are not re-listed here except where Maistro itself still carries the risk.

---

## A. Data model and persistence

| ID | Sev | Finding | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|---|
| A-01 | **Critical** | Every Studio campaign, artifact, QC result, approval, rejection and ADLCP sign-off exists only in one browser's `localStorage` (`maistro-gen-v2`). | `index.html:1196-1207` (`saveGenerated`/`restoreGenerated`); the only server-side campaign store is `campaign_events`, written solely by `/api/ingest` (`api/ingest.js:97`). | Clearing site data, a second device, incognito, or a 5 MB quota overflow silently loses the campaign history and every approval. Nothing is auditable or shareable. | Server-side `ContentPiece` / `Artifact` / `Approval` records (Phase 2 domain model), with the browser as a cache only. | L |
| A-02 | **Critical** | The ADLCP and line-manager "uploads" store only the chosen file's **name**; the document bytes never leave the browser. | `uplOk` 2840; `confirmApprove` 2866-2869 writes `d.appr.lm`/`d.appr.adlcp` as strings. | The compliance gate the product is built around has no evidence behind it. | Upload to private storage, record checksum + uploader + timestamp against the artifact version, enforce server-side (A-05). | M |
| A-03 | High | Approvals on externally pushed (Hermes) deliverables are never persisted at all: `saveGenerated` keeps only `d-gen-*` rows. | 1198 filter `String(d.id).startsWith('d-gen-')`; external rows are `d-ext-…` (1922). | Approving a Hermes campaign is lost on reload. | Same as A-01. | (in A-01) |
| A-04 | High | No versioning of artifacts: regeneration overwrites `p[sid]` in place and resets the deliverable to pending, discarding the previous approval and the previous asset. | `attachTo` 1392-1407. | No history of what was approved; a rejected v1 and an approved v2 are indistinguishable after the fact. | Append-only artifact versions; approvals bound to a version id. | M |
| A-05 | **Critical** | No server-side representation of the stage state machine. Stages can be generated in any order, approved before earlier stages exist, and "final" can be approved without an ADLCP file (the check is client-side `classList.contains('ok')`). | `stageArtifact` 2693 "every piece is creatable in place, in any order"; `confirmApprove` 2859; only ordering rule is the `final` box lock 1428. | Any approval rule can be bypassed with DevTools; approvals can be double-recorded by regenerating. | Server-side transitions with allowed-transition table; reject out-of-order approvals; idempotent approval records. | M |
| A-06 | High | `/api/projects` collapses history to "first event per stage" over the newest 1,000 events; nothing is versioned, deletions are impossible, and the window silently truncates once > 1,000 events exist. | `api/projects.js:14-21`. | A re-pushed stage is ignored forever; after ~150 campaigns old ones vanish. | Proper tables with primary keys per project/stage/version. | M |
| A-07 | Medium | Daily performance snapshot is append-only with "latest per post wins" computed over the newest 1,000 rows; each cron run adds ~100-400 rows, so the read window covers 3-10 days only. | `api/sentiment.js:69-76`; `api/track.js` store block. | Older snapshots become unreachable; the table grows without bound. | Upsert per (post_id, day); retention policy. | S |
| A-08 | Medium | Reference photos go to a **public** Supabase bucket with guessable paths; no cleanup. | `api/upload.js:27-45`. | Product shots of unreleased devices are world-readable by URL. | Private bucket + signed URLs; per-campaign prefix; TTL. | S |
| A-09 | Medium | Generated media lives only at Higgsfield's CDN URLs; expiry untested (A-002 in the log). | `genPoll` 1546-1596 stores `d.video`/`d.images[0]` verbatim. | A whole campaign's visuals can 404 later; QC re-runs and the final re-render depend on them. | Copy finished assets into Maistro storage at completion; store the content hash. | S |

## B. Stage state machine and approvals (product logic)

| ID | Sev | Finding | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|---|
| B-01 | High | Rejection reasons go nowhere: `d.rej` is stored locally and the toast claims the reason was "routed to <agent>". | `confirmReject` 2886-2896. | Reviewers believe feedback was delivered; nothing happens. | Persist rejection, surface it in the stage box as the next generation's brief, notify the external agent via `/api/projects`. | S |
| B-02 | High | Two QC systems coexist with different scales and semantics: Hermes-dispatch campaigns get a **Claude-simulated** QC (four 70-95 scores, invented reviewer name) while Studio campaigns get real F1X8. The UI renders both as "QC". | `api/hermes.js:107-116`; `stageArtifact` 2729-2737 vs `rQcConsole` 1847. | A simulated score is presented next to a real one; the simulated reviewer "I. Surname · role" is a fabricated human sign-off. | Remove the simulated QC stage (or label it "placeholder" and never show a human name); route every piece through F1X8. Owner question Q-003. | S |
| B-03 | High | "Final = implement F1X8's fixes" is not verified: the director is told to implement every fix, Seedance re-renders, and the artifact is stamped `qcRevised:true` with no check. | `stageGen` 1507-1512; `genPoll` 1565. | The product claims fixes were applied; nothing proves it. The UI only *suggests* re-running QC (2727). | Re-run F1X8 automatically on the revised cut, store both scores, show the delta; block "final approved" until the revised score ≥ draft score or a human overrides with a reason. | M |
| B-04 | Medium | External pathway has 6 stages and no First Draft; the client remaps its pointer onto the 7-stage UI with a chained ternary. | `loadExternalProjects` 1911. | Two implicit pipelines; a pushed `final` is shown as stage 6 "QC" context. | One explicit stage list shared by server and client (Phase 2). | S |
| B-05 | Medium | Draft campaigns (`planning:true`) are excluded from persistence; a reload during planning loses the trend seed and any typed direction. | `saveGenerated` 1198; `cpDraft` 1279. | Minor data loss, confusing empty studio. | Persist drafts as a state. | S |

## C. Integrations

### C.1 kymah / Trend Radar

| ID | Sev | Finding | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|---|
| C-01 | High | Trend intake scrapes the public homepage's Next.js flight payload and takes the first `"trends":[` array. Any markup or payload change blanks the feed; there is no "feed thin/stale" state (confirmed 2026-10-20/21: a one-trend board rendered an empty page with no message). | `api/trends.js:32-53`; `loadLiveTrends` 1160 swallows errors. | Both creation paths die silently. | Use Trend Radar's agent API (`/api/agent/trends`, bearer `AGENT_API_KEY`, fit-ranked, includes the editorial brief); keep a last-known-good copy server-side and surface staleness in the UI. | S (adapter) + S (UI state) |
| C-02 | Medium | Proof that nothing triggers kymah's collection: the only call is `GET https://www.kymah.com/` (`api/trends.js:187`) with a browser UA. Collection runs in Trend Radar's own GitHub Actions. ✔ | — | — | Keep it that way; the agent API is read-only too. | — |
| C-03 | Medium | Edge cache is 15 min with 1 h stale-while-revalidate; a Vercel deploy purges it, so every deploy costs one cold kymah scrape + one Claude curation. | `api/trends.js:211`. | ~$0.1-0.3 per deploy and a slow first request. | Server-side cache of the normalised feed (A-01's database). | S |

### C.2 Claude curation and generation

| ID | Sev | Finding | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|---|
| C-04 | High | Prompts are string constants inside three functions with no version, no eval set, and no logging of what was sent/returned. Default temperature (1.0) — curation is non-deterministic run to run. | `api/trends.js:129-142`, `api/hermes.js:119-125`, `api/director.js:77-110`; no `temperature` anywhere. | "Highest accuracy" cannot be measured; a prompt edit cannot be A/B'd or rolled back. | Prompt files with versions; log request/response ids and token usage per call; eval harness (Phase 6); set temperature explicitly. | M |
| C-05 | Medium | Structured output is parsed with `JSON.parse(text.text)` and trusted; `claudeCurate` returns `null` on any failure and silently falls back to rules (`curatedBy:'rules'`). The hermes stage mapper slices arrays but never validates hex/enum values beyond the schema. | `api/trends.js:170-181, 198`. | A model outage degrades silently into a different ranking; nobody is told. | Validate against the JSON schema server-side; emit a metric/log on fallback; show `curatedBy` in the UI. | S |
| C-06 | Medium | Cost: each Hermes-dispatch is ~7 Opus calls (`max_tokens` 8000 each), each Studio piece 1 Opus call + 1 Higgsfield job, curation 1 Opus call per cold cache. No per-user or per-day ceiling. | `dispatchTrend` 1226-1240; `api/hermes.js:151`. | Unbounded spend (see D-01). | Budget guard per day + per caller (needs auth). | S after D-01 |

### C.3 Higgsfield (Soul / Seedance)

| ID | Sev | Finding | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|---|
| C-07 | High | Long jobs are driven entirely by the browser: 8 s polling for up to 8 minutes, state in `p.jobs` in localStorage, resumed by `resumeJobs()` only when the same browser reopens. | `genPoll` 1546; `resumeJobs` 1690. | Close the tab on another device and the job is never collected; two tabs poll twice; the server has no record a job exists. | Server-side job table + webhook or server poller (Phase 2 "long-running jobs"). | M |
| C-08 | Medium | No retries/backoff on submit; a 5xx from Higgsfield surfaces as a red box and the user retries manually; `nsfw` is handled, `canceled` is handled, unknown statuses poll forever until the 8-minute cap. | `api/higgsfield.js:101-108`; `genPoll` 1575-1581. | Flaky generations cost user time. | Retry with backoff on 5xx; explicit status whitelist. | S |
| C-09 | Medium | Two Higgsfield code paths (v2 SDK for plain, v1 REST for reference images) with different polling endpoints, selected by `hd.v`. | `api/higgsfield.js:69-93 vs 95-108`. | Duplicate logic, two failure surfaces. | One `HiggsfieldClient` adapter with a single job abstraction. | S |
| C-10 | Low | Reference image is passed as a raw public URL into the prompt pipeline; the prepended fidelity instruction is in the API layer, not the director. | `api/higgsfield.js:77-79`. | Prompt engineering split across two files. | Move to the director/adapter. | S |

### C.4 Hermes ingest and fallback chain

| ID | Sev | Finding | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|---|
| C-11 | High | `/api/ingest` has no idempotency: the same push twice creates two events; `/api/projects` then shows the *first* (`newest-first`, first-write-wins) — so a corrected re-push is **ignored**. | `api/ingest.js:97`; `api/projects.js:19-20`. | An external agent cannot fix a stage. | Idempotency key (projectId+stage+version) with upsert; explicit versions. | S |
| C-12 | Medium | Bearer comparison is a plain string `!==` (timing side channel), no rate limit, no payload size limit, `artifact` accepted as any JSON. | `api/ingest.js:62, 74-82`. | Key brute force is theoretical; a 4 MB artifact is accepted and later rendered. | `crypto.timingSafeEqual`; size cap; schema validation per stage (expand `REQUIRED_KEYS` into real schemas). | S |
| C-13 | Medium | The "fallback chain" (`/api/hermes`) is not a fallback: it is a second, parallel product path triggered by the "Dispatch to Hermes" button with its own simulated QC (B-02) and no observability (no request ids, no logging). | `dispatchTrend` 1208. | Two sources of truth for how a campaign is made. | Decide (Q-003); if kept, log every call with campaign id. | S |

### C.5 F1X8 proxy

| ID | Sev | Finding | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|---|
| C-14 | **Critical** | SSRF: `POST /api/qc-f1x8` fetches **any** `https://` URL server-side and forwards the bytes to F1X8; no auth on the endpoint. | `api/qc-f1x8.js:39-43`. | Anyone can make Maistro's server fetch arbitrary internal/external resources (up to 50 MB) and spend F1X8 GPU time. | Allow-list hosts (Higgsfield CDN, Maistro storage); require auth (D-01). | S |
| C-15 | High | F1X8 results (score, revision brief, risks) are persisted only in localStorage; heatmaps only in memory. The Modal backend has no auth and a 10-20+ minute cold start; the client gives up after 30 minutes and the job id is dropped. | `qcPoll` 1639-1671; `api/qc-f1x8.js:15-16`. | Scores are not durable; a long analysis on a cold backend is lost. | Persist QC runs server-side (A-01); server-side poller (C-07); auth on the Modal app (Phase 8). | M |
| C-16 | Medium | The proxy downloads the asset into memory (`arrayBuffer`) then re-uploads as multipart within one function invocation; a 50 MB video on a default-timeout function can exceed the limit. | `api/qc-f1x8.js:43-55`; no `maxDuration`. | Timeouts on big finals. | Stream, or pass the URL to F1X8's `video-url/submit` endpoint (exists in the contract). | S |

### C.6 Performance data (tracker)

| ID | Sev | Finding | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|---|
| C-17 | High | Timezone: every window ("past 7 days", day buckets, "24H/3D/7D") is computed in the viewer's browser local time or in UTC on the server; nothing is anchored to Asia/Dubai, and the calendar prints "GST" labels on simulated data only. | `weekPosts` 2019 (`Date.now()`), `pfPosts` 2097, `rReviewsDash` 2254 (`toLocaleDateString('en-GB')` without `timeZone`); `api/track.js` `since` in UTC. | Day boundaries shift by 4 h per viewer; KPIs differ between a Dubai and a London viewer. | One business timezone constant (Asia/Dubai) applied server-side; return day keys from the API. | S |
| C-18 | High | Staleness is invisible: the Performance page shows "CONSUMER SENTIMENT TRACKER · LIVE" regardless of data age; the tracker's comment ingestion was stalled for 3+ weeks without any UI signal. | `rPerformance` 3079; `sentiCompose` sets no age. | Users trusted stale sentiment. | Show `fetchedAt`/newest-comment age; badge "stale > 48 h". | S |
| C-19 | Medium | Twin-comment collapse keys on author + whitespace-normalised text. Misses: same comment with an emoji variation or trailing punctuation differences; false merges: a genuine repeated comment by the same user on the same post. Measured 2026-10-20: 1,830 twins removed, no labelled sample for precision/recall yet. | `api/track.js dedupeTwins`. | Unknown accuracy (Phase 6 item). | Build a labelled sample (200 pairs), measure, then tune (e.g. ignore punctuation/emoji skin tones). | S |
| C-20 | Medium | Double counting risk across sources: snapshot posts are appended when not in the live set by `postId` stripped of a platform prefix; a post present under two ids (numeric vs shortcode) would appear twice. | `sentiCompose` 1971-1985. | Inflated post/comment totals in edge cases. | Normalise ids once in the API (use track.js's `postAliases`). | S |
| C-21 | Medium | Arabic/mixed text: comments are rendered LTR in an LTR layout with no `dir="auto"`; translation goes through the unofficial Google `gtx` endpoint with no SLA. | No `dir=` anywhere in `index.html` (grep); `api/translate.js:17`. | Arabic comments render with broken punctuation order; translation can vanish any day. | `dir="auto"` on user text; an official translation API with a cache. | S |
| C-22 | Low | Live read of 60 days can take 50-80 s cold and occasionally 502s; now off the critical path (fixed 2026-10-20) but still costs a 300 s function per cache miss. | `api/track.js`; `vercel.json`. | Cost/latency. | Serve from the daily snapshot; refresh in the background. | S |

### C.7 Upload

| ID | Sev | Finding | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|---|
| C-23 | High | `POST /api/upload` has no auth, no rate limit, accepts any base64 ≤ 4 MB, trusts `contentType` after a regex (no magic-byte check), writes to a public bucket. | `api/upload.js:18-27`. | Anyone can host arbitrary images on Maistro's bucket. | Auth (D-01) + magic-byte sniff + private bucket (A-08). | S |

## D. Security (OWASP) — cross-cutting

| ID | Sev | Finding | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|---|
| D-01 | **Critical** | No authentication anywhere. Login is cosmetic (`doLogin` 925 hides an overlay). Every endpoint that spends money or writes storage is open: `/api/hermes`, `/api/director`, `/api/higgsfield`, `/api/qc-f1x8`, `/api/upload`, `/api/translate`; CORS `*` on most. | `index.html:925-933`; `api/*.js` (no auth checks except ingest/sentiment POST). | Unlimited third-party spend on Anthropic, Higgsfield and Modal; no notion of who approved what. | Real auth (SSO/magic link), roles, per-route authorisation, CORS restricted to the app origin. | M |
| D-02 | High | Stored XSS: artifacts pushed via `/api/ingest` (title, product, caption, note…) and model outputs are interpolated into HTML without escaping in ~18 places; `esc()` only escapes `&` and `<`, never quotes, so attribute contexts are unsafe even where it is used. | `index.html:873` (`esc`), 2796 `${p.title}`, 2714, 2721, 2826 (`d.appr.name/info`), 2827 (`d.rej`). | An ingest key holder (or a prompt-injected model output) can run script in every reviewer's browser. | Escape everything by default (templating with auto-escape in the Phase 2 frontend); fix `esc` to cover `"'>` now. | S now / solved by Phase 2 |
| D-03 | **Critical** | SSRF in the F1X8 proxy (C-14). | — | — | — | — |
| D-04 | High | Service-role Supabase key used for every operation including public reads; no RLS policies exist (RLS on, no policies) so the key is the only barrier. | `api/_supabase.js`; `supabase-setup.sql`. | Key leak = full database. | Keep service role server-only (it is), add least-privilege keys per function, rotate keys pasted in chat earlier (noted in memory). | S |
| D-05 | Medium | Secrets hygiene: no secrets in the repo (scanned 2026-10-21: no `sk-`, JWT, Apify or Higgsfield key patterns in `demo-ui/`); but several keys were pasted in chat during development — rotate. `MAISTRO_F1X8_BASE_URL` default is a hard-coded Modal URL. | `api/qc-f1x8.js:15-16`. | — | Rotate; move the URL to config. | S |
| D-06 | Medium | Dependencies: `npm audit` reports 0 vulnerabilities on the installed tree, but there is no lockfile so the audited tree is not what production builds. | `.gitignore` (`package-lock.json`), `package.json` `^` ranges. | Unreproducible builds; a bad transitive release ships silently. | Commit the lockfile; pin; Dependabot. | S |
| D-07 | Low | `x-vercel-cron` is not checked on `/api/track`; a `user-agent: vercel-cron/1.0` header lets anyone trigger the store path (writes a snapshot). | `api/track.js:205`. | Table bloat / fake snapshots. | Verify `CRON_SECRET` bearer (Vercel sets it). | S |

## E. Reliability

| ID | Sev | Finding | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|---|
| E-01 | High | External calls have no timeouts except trends' Anthropic client (45 s) and hermes' client abort (120 s); director, higgsfield, qc-f1x8, upload, translate rely on the function's default timeout which is **not configured** (`vercel.json` pins only hermes and track). | `vercel.json`; grep: 1 `timeout` in `api/*.js`. | Hung upstreams hold functions open; behaviour depends on the (unknown) Vercel plan default. | Pin `maxDuration` per function; `AbortSignal.timeout` on every fetch; retries with backoff on 5xx. | S |
| E-02 | High | Graceful degradation is absent for kymah (C-01), Higgsfield (red box), Modal (30-min give-up), Supabase (`/api/projects` 502 → silent), tracker (fixed partially 2026-10-20). Six `catch(e){}` blocks swallow errors in the page. | `index.html` grep count 6 (e.g. 1160, 1934, 2011). | Users see blank sections with no explanation. | Error/empty/stale states everywhere (Phase 4 frontend standard). | M |
| E-03 | Medium | Idempotency: ingest (C-11), sentiment POST (append), track store (append), upload (random path) — no write is idempotent. | — | Duplicates on retry. | Keys/upserts. | S |
| E-04 | Medium | Global `HERMES_BUSY` lock and per-key `GEN.busy` live in page memory; a reload mid-dispatch leaves a half-built campaign persisted with `stage` pointing past the last artifact. | `dispatchTrend` 1225-1241. | Inconsistent campaign state. | Server-side job state (C-07). | (in C-07) |

## F. Performance

| ID | Sev | Finding | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|---|
| F-01 | Medium | Every state change re-renders a whole page via `innerHTML` (3,000+ line templates); the Performance page re-renders on each 60 s poll when the post signature changes, discarding scroll and filter focus. | `route()` 1049; `sentiCompose` 1988. | Jank on large feeds; lost input focus. | Component framework with keyed rendering (Phase 2). | (Phase 2) |
| F-02 | Medium | Payloads: `/api/track?days=60` is 1.9 MB (6k comments) returned to the browser and held in memory; `/api/trends` embeds clips; `index.html` is 275 KB uncompressed plus a 528 KB PNG on the landing page. | measured 2026-10-20/21. | Slow on mobile; memory. | Paginate comments; serve posts without comments by default; compress/trim the PNG. | S |
| F-03 | Low | Cold starts: the higgsfield function bundles the SDK (186 KB) and `require`s it inside the handler; fine. No measurable issue yet. | `vercel inspect`. | — | Measure in Phase 3 baselines. | — |

## G. Observability, testing, DevOps, documentation

| ID | Sev | Finding | Evidence | Impact | Fix | Effort |
|---|---|---|---|---|---|---|
| G-01 | High | No structured logging, no correlation id per campaign, no error tracking; `console.error` is used in 3 places server-side. A failed generation cannot be debugged after the fact (no record of prompt, request id, Higgsfield request id beyond localStorage). | grep `console.` in `api/*.js`. | Support is impossible without the user's browser. | Request-scoped logger with campaign id; persist job records (C-07); error tracker. | M |
| G-02 | High | Tests: one DOM-stub smoke script (67 checks) that stubs `fetch`; no tests for any API function, no contract tests against kymah/Higgsfield/F1X8/tracker shapes, no CI for `demo-ui` (CI runs only the legacy Python engine). | `demo-ui/.smoke-test.js`; `.github/workflows/ci.yml`. | Any regression ships. | Phase 3 safety net. | L |
| G-03 | High | Deployment: CLI-only `vercel deploy --prod` from a developer's working tree (not from git); no preview environment in use; no rollback procedure; secrets managed by hand (`vercel env add` with a known BOM pitfall). | `vercel ls` (all CLI uploads); memory notes. | What is deployed is not what is committed (observed twice on 2026-10-21). | Git-connected project, preview per branch, promote-to-prod, documented rollback. | S |
| G-04 | Medium | Single 3,112-line HTML file holds CSS (675 lines), markup and 2,291 lines of JS with ~190 top-level functions and ~15 global mutable objects; no modules, no types, no linter. | `ARCHITECTURE_CURRENT.md` §3. | Every change risks every page; onboarding takes days. | Phase 2 component architecture. | L |
| G-05 | Medium | Documentation: `API.md` covers 3 of 12 endpoints and a stale base URL; `README.md` at the repo root describes the legacy engine and lists Lenceus; no runbook. | `demo-ui/API.md`; `README.md`. | Misleading to a new engineer. | Rewrite README for the real product; generate API docs from schemas. | S |
| G-06 | Low | Legacy engine (`services/`, `packages/`, `db/`, `langgraph.json`, `.langgraph_api/`) still in the repo and in CI, with nothing live depending on it (Vercel builds `demo-ui/` only). | Phase 0 §1.5. | Confusion, CI minutes. | Archive after owner confirmation (constraint 2). | S |

---

## Top 10 problems, ranked by impact

1. **D-01** No authentication: money-spending and storage-writing endpoints are open to the internet, and no approval can be attributed to a person.
2. **A-01 / A-03** All campaign, approval and ADLCP state lives in one browser; external-pathway approvals are not stored at all.
3. **A-02 / A-05** The ADLCP gate stores a file name and is enforced only in the UI; stage order and double-approval are not enforced anywhere.
4. **C-14 / D-03** SSRF in the F1X8 proxy.
5. **D-02** Stored XSS from ingested artifacts and model outputs (escaping covers only `&` and `<`).
6. **C-01** Trend intake scrapes a page with no staleness state; one upstream hiccup blanks the product (happened this week).
7. **C-07 / C-15** Long-running generation and QC jobs exist only in the browser; results are not durable.
8. **B-02 / B-03** A Claude-simulated QC with a fabricated human reviewer coexists with real F1X8, and "fixes implemented" is never verified.
9. **G-02 / G-03** No tests for the product and deploys from an uncommitted working tree.
10. **C-17 / C-18** Performance numbers are not timezone-anchored and never say how old the data is.

## Verdict per area

| Area | Verdict | Justification |
|---|---|---|
| Frontend (`index.html`) | **Rewrite** (incremental strangler) | 3,112-line single file, innerHTML rendering, global state, no escaping discipline. Patching it cannot reach WCAG/RTL/testability; but the *pages* and their data needs are clear, so rebuild page by page behind the same routes while the old file keeps serving the rest. |
| Serverless API (`api/*.js`) | **Module rebuild** | Each function is small and mostly correct in its happy path; what is missing is shared: auth, validation, timeouts, logging, idempotency, storage. Rebuild as typed adapters behind thin handlers; keep the external contracts (`/api/trends`, `/api/ingest`) stable for the Hermes agent. |
| Data/persistence | **Rebuild** | There is almost nothing to refactor: two append-only tables and localStorage. Design the domain model fresh (Phase 2). |
| kymah intake | **Incremental** | Swap the scraper for the agent API behind the same normalised shape; add staleness. |
| Claude curation/generation | **Incremental** | Keep prompts and schemas; add versioning, validation, logging, evals. |
| Higgsfield / F1X8 integrations | **Module rebuild** | One adapter each with a server-side job model; the API calls themselves are fine. |
| Hermes ingest | **Incremental** | Add idempotency, schema validation, timing-safe auth; keep the contract. |
| Performance page / track | **Incremental** | The data path is correct after the 2026-10-20/21 fixes; add timezone anchoring, staleness, pagination, and move the merge server-side. |
| Calendar / Sprinklr | **Rebuild (manual mode)** | Everything is simulated; build the adapter against Sprinklr's documented API with an honest manual/export mode and clear "not connected" state. |
| Testing / CI / deploy | **Build from scratch** | Nothing exists for the product. |

Default applied: the least risky option that still meets the bar. The frontend is the one place where incremental work cannot meet it, and the strangler approach keeps ma1stro.com up throughout.
