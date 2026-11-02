# Agent ingest API

Hermes (the AI production agent) uses this API to create campaigns in Maistro and push what it made: a brief,
moodboard / thumbnail / keyframe / video assets, and a storyboard. Hermes never gets database credentials.

- **Base URL:** `https://www.ma1stro.com/api/agent` (also `https://maistro-demo.vercel.app/api/agent`). It is
  open past the coming-soon gate, like every `/api/` path.
- **Code:** `api/_handlers/agent.js`. The routing is `vercel.json` `rewrites` plus `agent` in `api/[route].js`.
- **Tests:** `tests/api/agent.test.js`. **Smoke test:** `scripts/agent-ingest-smoke.js`.

## Rules

- **Drafts only.** Everything Hermes sends becomes a new version with stage state `generated`, waiting for people
  in the Studio. No endpoint approves, rejects, reopens, schedules or publishes. A stage a person has already
  approved can't be written to (409 `approved_immutable`) until a person reopens it.
- **Scope.** The key works on these five endpoints only, and only on campaigns created through the API (the
  campaign's plan says `source: "hermes"`). Studio campaigns answer 403.
- **Auth.** `Authorization: Bearer <AGENT_INGEST_KEY>`.
  - The key lives in the Vercel env var `AGENT_INGEST_KEY` (production) and is never logged.
  - Without the variable, every call answers 503.
  - **To revoke:** remove or change the variable and redeploy. **To rotate:** set a new value, redeploy, then
    update the Hermes vault.
  - This key is separate from `MAISTRO_INGEST_KEY`, which belongs to the older event push at `POST /api/ingest`.
- **Rate limit.** 60 requests a minute across the key. Over the limit: 429 with `Retry-After: 60`.
- **Idempotency.** Send `Idempotency-Key` on any POST. A repeat with the same key and path returns the first
  answer (same status and body, header `Idempotent-Replayed: true`) and writes nothing. A campaign create with a key
  always gets the same campaign id, so two racing first requests can't make two campaigns.
- **Validation.** Bodies are checked with zod. A bad body answers 422:
  `{ "error": "validation failed", "code": "invalid", "missing": ["trend", …], "problems": ["source: …"] }`.
  `missing` lists the required fields that are absent; `problems` lists everything else.
- **Bodies.** `application/json` only. Multipart uploads are not accepted (415): a Vercel function body is
  capped at 4.5 MB, so Hermes sends a public https URL and Maistro downloads it.

## Endpoints

### 1. `POST /campaigns`

```json
{ "title": "Unfold the skyline", "trend": { "id": "t-42", "name": "Skyline reveal" },
  "product": { "family": "Galaxy Z Fold8", "colour": "Cream", "model_code": "SM-F971BZWIMEA" },
  "markets": ["UAE"], "platforms": ["tiktok"], "source": "hermes" }
```

→ `201 { "campaignId": "gen-h3f9a…", "source": "hermes", "state": "draft", "planVersion": 1 }`

- **Product.** The family is matched to the catalog name. The colour and model code are kept on the plan. A
  missing model code is filled from the catalog when the colourway is known (see `hermes-integration.md`,
  "Products").
- **Required.** `title`, `trend.name`, `product.family`, `markets` (1–12), `platforms` (1–4), and `source`, which
  must be `"hermes"`.
- **Ids.** Campaign ids are `gen-h` plus 12 hex characters. They fit the Hermes session id pattern
  (`maistro-gen-<alnum>-<role>`).

### 2. `POST /campaigns/{id}/brief`

`{ "brief": { … } }`: the same brief contract Maistro's brief bot returns (`api/_studio/brief.js` `SCHEMA`).

- **Required keys:** `objective`, `successMetric`, `audience{description, markets}`,
  `trendHook{mechanic, samsungAdaptation}`, `keyMessage`, `products[]`, `claims[]`, `cta`, `tone`,
  `format{platform, targetDurationS, aspect}`, `languagePlan{register: gulf_arabic|msa|english|bilingual}`,
  `audio{licensing: none|cleared|unknown}`, `mandatories` (3 or more), `doNots`, `hashtags{en[], ar[]}`,
  `caption{en, ar}`, `deadline` (like "12 Nov 2026"), and optionally `storyline`.
- **Result:** a new brief version, not approved.
- **Response:** `201 { versionId, version, state: "generated", needsReview: true }`.

### 3. `POST /campaigns/{id}/assets`

```json
{ "kind": "moodboard" | "thumbnail" | "keyframe" | "video", "url": "https://…",
  "direction": 2, "shot_index": 2, "shot_count": 3,
  "meta": { "qa": {…}, "variation_plan": […], "swap_proposals": […], "shot_list": […], "story": {…}, "note": "…" } }
```

**Download and copy-in**

- **Hosts:** the URL must be on an allowed media host: the Hermes gateway (`HERMES_API_URL`), Maistro's
  Supabase, `*.cloudfront.net`, `*.higgsfield.ai`, `*.amazonaws.com`, plus any listed in `QC_ASSET_HOSTS`.
  Anything else answers 422 `host_not_allowed`.
- **Copy:** Maistro downloads the file (200 MB at most, else 413) and stores it in the private `assets` bucket at
  `pieces/<campaignId>/<stage>/<time>-<sha12>.<ext>`.
- **Type:** decided from the file's first bytes, not the server's Content-Type. Only png, jpg, webp and mp4 are
  accepted (415 otherwise). A video must be an mp4; the image kinds must be images.

**Where each kind lands**

| kind | stage | how |
|---|---|---|
| `moodboard` | mood | Needs `direction` (1–3). The image goes into that direction's two slots; a third image replaces the oldest. `variation_plan`, `swap_proposals`, `qa` and `note` go on the direction. With no moodboard yet, a three-direction draft is made first. |
| `thumbnail` | thumb | A new thumbnail version with `qa`, `note` and the full `meta`. |
| `keyframe` | board | Needs `shot_index`. Fills that shot's keyframe on the current storyboard; a keyframe already there goes to the shot's history. With no storyboard yet, a draft one is made from `meta.shot_list` (or `shot_count` blank shots) and `meta.story`. |
| `video` with `shot_index` | draft | That part's clip on the current draft. With no draft yet, a draft of `shot_count` parts is made first. |
| `video` without `shot_index` | draft | The whole cut. It becomes the assembled video of the current Hermes draft, or else a one-part draft. Width, height and duration come from the mp4. |

**Response and bookkeeping**

- **`meta`** (64 KB at most) is kept whole in the asset registry. `qa` (normalised: checked / passed /
  regenerated / dropped / product / spec_card / notes / verdict) and `note` are also put on the asset in the
  version, which is where the Studio shows them.
- **Response:** `201 { assetId: "as_<24 hex>", kind, assetPath, sha256, size, contentType, attached: {stage, versionId, …}, needsReview: true }`.

### 4. `POST /campaigns/{id}/storyboard`

```json
{ "story": { "logline": "…", "product_truth": "…", "emotional_arc": "…" },
  "shots": [ { "index": 1, "act": "Act 1", "beat": "opening", "duration_s": 3, "shot_size": "close_up",
               "angle": "low angle", "lens": "35mm", "move": "slow push-in", "action": "…",
               "device_pose": "closed, cover screen to camera", "keyframe_asset_id": "as_…" } ] }
```

- **Shots:** 1 to 12, with `index` running 1..N.
- **Keyframes:** `keyframe_asset_id` must name an image asset already pushed to this campaign (422 otherwise).
  Without it, a keyframe already at that index on the current storyboard is kept, so keyframes can arrive before
  the storyboard.
- **Result:** a new storyboard version.
- **Response:** `201 { versionId, version, shots, keyframes, state: "generated", needsReview: true }`.

### 5. `GET /campaigns/{id}`

The whole campaign, so Hermes can verify every upload:

- the title, `source`, status, product (family, colour, model code), trend, markets and platforms;
- each stage's state, its current version (number, `producedBy: "external_hermes"`, payload) and any human
  decision;
- `assets[]`: every pushed asset with `assetId`, `kind`, `assetPath`, `sha256`, `size`, `contentType`, `meta`,
  `sourceUrl` and where it was attached.

## In the Studio

- **Where they appear:** Hermes campaigns show up in the Studio like any campaign. People can review, regenerate,
  approve or reject them there; the API never does.
- **Badge:** every stage whose current version came through the API carries a **SOURCE: HERMES** badge.
- **QA:** the asset's `meta.qa` shows as the usual QA badges and notes on the moodboard direction, the
  storyboard shot, the thumbnail and the draft.

## Bookkeeping, without a migration

The API keeps its records in `audit_log` (the append-only table from migration 005):

| action | what it is |
|---|---|
| `agent.request` | One row per authorised request. The last minute's rows set the rate limit. |
| `agent.idem` | The first answer per Idempotency-Key (stored as a sha-256 of key + method + path), for replays. |
| `agent.asset` | The campaign's asset registry (`entity_id` = the campaign's piece uuid). |

**Failure handling:** if `audit_log` can't be read, the rate check lets the request through and logs it, like the
login throttle.

## Try it

```
node scripts/agent-ingest-smoke.js <file holding the key> [--base=https://www.ma1stro.com]
```

The script does four things:

1. Creates "zz test · agent ingest" (Galaxy Z Fold8, Cream).
2. Sends the same create again with the same Idempotency-Key, to show the replay.
3. Sends a create with fields missing, to show the 422.
4. Reads the campaign back.

It never prints the key, approves nothing and spends nothing.
