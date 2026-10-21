# Maistro Demo API

Base URL: `https://maistro-demo.vercel.app`

Two endpoints back the demo site and are also public for external consumers
(e.g. a standalone Hermes agent). No authentication is currently required on
`/api/trends`; `/api/hermes` uses the server-side `ANTHROPIC_API_KEY`.

---

## GET /api/trends — pull Samsung-fit trends

Reads TrendRadar's agent API (the published board, bearer `TRENDRADAR_AGENT_KEY`;
since 2026-10-21) and falls back to scraping kymah.com's page payload when the
API is unavailable; returns the board normalized. The response also carries
`live` (false = TrendRadar answered from its build-time snapshot),
`boardGeneratedAt` (when the board was published) and `boardTotal`; each
trend additionally carries `trendId` (TrendRadar's id), `onBrand`,
`signalStrength`, the editorial `brief` and scored `products` when the agent
API answered. An empty board is `200 {count: 0}`, not an error. Responses are edge-cached for 15
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
Errors: `401` bad token · `400` bad stage/projectId · `422` artifact missing
required fields (message lists them) · `503` storage or key not configured.

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

## POST /api/hermes — built-in generator (fallback)

The demo's internal Claude-powered chain (see above section) remains available
for dispatching from the website UI when the external Hermes isn't running.

---

## /api/higgsfield — Studio Create video generation (Seedance 2.5)

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
