# Maistro Contracts

**Version:** 1.1-draft · **Date:** 2026-09-04
**Parent:** [../ARCHITECTURE.md](../ARCHITECTURE.md)

Every boundary in Maistro is governed by a written, machine-checkable
contract. This document defines all five contract families. The normative
artifacts live in `packages/contracts/` (OpenAPI YAML + JSON Schema) and are
generated into typed clients/models; this document is the human-readable
source they are authored from.

> **v1.1 note:** §1 was rewritten on 2026-09-04 after extracting the *actual*
> request/response shapes from the four codebases. Where v1.0 guessed field
> names, v1.1 pins what the code really returns. Verified findings that
> changed the design are marked **[verified]**.

Conventions:

- Timestamps ISO-8601. Maistro-owned ids are UUIDv7; upstream ids are opaque
  strings as issued.
- Errors from Maistro's own surfaces follow RFC 9457 (`application/problem+json`)
  with `retryable: bool`. Upstream tools have their own error shapes, pinned
  per endpoint below; adapters normalize them to `Problem` internally.
- Fields marked **(pin)** are contractually required — contract tests fail if
  missing/mistyped. Unlisted fields may exist and are ignored (tolerant reader).
- **Trend Radar data-honesty rule, adopted verbatim [verified]:** `null`
  means *not measured* — never render or treat as zero/no.

---

## 1. Adapter contracts — what each upstream tool promises Maistro

Normative specs: `packages/contracts/openapi/{trend-radar,f1x8,sentiment,lenceus}.yaml`.
Nightly contract tests call staging endpoints and validate against them.

### 1.1 Trend Radar (kymah.com) — `openapi/trend-radar.yaml`

Auth **[verified]**: `Authorization: Bearer <AGENT_API_KEY>` or
`x-agent-key: <key>`. 401 on bad key, 503 if key unset server-side.
Constraint (ADR D9): read-only; Maistro never triggers collection.

**`GET /api/agent/trends`**
Query: `onBrand?` (bool), `kind?` (`trend|category|moment`), `category?`,
`q?` (substring search), `limit?` (1–200, default 50), `id?` (fetch one raw).
→ `200 {generatedAt, live, total, trends: AgentTrend[]}` **(pin)**

`AgentTrend` **(pin — exact field names from code)**:

```jsonc
{ "id": "string", "name": "string",
  "kind": "trend | category | moment",
  "stage": "string", "growth": "string",
  "category": "string|null", "scope": "global | local",
  "lang": "en | ar | mixed | null",
  "onBrand": "boolean",
  "fit": { "strength": "number 0-100 (pass bar 50)",
           "beat": "string|null", "reason": "string|null" } | null,
  "signalStrength": "number 0-100 | null",   // composite, NOT a probability
  "durabilityClass": "flash | seasonal | ongoing | null",
  "viewsWk": "string|null", "eng": "number|null",
  "sound": { "title": "string|null", "author": "string|null", "cue": "string|null" } | null,
  "format": { "mechanic": "string", "payoff": "string", "props": ["string"],
              "secondsToPayoff": "number|null", "basis": "observed | asserted" } | null,
  "why": "string", "tags": ["string"],
  "firstSeen": "string|null", "runsSeen": "number|null",
  "brief": {                                  // TR's pre-authored EDITORIAL brief
    "microTrend": "string", "mechanic": "string",
    "adaptations": [ { "product": "string", "line": "string", "idea": "string",
      "hook": "string", "samsungify": "string", "insight": "string",
      "execution": "string", "featureMoment": "string",
      "onScreenText": "string", "soundUse": "string", "cta": "string",
      "dos": ["string"], "donts": ["string"] } ],
    "onBrand": ["string"] } | null,
  "products": [ { "product": "string", "line": "string",
                  "reason": "string", "score": "number 0-100" } ] }
```

**Design consequence [verified]:** trends *already carry* an editorial brief
with adaptations, hooks, dos/donts. Maistro's creator-facing Brief (§3.2) is
**composed from** `AgentTrend.brief` + the chosen adaptation + Maistro's
learnings — it does not require calling `/api/agent/brief` at all.

**`GET /api/agent/feed/{kind}`** — kinds are **`sounds` | `terms`** [verified]
(not "trends/keywords"). Envelope `(pin)`: `{generatedAt, live, ...}`.
`sounds` items pin: `{musicId, name, verdict: "format"|"dance", recipe,
soundCue, onScreenText[], soundTitle, soundAuthor, chart: "top"|"viral",
rank, measuredStage, accelerating, confidence, commerciallyCleared: bool|null}`.
`commerciallyCleared` is TikTok's flag only — **not legal clearance**.
`terms` items are loosely-shaped (`rank, term, type, growth, lang` + many
optional measurement fields); adapter treats them as `additionalProperties`.

**`POST /api/agent/brief`** **[verified — different purpose than assumed]**
Request: `{ask (1–2000 chars), trendId?, product?, showProduct?,
language?: "en"|"ar"|"auto", aspect? (default "9:16"), durationCapSec? (≤60)}`
→ `200 {brief: {chain: [{type: "image"|"image-edit"|"video", prompt, inputs,
notes}]}, runnable: boolean, errors: string[], usage, boardLive}`
This authors a **generative media chain** (Higgsfield-style prompts), not an
editorial brief. Maistro uses it optionally, to attach AI-generation starting
points to a Brief. Rate limit **[verified]**: 4/min, 30/hr per key (429 with
`retryAfterSeconds`); the adapter budgets ≤20/hr.

Also available **[verified]**: TR is itself an MCP server (`POST /api/mcp`,
JSON-RPC 2.0; tools `list_trends`, `get_trend`, `author_brief`,
`list_sounds`, `list_keywords`) — same auth, same shapes. Maistro's adapters
use REST; the creator may additionally connect to TR's MCP directly.

### 1.2 F1X8 — `openapi/f1x8.yaml`

Auth: none today — Maistro service key middleware is an M1-W3 deliverable.

**`POST /api/analyze/image`** — **synchronous** [verified], blocks ~10–30s.
multipart/form-data: `file` (required), `title?`, `description?` (advertiser
context/brief — supplying it unlocks `context_score`), `format_type?`
(`social|banner|kv|digital|print|ooh`, default `kv`), `role?`, `lite?`.
→ `200 ImageAnalysisResult` | `200 {error, trace}` (errors are 200-bodied
[verified] — adapter maps to failures).

**`POST /api/analyze/video/submit`** (multipart: `file`, `role?`, `title?`,
`description?`) and **`POST /api/analyze/video-url/submit`** (multipart:
`url`, …) → `200 {job_id}` **[verified paths — not `/api/video/url`]**.

**`GET /api/job/{job_id}`** → `200 {status: "fetching" | "analyzing" |
"done" | "error" | "not_found", result?, error?, trace?}` **(pin)**.

`AnalysisResult` (image & video variants share the core) **(pin)**:

```jsonc
{ "score": "number 0-10",                    // alias of engagement_potential
  "engagement_potential": "number 0-10",
  "organic_engagement": "number", "organic_source": "ranker | weights",
  "kpis_overall": "number",
  "funnel_stage": "upper | mid | lower",
  "product_tier": "mass | mid | premium | luxury | null",
  "kpis": { "<kpi_key>": { "score": "number 0-10", "label": "string",
                           "methodology": "string" } },
  // exactly 5 keys, funnel-dependent, drawn from: attention_capture,
  // message_clarity, emotional_pull, brand_strength, distinctiveness,
  // talkability, hook_strength, watch_pull, persuasive_power, trust_credibility
  "verdict": "Verdict",                      // the diagnosis — see below
  "heatmap": "string|null",                  // base64 PNG (image) / MP4 (video)
  "heatmap_type": "image/png | video/mp4",
  "context_score": "number 0-10",            // present iff description sent
  "context_reasoning": "string",             // present iff description sent
  "benchmarkPercentile": "number 0-100",     // video only [verified]
  "timelines": { "attention": ["number"], "audio_energy": ["number"] } } // video only
```

`Verdict` **[verified — this is where the revise loop's fuel lives]**:

```jsonc
{ "summary": "string",
  "strengths": ["string"],
  "risks": [ { "rank": "number", "issue": "string", "evidence": "string",
               "impact": "string", "suggested_fix": "string",
               "score_lever": "string",      // e.g. "emotional_pull (weight 0.26)"
               "confidence": "high | medium | low" } ],
  "hierarchy_analysis": "string", "brand_visibility": "string",
  "benchmark_context": "string", "diagnostic_caveats": "string",
  "revision_brief": {                        // structured remake plan
    "objective": "string", "focal_hierarchy": "string",
    "headline_copy": "string", "color_type": "string",
    "offer_cta": "string", "imagery": "string", "measurement": "string" } }
```

Adapter contract: always pass the Maistro Brief as `description` so
`context_score` (brief-fit as judged by F1X8) is returned — it feeds J4
(ACCURACY.md). Video polling: up to 30 min, then failed → one resubmit →
escalate. Image sync call: 120s client timeout, one retry.

### 1.3 SamsungSentiment — `openapi/sentiment.yaml`

Auth: **none today [verified]** — service-key middleware is an M1-W3
deliverable. Platform enum uses **`twitter`**, not `x` [verified].

**`GET /api/comments`** — **no query parameters** [verified]; returns the
full corpus, gzip-encoded (~2MB), edge-cached (`s-maxage=300`).
→ `200 {posts: Post[], comments: Comment[], meta}` **(pin)**

`Comment` **(pin)**: `{id, postId, postUrl, platform: "instagram"|"tiktok"|
"facebook"|"twitter", text, username, createdAt, sentiment: "positive"|
"negative"|"neutral", sentimentScore: number|null, sentimentFlags:
["SARCASM"|"COMPETITOR_MENTION"|"MIXED"|"SAFETY_ISSUE"|"PRICE_COMPLAINT"|
"PURCHASE_INTENT"], likes, features[], productModel: string|null,
department: "MX"|"VD"|"DA"|"Brand"|null}`.
`sentimentScore: null` means keyword-fallback classification, not LLM —
`meta.analyzedComments` / `meta.unanalyzedComments` **(pin)** expose the
split; J1 accuracy metrics count LLM-analyzed rows only.

`Post` **(pin)**: `{id, platform, url, caption, timestamp, likes, views,
department, productCategory, productModel, features[]}`.

Adapter note **[verified]**: the corpus endpoint is unfiltered — the adapter
filters client-side by `postUrl`/date for campaign monitoring, and caches per
poll cycle (one fetch per monitoring tick, not per campaign).
`/api/dashboard/data` uses a *different, regex-based* sentiment path — it is
**not used** by Maistro (weaker signal); pinned out of scope.

**`POST /api/apify/trigger`** — `{platform, type?: "posts"|"comments",
targetUsername?}` → `200 {success, message, runId, actorId, status}` **(pin)**.
Rate contract (Maistro-side): ≤1 trigger per campaign per day.

### 1.4 Lenceus — `openapi/lenceus.yaml`

Auth: **none today [verified]** — service-key middleware is an M1-W3
deliverable (its `POST /api/run` being open is a real exposure).

**`GET /api/health`** → `{ok: true, backend: "sqlite"|"supabase"}` **(pin)**.
**`GET /api/sites`** → `{sites: Site[]}`. `Site` **(pin)**: `{id, name, url,
region, type: "operator"|"retailer", count: number|null, bannerTotal,
promoCount, promoTotal, tileCount, tileTotal, lastRunAt: string|null,
matches: [{key, src, alt, href, pos, section: "hero"|"promo"|"tile"}],
deviceShare: {total, samsung, sharePct: number|null, brands: {}} | null,
searchShare: {total, samsung, sharePct: number|null, brands: {}} | null,
history: [{run_at, count, bannerSharePct, deviceSharePct, searchSharePct,
promoSharePct, tileSharePct, placementBrands, catalogBrands}]}` (history =
last 60 runs; share fields nullable — null is *not measured*).
**`GET /api/log?limit=`** (≤200) → `{events: [{id, site_id, site, run_at,
count, deviceSharePct, searchSharePct}]}` **(pin)**.
**`POST /api/run`** → `200 {ok, results: [{id, name, prev, count, error?}],
changed}` | `409 {error}` when a run is in progress **[verified guard]**.
Maistro reads only (`sites`/`log`); it never calls `/api/run` (Lenceus has
its own daily schedule).

---

## 2. MCP tool contracts — what Maistro promises the content creator

Served by Maistro's MCP server. Auth: per-creator scoped key; a creator sees
only campaigns assigned to them. Every call is audit-logged.
Stability promise: tool names and pinned fields are **append-only** for the
project's duration.

### `list_assigned_briefs` `()` →
```jsonc
[{ "campaign_id": "uuid", "brief_id": "uuid", "trend_summary": "string",
   "format": "string", "deadline": "timestamp",
   "status": "awaiting_draft | revising | scoring | awaiting_approval" }]
```

### `get_brief` `(brief_id)` → `Brief` (§3.2)

### `submit_draft` `(brief_id, asset, notes?)`
`asset`: file upload (image/video) or URL. Resumes the paused graph run.
→ `{draft_id, campaign_id, iteration, status: "scoring"}`
Errors: `409 already_submitted`, `410 campaign_closed`, `422 asset_invalid`
(video ≤ 500 MB mp4/mov; image ≤ 30 MB png/jpg).

### `get_feedback` `(draft_id)` →
```jsonc
{ "draft_id": "uuid", "status": "scoring | scored",
  "score": "number|null", "summary": "string|null",
  "strengths": ["string"], 
  "risks": [{ "rank": 1, "issue": "…", "suggested_fix": "…",
              "score_lever": "…", "confidence": "high|medium|low" }],
  "revision_brief": "RevisionBrief|null",   // F1X8's structured remake plan (§1.2)
  "brief_fit_score": "number|null",         // F1X8 context_score vs. the Brief
  "iteration": 2, "max_iterations": 4,
  "outcome": "revise | proceed_to_approval | loop_exhausted" }
```

### `submit_final` `(draft_id)` → `{status: "awaiting_approval"}`
Creator's explicit sign-off; routes to approval even below threshold
(approver sees the flag).

### `get_campaign_status` `(campaign_id)` →
`{status, timeline: [{event, at}], current_iteration, published_url?}`

---

## 3. Data contracts — shared entities Maistro owns

JSON Schemas in `packages/contracts/schemas/`; DDL in
[DATA-MODEL.md](DATA-MODEL.md).

### 3.1 Campaign — `schemas/campaign.json`
```jsonc
{ "campaign_id": "uuid",
  "trend_ref": { "trend_id": "string", "snapshot": "AgentTrend" },  // frozen at selection
  "brief_id": "uuid", "status": "CampaignStatus",
  "creator_id": "string", "current_version": "number",
  "max_iterations": 4, "score_threshold": 7.0,      // placeholder until M3 calibration
  "created_at": "timestamp", "closed_at": "timestamp|null",
  "state_version": "number" }
```
The trend snapshot is frozen — TR's live data keeps moving; the campaign
records what was true at decision time.

### 3.2 Brief — `schemas/brief.json`
The creator's working document. **Composed** (not fetched): TR's embedded
editorial brief (`AgentTrend.brief`) + the selected adaptation + Maistro
learnings + logistics. Field set finalized with the creator in M1-W3.
```jsonc
{ "brief_id": "uuid", "campaign_id": "uuid",
  "trend": { "name": "string", "why_now": "string",   // from AgentTrend.why
             "stage": "string", "sound": "Sound|null",
             "format": "Format|null", "evidence_tags": ["string"] },
  "angle": "string",                     // from chosen adaptation.idea/samsungify
  "product": { "product": "string", "line": "string" },
  "format": "string",                    // e.g. "15s vertical video, sound-led"
  "hooks": ["string"],                   // adaptation.hook + variants
  "on_screen_text": "string|null", "sound_use": "string|null",
  "cta": "string|null",
  "dos": ["string"], "donts": ["string"],   // adaptation + brand-safety hard rules
  "kpi_focus": "string",                 // intended funnel stage → F1X8 weighting
  "references": [{ "url": "string", "note": "string" }],
  "generative_starters": "BriefChain|null",  // optional TR /api/agent/brief output
  "deadline": "timestamp",
  "learnings_applied": ["uuid"] }
```

### 3.3 ContentVersion — `schemas/content-version.json`
```jsonc
{ "content_version_id": "uuid", "campaign_id": "uuid",
  "iteration": "number", "asset_ref": "string",
  "media_type": "image | video",
  "submitted_by": "string", "submitted_at": "timestamp",
  "creator_notes": "string|null",
  "f1x8_job_id": "string|null",          // null for sync image analysis
  "analysis_result": "AnalysisResult|null" }   // frozen F1X8 snapshot (§1.2)
```

### 3.4 Learning — `schemas/learning.json`
```jsonc
{ "learning_id": "uuid", "campaign_id": "uuid",
  "predicted_score": "number", "predicted_percentile": "number|null",
  "actual_metrics": { "views": "n", "engagement_rate": "n",
                      "sentiment_mean": "n", "comment_count": "n" },
  "actual_percentile": "number|null", "delta": "number|null",
  "insight": "string",
  "insight_status": "candidate | confirmed | retired",
  "created_at": "timestamp" }
```
Only `confirmed` learnings are injected into future briefs (top-K, K=5).

### 3.5 Approval — `schemas/approval.json`
```jsonc
{ "approval_id": "uuid", "campaign_id": "uuid",
  "content_version_id": "uuid",          // approves EXACTLY this version
  "decision": "approved | rejected",
  "approver_id": "string", "note": "string",
  "brief_fit_rubric": { "hook_present": "bool", "format_followed": "bool",
                        "donts_respected": "bool", "angle_preserved": "bool" },
  "decided_at": "timestamp", "revoked_at": "timestamp|null" }
```

---

## 4. LangGraph state contract

Defined in DATA-MODEL.md §3. Rules: typed (Pydantic), versioned
(`state_version`); changes additive-only or shipped with a checkpoint
migration; chaos suite replays a persisted in-flight campaign against the
new schema before merge; each node declares read/write fields (enforced by
reducer + lint).

---

## 5. Publishing contracts — `schemas/publish-request.json`, `schemas/publish-result.json`

```jsonc
// PublishRequest
{ "idempotency_key": "string",   // campaign_id + platform + content_version_id
  "campaign_id": "uuid", "content_version_id": "uuid",
  "approval_id": "uuid",         // hard precondition, verified unrevoked
  "platform": "tiktok | instagram | facebook | x",
  "asset_ref": "string", "caption": "string", "hashtags": ["string"],
  "scheduled_at": "timestamp|null" }

// PublishResult
{ "publish_record_id": "uuid",
  "status": "published | failed | skipped_duplicate",
  "platform_post_id": "string|null", "post_url": "string|null",
  "published_at": "timestamp|null", "error": "Problem|null" }
```

Driver MUST: (a) check `publish_records` for a completed row with the same
idempotency key before any platform call → `skipped_duplicate`; (b) write the
pending record **before** the call; (c) treat platform-side ambiguity
(timeout after send) as `unknown` and reconcile via platform lookup before
retrying. Staging runs dry-run (everything except the platform call).

Note: Maistro's publish platform enum uses `x`; SamsungSentiment's data uses
`twitter` — the sentiment adapter maps `twitter → x` at the boundary.

---

## 6. Contract lifecycle & enforcement

- **Authoring:** change YAML/JSON Schema in `packages/contracts/` first;
  `make codegen`; fix what the compiler surfaces. Edits to generated code are
  CI-rejected (drift check).
- **Versioning:** semver per spec file (`info.version` / `$comment`). Minor =
  additive; major = breaking → migration note + consumer sign-off.
- **CI per PR:** schema lint + codegen-drift check.
- **CI nightly:** live contract tests against staging deployments of all four
  tools + Maistro's own API/MCP surface. Failures open an issue tagged with
  the owning tool.
- **Tolerant reader:** consumers ignore unknown fields; producers never
  repurpose an existing field's meaning.
