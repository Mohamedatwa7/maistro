# Maistro API

Base URL: `https://www.ma1stro.com` (Vercel project `maistro-demo`; the
`*.vercel.app` deployment URLs work too). Every route below is served by one
Vercel function, `api/[route].js`, which dispatches to `api/_handlers/<route>.js`
(the project is on the Hobby plan, which caps a deployment at 12 functions).
Unknown routes return `404 {"error": "not found"}`.

## Routes and who may call them

| Route | Methods | Auth | Used by |
|---|---|---|---|
| `/api/health` | GET | none | deploy checks |
| `/api/trends` | GET | none | website, external agents |
| `/api/projects` | GET | none | website |
| `/api/sentiment` | GET / POST | POST: `Bearer MAISTRO_INGEST_KEY` | website / tracker push bridge |
| `/api/track` | GET | none (`?store=1` needs the ingest key; the daily cron authenticates with `CRON_SECRET`) | website Performance page, Vercel cron |
| `/api/ingest` | POST | `Bearer MAISTRO_INGEST_KEY` | external Hermes agent |
| `/api/login` | GET / POST / DELETE | magic-link token or password → session cookie | website |
| `/api/members` | GET / POST / PATCH | admin member session | website (invite, roles) |
| `/api/jobs` | GET / POST | session cookie (tick: `CRON_SECRET`) | website (renders and F1X8 checks as durable jobs) |
| `/api/hermes` | POST | session cookie | website (Dispatch to Hermes) |
| `/api/director` | POST | session cookie | website (Studio) |
| `/api/higgsfield` | POST / GET | session cookie | website (Studio) |
| `/api/qc-f1x8` | POST / GET | session cookie | website (Studio QC) |
| `/api/upload` | POST / GET | session cookie | website (reference photos, approval documents) |
| `/api/translate` | POST | session cookie | website (comment translation) |
| `/api/pieces` | GET / POST | session cookie | website (campaign store: list; write-through of a stage version) |
| `/api/decisions` | POST | session cookie | website (approve / reject / reopen, decided server-side) |

"Session cookie" is the interim single-password login: `POST /api/login` sets
an HttpOnly, Secure, SameSite=Lax cookie `maistro_session` (HMAC over an
expiry, 12 h) and the gated routes answer `401` without it. Bearer checks are
constant-time. Request bodies are validated at the door (`api/_schemas.js`):
a malformed body is `400` (hermes) or `422` (director, ingest) with a
`problems[]` list of field paths. All responses are JSON; CORS is open on the
public routes.

---

## /api/pieces and /api/decisions — the campaign store

The server's record of every piece (`content_pieces`), its eight stages
(`stages`), every artifact version (`artifact_versions`, append-only), every
decision (`approvals`, one `approved` row per version) and the sign-off
documents bound to a final version (`adlcp_documents`). Rules come from
`src/domain/stages.js`.

- `GET /api/pieces?limit=100` → `{count, pieces:[{id (legacy id), pieceId,
  title, product, msg, angle, markets, platforms, trendId, trend, origin,
  status, stages:{<kind>:{state, version:{id,n,kind,payload,producedBy,at}|null,
  decision:{decision,reason,name,role,at}|null, documents:{line_manager,adlcp}|null}}}]}`.
- `POST /api/pieces {pieceId, stage, artifact, piece?, producedBy?, kind?}` →
  `{ok, pieceId, stage, versionId, version, state}`: appends a version and
  makes it current. `422` when the artifact fails its stage schema; `409
  approved_immutable` when the stage is approved (an admin must reopen it).
- `POST /api/decisions {pieceId, stage, decision:"approved"|"rejected", name,
  role, info?, reason?, documents?}` → `{ok, …, state, approvalId, decidedAt}`.
  `409` with a `code` when the domain refuses: `not_reviewable`,
  `role_required`, `documents_required` (final needs both stored documents
  from `/api/upload kind=document`), `self_approval`, `reason_required`.
  `{action:"reopen", pieceId, stage, role:"admin"}` reopens an approved stage.
- `/api/ingest` records every accepted push here as origin `external_hermes`
  and answers `409 approved_immutable` for a push onto an approved stage.

Until Supabase Auth lands (M2 part 2 c) the `role` is the signer's claim;
afterwards the session's member role is used instead.

---

## /api/jobs — durable renders and quality checks (ADR-004)

Every render (made by the owner's Hermes bots since 2026-10-27) and F1X8 analysis is a row in `jobs`; the browser
only reads job state, never a provider. A one-minute cron advances due rows
(conditional claim, so overlapping ticks never double-submit; submit retried
up to 3 times with backoff; `timed_out` after 15–45 minutes by kind).

- `POST {pieceId, stage, kind, payload, piece?}` → `{ok, job}`. Kinds:
  `hermes_image` (mood/thumb/board; payload `{prompt, aspect_ratio,
  resolution, ref?, batch?, seed?, meta:{prompt,note,ar,res,title?,sub?,anchors?}}`),
  `hermes_video` (draft/final; payload adds `duration`, `imageUrl` or
  `imageAssetPath` for the first frame, `meta.dur`, `meta.version`),
  `hermes_brief` (brief; created by `/api/studio` action `brief`),
  `f1x8_image` / `f1x8_video` (payload `{assetUrl, title, description}`).
  `higgsfield_image` / `higgsfield_video` can no longer be created; rows from
  before the switch still finish. A render sets the stage `generating` through the domain:
  `409 prerequisites` when the stage's prerequisites do not exist yet
  (`strict:true` in the payload requires them approved), `409
  approved_immutable` on an approved stage.
- `GET ?id=` → `{job}` (`state`: queued | running | succeeded | failed |
  timed_out; `result.artifact` + `result.version` for a render, `result.analysis`
  + `result.score` + `result.heatmapPath` for a check). A due job is advanced
  by the read itself.
- `GET ?piece=<legacy id>` → `{count, jobs}`, advancing the open ones
  (reconcile-on-open).
- Completion: a finished render is copied into the private `assets` bucket
  (`artifact.assetPath`, `sha256`) and recorded as the stage's next version
  (`produced_by` hermes, `job_id`, `artifact.madeBy {provider, bot, run}`); a finished
  check is stored in `qc_results` against the analysed stage's current
  version, its heatmap in `assets`.

---

## GET /api/health — deploy check

`200 {ok:true, revision, environment, configured:{NAME:true|false,…},
missing:[], checkedAt}`; `503` with `ok:false` when a required secret is
missing. Names only, never values.

---

## /api/login — sessions (ADR-003)

- `GET` → `{configured, authenticated, member:{email,role,name}|null,
  auth:{url, anonKey, magicLink, password}}`. The anon key is public by
  design: the page posts `{email, create_user:true, options:{email_redirect_to}}`
  to `<url>/auth/v1/otp` with it to request a magic link.
- `POST {access_token}` → the token from the magic link is verified with
  Supabase Auth (`/auth/v1/user`); an active row in `members` yields a
  **member session** cookie carrying id, e-mail, role and name (HMAC-signed,
  not editable client-side) → `200 {ok, member}` · `401` invalid/expired
  link · `403 not_a_member` (ask an admin to invite you). An address listed
  in `MAISTRO_ADMIN_EMAILS` becomes admin on first sign-in.
- `POST {password}` → the interim shared-password session (`204` + cookie,
  no identity) while `MAISTRO_APP_PASSWORD` is set; unset it to retire the
  path. `MAISTRO_REQUIRE_MEMBER=1` makes `/api/decisions` refuse password
  sessions.
- `DELETE` → `204`, clears the cookie.

## /api/members — who may sign in (admin member session only)

- `GET` → `{count, members:[{id,email,role,name,active,createdAt}]}`.
- `POST {email, role, name?}` → invites through Supabase Auth (the person
  receives a sign-in link) and creates the `members` row → `{ok, member}` ·
  `409` already a member · `422` bad e-mail or role.
- `PATCH {id, role?, active?, name?}` → `{ok, member}`; an admin cannot
  deactivate themselves.

Roles: admin · creator · reviewer · line_manager · adlcp_approver · viewer
(what each may do is in `src/domain/stages.js`).

---

## GET /api/trends — pull Samsung-fit trends

Reads TrendRadar's agent API (the published board, bearer `TRENDRADAR_AGENT_KEY`;
since 2026-10-21) and falls back to scraping kymah.com's page payload when the
API is unavailable; returns the board normalized. The response also carries
`live` (false = TrendRadar answered from its build-time snapshot),
`boardGeneratedAt` (when the board was published) and `boardTotal`; each
trend additionally carries `trendId` (TrendRadar's id), `onBrand`,
`signalStrength`, the editorial `brief` and scored `products` when the agent
API answered. An empty board is `200 {count: 0}`, not an error. The last good
board (raw and curated) is kept in `trends_cache`: a read younger than an
hour is served from it without touching Trend Radar or Claude, an older one
refreshes the board on read, and when the refresh fails the cached board is
served with `cache.stale: true` (and `cache.error`) instead of a `502`. The
response's `cache` object is `{hit, stale, fetchedAt, ageS}`. Responses are edge-cached for 15
minutes (`s-maxage=900, stale-while-revalidate=3600`). CORS is open (`*`).

### Query parameters

| Param      | Example        | Effect                                        |
|------------|----------------|-----------------------------------------------|
| `strength` | `strong`       | Only `strong` (or `fit`) Samsung-fit trends   |
| `minScore` | `70`           | Only trends with relevance gate score ≥ N     |
| `id`       | `healing-eyes-drawing-trend` | Single trend by slug            |
| `limit`    | `5`            | First N trends (sorted by score, then momentum) |

### Response shape

```json
{
  "source": "TrendRadar (kymah.com)",
  "fetchedAt": "2026-09-24T12:00:00.000Z",
  "count": 11,
  "trends": [
    {
      "id": "magnetic-charger-ugc-ad-format",
      "name": "Magnetic charger UGC ad format",
      "status": "mature",              // mature | peaking | breakout
      "region": "Global",
      "lang": "EN",
      "category": "Misc",
      "samsungFit": {
        "strength": "strong",          // strong | fit
        "score": 88,                   // relevance gate, /100
        "ownableBeat": "unboxing/desk-setup device demo",
        "rationale": "…why this fits Samsung…",
        "raw": "Samsung relevance gate: 88/100 — …"
      },
      "momentumPerDay": 13,            // % per day, may be null
      "viewsPerWeek": 9300000,         // may be null
      "avgEngagementPct": 16.1,        // may be null
      "stayingPower": "Ongoing",       // Flash | Ongoing
      "clips": [ { "handle": "@creator", "poster": "https://…", "views": 11000 } ]
    }
  ]
}
```

Errors return `502 {"error": "..."}` (e.g. kymah.com markup changed).

---

## GET /api/track — live read of the Consumer Sentiment Tracker

Reads the samsungtrack Supabase project directly (`TRACK_SUPABASE_URL` /
`TRACK_SUPABASE_KEY`), so Maistro rides the tracker's daily Apify schedule
instead of running duplicate pulls. `?days=N` (default 60, max 90) selects
the window. The Performance page reads 14 days first and widens to 60 in the
background.

`200 {source, fetchedAt, days, count, comments:{seen, matched, partial},
stored, timings, posts:[…]}` — the same post shape as `/api/sentiment`;
twin comments (same author and text) are collapsed server-side. Edge-cached
10 minutes (`no-store` when the comment read was partial); `502` with the
query timings when the tracker DB times out; `503` when not configured.

The Vercel cron (`vercel.json`, 06:30 UTC daily, authenticated by
`CRON_SECRET`) calls this and stores every post as a snapshot into Maistro's
`sentiment_posts`, falling back to a 14-day window if the 60-day read times
out. A manual store is `?store=1` with the ingest-key bearer.

---

## POST /api/translate — comment translation

`{text (≤1500 chars), targetLang?: "en"}` → `{translatedText,
detectedLanguage}`; `422` when text is empty; `502` when the translation
service fails. Cached one day at the edge.

---

## POST /api/hermes — generate one pipeline-stage artifact

The demo's built-in agent chain (Claude Opus 4.8 server-side). Call once per
stage in order; pass earlier artifacts back in via `project` so the campaign
stays coherent.

```json
POST /api/hermes
Content-Type: application/json

{
  "stage": "plan",        // plan | mood | thumb | brief | board | final | qc
  "trend": { …one trend object from /api/trends… },
  "project": { …artifacts from earlier stages, or null for "plan"… }
}
```

Returns `200 {"stage", "agent", "artifact"}` where `artifact` matches the
Studio UI shapes (see `api/hermes.js` STAGES map). `503` if the server key is
missing; `502` with the upstream error otherwise. Each call is one Opus 4.8
request (~10–40 s).

---

## POST /api/ingest — push artifacts in (for the external Hermes agent)

The inbound door. Hermes pulls trends from `/api/trends`, generates every
piece itself, and pushes each stage here. The Maistro website polls
`/api/projects` every 15 s and renders pushed campaigns stage by stage.

**Auth:** `Authorization: Bearer <MAISTRO_INGEST_KEY>` (server env var).

### Flow

1. Push the **plan** first (no `projectId`) — the response returns the
   `projectId` for the campaign.
2. Push the remaining stages in any order with that `projectId`:
   `mood → thumb → brief → board → final → qc`.

```json
POST /api/ingest
Authorization: Bearer maistro_ingest_…
Content-Type: application/json

{
  "projectId": "ext-abc123",          // omit on "plan"
  "stage": "mood",
  "agent": "Muse",                     // optional, defaults per stage
  "trend": { "id": "magnetic-charger-ugc-ad-format", "name": "…" },  // on "plan"
  "artifact": { … }
}
```

Response: `200 {"ok": true, "projectId", "stage", "agent"}`.
Errors: `401` bad token · `400` bad stage/projectId · `422` artifact does not
match its stage schema · `503` storage or key not configured.

A `422` body is `{"error": "<stage> artifact is missing: a, b"}` when only
required keys are absent, otherwise `{"error": "<stage> artifact invalid: …",
"problems": ["$.th[1]: has the wrong format", …]}` with one entry per field
(`$` is the artifact). The schemas live in `api/_schemas.js`: colors must be
`#rrggbb`, `platforms` ∈ tiktok|instagram|youtube|x, media URLs must be
`https://`, string lengths are capped, and an artifact is at most 64 KB. Each
visual stage also accepts the Studio media shape (`{imageUrl, prompt?, note?}`,
and `videoUrl` on `final`); `qc` also accepts the real-F1X8 shape
`{real: true, runs, avg?}`.

### Artifact shapes per stage

All colors are hex `#rrggbb` on a near-black UI — keep them deep and muted.

```jsonc
// plan  (creates the campaign)
{ "title": "Snap & Charge", "product": "Galaxy S26 Ultra",
  "msg": "Power that snaps on", "angle": "one sentence",
  "markets": ["KSA","UAE"], "platforms": ["tiktok","instagram"],   // tiktok|instagram|youtube|x
  "th": ["#0c1418","#1d5a63"] }                                    // [dark, accent] theme

// mood
{ "note": "2-3 sentence art direction", 
  "tiles": [["#0a0f14","#1d3a44","Label"], …] }                    // exactly 6 [from,to,label]

// thumb
{ "title": "SNAP. CHARGED.", "sub": "Galaxy S26 Ultra · hook", "g": ["#0c1418","#1d5a63"] }

// board  (the artifact IS the array, 4-6 frames)
[ { "tc": "0:00", "d": "shot description", "g": ["#0a0f14","#1d3a44"] }, … ]

// final
{ "version": "v1", "dur": "0:15", "audio": "track — licence note",
  "variants": [ { "a": "9:16", "l": "EN", "k": "original", "st": "ready" } ] }
    // a: 9:16|16:9|1:1 · k: original|subtitles|voiceover · st: ready|rendering

// qc
{ "f1x8": [ { "n": "Technical & craft quality", "s": 88 }, …4 dimensions ],
  "f1x8Note": "composite + predicted ER", "human": "N. Haddad · Regional brand lead",
  "humanNote": "sign-off note" }
```

---

## GET /api/projects — pull pushed campaigns

Aggregates everything pushed via `/api/ingest`. Public, no auth, `no-store`.

```json
{ "count": 1, "projects": [ {
    "id": "ext-abc123", "external": true, "title": "Snap & Charge",
    "product": "Galaxy S26 Ultra", "markets": […], "platforms": […],
    "th": ["#0c1418","#1d5a63"], "trend": "Magnetic charger UGC ad format",
    "stage": 3,                       // furthest stage delivered (1-6)
    "mood": { … }, "thumb": { … },    // whichever stages were pushed
    "agents": { "mood": { "agent": "Muse", "at": "2026-09-24T…" } },
    "pushedAt": "2026-09-24T…"
} ] }
```

---

## /api/sentiment — Consumer Sentiment Tracker integration

**POST** (same `Authorization: Bearer <MAISTRO_INGEST_KEY>` as /api/ingest):
the tracker pushes post snapshots — a single post object or `{"posts": [...]}`.
Snapshots are append-only; the latest per `postId` wins on read.

```jsonc
{
  "postId": "tiktok-730194...",        // required, stable per post
  "platform": "tiktok",                 // tiktok | instagram | youtube | x
  "account": "@SamsungGulf",
  "caption": "Pocket check 👀 #GalaxyZFold8",
  "url": "https://www.tiktok.com/...",
  "postedAt": "2026-10-05T18:00:00Z",
  "metrics": { "views": 412000, "likes": 31800, "comments": 1240, "shares": 2900, "er": 0.052 },
  "sentiment": { "pos": 0.71, "neu": 0.21, "neg": 0.08 },
  "comments": [
    { "author": "@user1", "text": "this transition is clean 🔥", "sentiment": "pos", "likes": 214, "at": "2026-10-05T19:12:00Z" }
  ]
}
```

**GET** (public): `{count, posts:[...]}` — latest snapshot per post, newest
first. The Maistro Performance page polls this every 60 s and renders each
post with its metrics, a positive/neutral/negative sentiment bar, and the
captured comments tagged by sentiment.

---

## The Hermes bots (the Studio's renderer)

Maistro calls the owner's bots on Hermes Agent through its API server's runs
API. One profile per bot, each at `{HERMES_API_URL}/p/<profile>/v1/runs` with
`Authorization: Bearer <that profile's API_SERVER_KEY>` (setup: RUNBOOK.md →
"Connecting the Hermes content bots").

| Studio stage | Job kind | Bot (env) | Asked for |
|---|---|---|---|
| Moodboard | `hermes_image` | `HERMES_BOT_MOOD` | 4 image variations of one art direction, 4:3 |
| Thumbnail | `hermes_image` | `HERMES_BOT_THUMB` | 1 key visual at the platform aspect, no text in the image |
| Brief | `hermes_brief` | `HERMES_BOT_BRIEF` | the structured brief (the 6.4 contract) |
| Storyboard | `hermes_image` (one per shot) | `HERMES_BOT_BOARD` | 1 keyframe per shot |
| First draft / final | `hermes_video` (one per shot) | `HERMES_BOT_VIDEO` | 1 clip per shot from its keyframe |

**What Maistro sends**: `POST …/v1/runs` with `Idempotency-Key: <job id>` (a
retried submit returns the same run) and

```jsonc
{
  "input": "TASK: …\n\nCREATIVE PROMPT (written by Maistro's art director …):\n<prompt>\n\nFORMAT: aspect ratio 9:16, 1080p\n\nPRODUCT REFERENCE PHOTO …: https://…\n\nAPPROVED MOODBOARD IMAGES …:\nhttps://…",
  "instructions": "<the reply contract below>",
  "session_id": "maistro-<pieceId>-<stage>"
}
```

A clip run adds `FIRST FRAME (image-to-video …): <signed keyframe URL, 24 h>`
and the duration. The brief run's `instructions` are Maistro's brief rules,
and its `input` is the approved moodboard, thumbnail, trend, catalog, approved
claims and platform rules, followed by the brief JSON schema.

**What the bot must reply** (the run's final `output`, last ```json block wins):

```jsonc
{"images": ["https://…/1.png", "https://…/2.png", "https://…/3.png", "https://…/4.png"], "note": "one line"}  // mood (4) / thumb / board (1)
{"video": "https://…/clip.mp4", "note": "one line"}                                                            // draft / final clip
{"brief": { …the brief contract… }}                                                                           // brief
{"refused": "one-line reason"}                                                                                // declined on policy grounds
```

URLs must be public https for at least 24 hours, on the gateway's own host or a
host listed in `QC_ASSET_HOSTS`. Maistro copies every file into its private
bucket and checks it (vision check, clip check, F1X8 on the hook and the cut),
exactly as before. A reply without usable media fails the job (`provider
reported completed without any output`). A brief that does not match the
contract fails with the field problems. A refusal fails uncharged, with the
reason and a compliant rewrite suggestion on the job.

Run states: `started`/`running` → polled again; `waiting_for_approval` → still
running, with the job `error` saying to approve it inside Hermes;
`completed` → read as above; `failed`/`cancelled`/`interrupted` → the job
fails with Hermes's reason. HTTP 429/5xx retry with backoff (same key);
401/403/404/other 4xx fail at once and name the env var to check.

Prices: Hermes returns none, so the budget and the QC fix plan use
`MAISTRO_UNPRICED_IMAGE_USD` (default $0.05/image) and
`MAISTRO_UNPRICED_VIDEO_USD_PER_S` (default $0.50/s), labelled "assumed".
`MAISTRO_NO_RENDER=1` blocks every run (no spend for testing).

---

## /api/higgsfield — legacy (Studio no longer uses it)

Kept for the legacy page path only (the `maistro-legacy-providers` switch). The
Studio's renders go to the Hermes bots above.

### Studio Create video generation (Seedance 2.5)

Backs the Studio Copilot (Content Studio → Pathway 02). Proxies Higgsfield
with the server-side `HF_CREDENTIALS` (`key-id:key-secret`); the key never
reaches the browser. Model: `bytedance/seedance-2.5/text-to-video`.

**POST** — submit a generation (returns immediately; render takes 1–3 min):

```jsonc
// request
{
  "prompt": "Slow cinematic dolly across a premium smartphone on dark silk",
  "duration": 5,            // 4–30, default 5
  "resolution": "720p",     // 480p | 720p | 1080p
  "aspect_ratio": "16:9"    // 16:9 | 4:3 | 1:1 | 3:4 | 9:16 | 21:9
}
// response
{ "request_id": "46b35e08-…", "status": "queued" }
```

**GET** `?id=<request_id>` — poll status:

```jsonc
{ "status": "completed", "video": "https://…cloudfront.net/….mp4" }
// non-terminal: {"status":"queued"|"in_progress", "video":null}
// terminal failures: status "failed" | "nsfw" — no video, surface honestly
```

Each POST is a billable Higgsfield generation. The copilot polls GET every
8 s client-side and attaches the finished cut as the campaign's Final
Content deliverable (with an inline player) once completed.

---

## POST /api/director — AI Creative Director (prompt crafting)

Turns a non-expert user's plain words into a professional Higgsfield prompt
for one artifact, with built-in briefings on what each artifact IS (a
moodboard is a collage board, a storyboard is a 6-panel sheet, etc.) and
mandatory visual continuity with everything already generated. Uses the
server-side `ANTHROPIC_API_KEY` (Claude Opus).

```jsonc
// request
{
  "stage": "mood",                      // mood | thumb | board | final
  "userInput": "funny, desert vibes",   // optional plain words
  "campaign": { "title": "...", "product": "...", "msg": "...", "angle": "...",
                "markets": ["UAE"], "platforms": ["tiktok"] },
  "context": {                          // previously generated stages (continuity)
    "mood": { "prompt": "...", "note": "..." }
  }
}
// response
{ "stage": "mood", "prompt": "<ready for Higgsfield>", "note": "<friendly explanation>" }
```

`/api/higgsfield` POST also now accepts `kind: "image"` (Higgsfield Soul v2,
`higgsfield-ai/soul/v2/standard` — aspect_ratio 9:16|16:9|4:3|3:4|1:1|2:3|3:2,
resolution 720p|1080p); completed GET responses then carry `images: ["url"]`.
The Studio Create pipeline chains: user plain words → /api/director →
/api/higgsfield (image or video) → poll → the artifact fills its stage
placeholder in the Content Studio.

---

## /api/upload — reference photos and approval documents (session required)

**POST** `{data:<base64>, contentType:"image/jpeg"|"image/png"|"image/webp"}`
→ `{url}`: a product reference photo in the public `refs` bucket (the client
downsizes to ≤1600 px first; 4 MB cap).

**POST** `{kind:"document", data:<base64>, contentType, name?}` → `{path,
sha256, size, contentType, name, at}`: a line-manager or ADLCP sign-off
document in the **private** `approvals` bucket. Accepted types: PDF, JPEG,
PNG, WebP, `.eml`, `.msg`; 3 MB cap (Vercel's 4.5 MB request limit minus
base64). No public URL is ever returned; the Production Center records the
returned object against the approval, and "Record approval" on a final stays
disabled until both documents are stored.

**GET** `?path=<stored path>` → `{url, expiresIn:600}`: a 10-minute signed
URL for a session holder to open a stored document. Errors: `401` no
session · `413` too large · `422` bad type or path · `502` storage error ·
`503` storage not configured.

---

## /api/qc-f1x8 — real F1X8 quality check (proxy)

Routes the Content Studio QC stage through the real **F1X8** engagement-scoring
backend (Modal GPU FastAPI: Claude vision + Qwen-VL + Whisper; contract in
`D:\MAISTRO\packages\contracts\openapi\f1x8.yaml`). Assets are downloaded
server-side and re-uploaded as multipart (no CORS on CloudFront/Modal).

**POST** `{kind:"image"|"video", assetUrl, title, description}` → `{job_id}`.
`description` carries the campaign brief so the result includes
`context_score` (brief-fit). Images use `/api/analyze/image/submit`, the final
cut `/api/analyze/video/submit` — both async.

**GET** `?job=<job_id>` → `{status: fetching|analyzing|done|error, result?}`.
A `done` result is the full F1X8 AnalysisResult: `score` 0-10,
`funnel_stage`, `product_tier`, 5 funnel-aware `kpis` (score/label/
methodology), `verdict` (summary, strengths, ranked risks with
evidence/impact/suggested_fix/score_lever/confidence, hierarchy_analysis,
brand_visibility, benchmark_context, `revision_brief`), base64 `heatmap`,
`context_score`; video adds `benchmarkPercentile` + attention `timelines`.

The QC stage UI (`rQcConsole`) runs every generated visual through this,
renders the complete report per asset, and upserts the composite as the QC
deliverable. Analyses take minutes per asset (Modal cold start + GPU queue);
env override: `MAISTRO_F1X8_BASE_URL`.

### Pipeline note — 7 stages (2026-10-08)

Studio campaigns now run: 01 Moodboard → 02 Thumbnail → 03 Brief →
04 Storyboard → **05 First Draft** (Seedance first cut) → **06 Quality
Check** (real F1X8 on every visual incl. the draft) → **07 Final Content** —
the AI Creative Director's `revise` stage rewrites the draft prompt to
implement F1X8's ranked fixes + revision brief, Seedance re-renders, and the
QC check can be re-run on the final to verify the score improved. External
campaigns pushed over /api/ingest keep their 6-artifact shape; the client
remaps their stage pointer onto the 7-stage pipeline.
