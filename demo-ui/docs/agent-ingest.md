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
- **Scope.** The key works on the `/api/agent/*` endpoints below only, and only on campaigns created through the
  API (the campaign's plan says `source: "hermes"`). Studio campaigns answer 403. It has no admin rights.
- **Auth.** `Authorization: Bearer <AGENT_INGEST_KEY>`.
  - The key lives in the Vercel env var `AGENT_INGEST_KEY` (production) and is never logged.
  - Without the variable, every call answers 503.
  - **To revoke:** remove or change the variable and redeploy. **To rotate:** set a new value, redeploy, then
    update the Hermes vault.
  - **Expiry:** none. The key works until it is rotated or removed; the old value stops working at the next deploy.
  - **Key check:** `GET /me` (or `/ping`) answers 200 with a non-secret `keyId` (`ak_` + the first 12 hex of the
    key's sha-256), the scopes, the limits and the allowed products. It creates nothing.
- **Edge.** The API is served by Vercel directly, with no Cloudflare or WAF in front. Authenticated calls with
  `User-Agent: Hermes/1.0` or Python's default agents reach the handler (checked 2026-11-03: all get the handler's
  own JSON answer).
- **No staging.** There is one deployment. Use test campaigns (below) to rehearse a push on production.
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

| | |
|---|---|
| `GET /me` | key check |
| `POST /campaigns` | create a campaign |
| `GET /campaigns?source=hermes&limit=50&external_ref=…` | list Hermes's campaigns, newest first |
| `GET /campaigns/{id}` | read one back, with reviewer comments |
| `DELETE /campaigns/{id}` | test campaigns only |
| `POST /campaigns/{id}/brief` | a brief |
| `POST /campaigns/{id}/uploads` | a signed upload into Maistro's storage |
| `POST /campaigns/{id}/assets` | an asset |
| `POST /campaigns/{id}/storyboard` | a storyboard |

### 1. `POST /campaigns`

```json
{ "title": "Fridge Girly", "trend": { "id": "t-77", "name": "Fridge Girly" },
  "product": { "family": "Galaxy Z Flip8", "colour": "Pink" },
  "supporting_products": [ { "family": "Galaxy Buds4", "colour": "White" } ],
  "markets": ["UAE"], "platforms": ["tiktok"], "source": "hermes",
  "external_ref": "fridge-girly-2026-11", "test": false }
```

→ `201 { "campaignId": "gen-h3f9a…", "source": "hermes", "state": "draft", "planVersion": 1, "product": {…}, "supportingProducts": […], "externalRef": "…", "test": false }`

- **Product lock.** `product` is the hero; `supporting_products` (up to 4) are the only other products that may
  appear in this campaign's assets.
  - Every product must be known: the render specs, the brand catalog, the knowledge-base catalog, or the agent
    code table `AGENT_PRODUCT_CODES` (`api/_studio/hermes-contract.js`). An unknown one answers
    `422 { code: "unknown_product", problems: ["unknown_product", …], allowed: { products, colours } }`.
  - Where colourways are known, the colour must be one of them, and a `model_code` that disagrees with it is a
    422. A missing model code is filled in. A model code alone names its product and colour.
  - Codes as of 2026-11-03: Z Flip8 Cream `SM-F776BZWOMEA`, Graphite `SM-F776BZKOMEA`, Pink `SM-F776BLIPMEA`,
    Mint (code not confirmed, null); Buds4 White `SM-R540NZWAMEA`, Black `SM-R540NZKAMEA`; Buds4 Pro (no colour
    codes yet, any colour accepted); Bespoke AI Fridge (also "Bespoke AI Refrigerator") Snow White `RS80F64G1VRE`.
    The Flip8/Buds4/fridge codes came from the Hermes operator and are not yet checked against samsung.com/ae.
  - The Studio shows supporting products as an **ALSO:** badge on every stage.
- **`external_ref`:** Hermes's own campaign id, echoed in every read and usable as a list filter.
- **`test: true`** (or the header `X-Maistro-Test: 1`): a test campaign. It never appears in the Studio's review
  queue and can be deleted through the API.
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
{ "kind": "moodboard" | "thumbnail" | "keyframe" | "video" | "carousel_slide" | "audio", "url": "https://…",
  "direction": 2, "shot_index": 2, "shot_count": 3, "slide_index": 1, "slide_count": 6, "variant": "music_a",
  "meta": { "qa": {…}, "compliance": {…}, "audio": {…}, "variation_plan": […], "swap_proposals": […],
            "shot_list": […], "story": {…}, "note": "…", "title": "…" } }
```

**Compliance (`meta.compliance`, Samsung content guidelines 2026-11-02)**

```json
{ "guidelines_version": "2026-11-02", "characters": "stylised_3d" | "2d_illustrated" | "none",
  "realistic_humans": false, "ai_generated_samsung_device": false,
  "product_sources": [ { "product": "Galaxy Buds4 White", "source": "official_product_image" },
                       { "product": "Galaxy Z Flip8 box", "source": "ai_render_from_official_box_refs" } ],
  "third_party_logos": false, "alcohol": false }
```

- **Optional, but checked when present.**
- **Hard rules:** `realistic_humans: true` or `ai_generated_samsung_device: true` answers
  `422 compliance_violation`.
- **`product_sources`:** each `product` must name the hero or a supporting product (`product_not_in_campaign`
  otherwise). The `source` is one of `official_product_image`, `official_3d_cad`,
  `ai_render_from_official_box_refs` or `real_footage`.
- **Logos and alcohol:** `third_party_logos` and `alcohol` are shown to reviewers as alert badges.
- **In the Studio:** reviewers see a COMPLIANCE badge (the character style), the declaration in its tooltip, and
  the product sources under the asset.

**Audio (`meta.audio`)**

- **Shape:** `{ "source": "original_ai_generated" | "licensed" | "none", "model": "…", "licensing": "cleared" | "none" | "unknown" }`.
- **In the Studio:** shown on the video or track as an audio badge.

**Download and copy-in**

- **Hosts:** the URL must be on an allowed media host: the Hermes gateway (`HERMES_API_URL`), Maistro's
  Supabase, `*.cloudfront.net`, `*.higgsfield.ai`, `*.amazonaws.com`, plus any listed in `QC_ASSET_HOSTS`.
  Anything else answers 422 `host_not_allowed`.
- **Copy:** Maistro downloads the file (200 MB at most, else 413) and stores it in the private `assets` bucket at
  `pieces/<campaignId>/<stage>/<time>-<sha12>.<ext>`.
- **Type:** decided from the file's first bytes, not the server's Content-Type. Only png, jpg, webp, mp4, m4a, mp3
  and wav are accepted (415 otherwise). A video must be an mp4, an audio track an m4a, mp3 or wav (20 MB at most),
  and the image kinds (moodboard, thumbnail, keyframe, carousel_slide) images.
- **Own uploads:** a `url` returned by `POST /uploads` is read from Maistro's storage instead and must match the
  sha256 and size declared there (`upload_mismatch`, or `upload_missing` before the PUT).

**Where each kind lands**

| kind | stage | how |
|---|---|---|
| `moodboard` | mood | Needs `direction` (1–3). The image goes into that direction's two slots; a third image replaces the oldest. `variation_plan`, `swap_proposals`, `qa` and `note` go on the direction. With no moodboard yet, a three-direction draft is made first. |
| `thumbnail` | thumb | A new thumbnail version with `qa`, `note` and the full `meta`. |
| `keyframe` | board | Needs `shot_index`. Fills that shot's keyframe on the current storyboard; a keyframe already there goes to the shot's history. With no storyboard yet, a draft one is made from `meta.shot_list` (or `shot_count` blank shots) and `meta.story`. |
| `video` with `shot_index` | draft | That part's clip on the current draft. With no draft yet, a draft of `shot_count` parts is made first. |
| `video` without `shot_index` | draft | The whole cut. It becomes the assembled video of the current Hermes draft, or else a one-part draft. Width, height and duration come from the mp4. |
| `video` with `variant` | draft | One sound version of the whole cut (`music_a`, `no_audio`, …). Variants sit side by side in `cuts`; the first one pushed is also the assembled video that review and QC read. A re-push of a variant replaces it and keeps the old one in its history. |
| `carousel_slide` | draft | Needs `slide_index` (1–20); `slide_count` says how many to expect. Slides sit in order in the draft's `carousel` and the Studio shows them as one swipeable carousel. A re-push of an index replaces that slide and keeps the history. |
| `audio` | draft | A standalone music track (m4a, mp3, wav, 20 MB at most), with `meta.title` and `meta.audio`. |

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

- the title, `source`, status, product (family, colour, model code), `supportingProducts`, `externalRef`, `test`,
  trend, markets and platforms;
- each stage's state, its current version (number, `producedBy: "external_hermes"`, payload), its latest human
  decision and its `comments`;
- `comments[]`: all reviewer feedback, as
  `{ stage, shot?, assetId, author, role, text, reasonCode, createdAt, decision: "approved" | "rejected" }`.
  - A stage decision carries `assetId: null`; a storyboard or draft shot review names the asset it was about.
  - Maistro has approve and reject only: a reject always means "make a new version"; the reason is in `text`.
- `assets[]`: every pushed asset with `assetId`, `kind`, `assetPath`, `sha256`, `size`, `contentType`, `meta`,
  `sourceUrl` and where it was attached.

### 6. `GET /me`

`200 { source: "hermes", keyId: "ak_…", scopes: […], expiresAt: null, rotation: "…", limits: {…}, products: { products, colours } }`

### 7. `GET /campaigns?source=hermes&limit=50`

`200 { campaigns: [ { campaignId, title, status, product, externalRef, test, createdAt } ] }`, newest first.

- **Limit:** 100 at most.
- **`external_ref=…`** filters on Hermes's own id.
- **Deleted test campaigns** are left out.

### 8. `POST /campaigns/{id}/uploads`

For finals that exist only on the Hermes machine (composites, music muxes, edited stills), so they need not be
re-hosted on a third-party CDN.

```json
{ "filename": "fridge-girly-final.mp4", "contentType": "video/mp4", "size": 18874368, "sha256": "<64 hex>" }
```

→ `201 { uploadId, uploadUrl, method: "PUT", headers: { "Content-Type": "video/mp4" }, expiresAt, url, path }`

1. `PUT` the bytes to `uploadUrl` with those headers. The URL is single-use and lives about two hours.
2. Push `url` as a normal asset (`POST /assets` with `"url": "<url>"`). Maistro reads it from its own storage and
   checks the sha256 and size against what was declared here.

- **Where it lands:** the private bucket under `agent-uploads/<campaignId>/`. Another campaign's upload url is
  refused.
- **Size:** the Supabase project's file-size limit still applies on top of the 200 MB cap.

### 9. `DELETE /campaigns/{id}`

Test campaigns only (`403 not_test_campaign` otherwise) → `200 { campaignId, deleted: true }`.

- **Not erased:** the campaign tables keep every version (restrict foreign keys, audit trail), so the campaign is
  marked deleted and hidden instead.
- **After it:** every call on it answers 404, and listings skip it.

## Webhook: reviewer feedback to Hermes

When a person decides a stage (approve, reject, reopen) or reviews a storyboard or draft shot on a campaign made
through this API, Maistro POSTs the event to `HERMES_WEBHOOK_URL` (default
`https://hermes.maistro-agents.com/hooks/maistro`).

```json
{ "type": "stage.decision" | "shot.review" | "stage.reopened", "campaignId": "gen-h…", "stage": "thumb",
  "shot": 2, "versionId": "…", "assetId": "as_…" | null, "decision": "approved" | "rejected",
  "comment": { "author": "…", "text": "…", "reasonCode": "…", "createdAt": "…" }, "at": "…" }
```

- **Signature:** `X-Maistro-Timestamp: <unix seconds>` and
  `X-Maistro-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">`, keyed with `HERMES_WEBHOOK_SECRET`.
  Hermes should reject a bad signature or a timestamp more than 5 minutes old.
- **Off** until `HERMES_WEBHOOK_SECRET` is set in Vercel (the same value goes in the Hermes vault).
- **Best effort:** 4-second timeout, no retries. A failing receiver never blocks a decision, and `GET` stays the
  source of truth.
- **Code:** `api/_agent-hooks.js`.

## In the Studio

- **Where they appear:** Hermes campaigns show up in the Studio like any campaign. People can review, regenerate,
  approve or reject them there; the API never does.
- **Badge:** every stage whose current version came through the API carries a **SOURCE: HERMES** badge.
- **QA:** the asset's `meta.qa` shows as the usual QA badges and notes on the moodboard direction, the
  storyboard shot, the thumbnail and the draft.
- **Compliance and audio:** `meta.compliance` and `meta.audio` show as badges on the same places.
- **Draft extras:** sound versions sit side by side, carousel slides in order, music tracks with a player.
- **Hidden:** test campaigns and deleted ones never appear.

## Bookkeeping, without a migration

The API keeps its records in `audit_log` (the append-only table from migration 005):

| action | what it is |
|---|---|
| `agent.request` | One row per authorised request. The last minute's rows set the rate limit. |
| `agent.idem` | The first answer per Idempotency-Key (stored as a sha-256 of key + method + path), for replays. |
| `agent.asset` | The campaign's asset registry (`entity_id` = the campaign's piece uuid). |
| `agent.upload` | The signed uploads asked for, with the declared sha256 and size. |

**Failure handling:** if `audit_log` can't be read, the rate check lets the request through and logs it, like the
login throttle.

## Try it

```
node scripts/agent-ingest-smoke.js <file holding the key> [--base=https://www.ma1stro.com]
```

The script:

1. Checks the key with `GET /me`.
2. Creates a TEST campaign "zz test · agent ingest" (Galaxy Z Flip8 Pink, with Galaxy Buds4 White as a
   supporting product).
3. Sends the same create again with the same Idempotency-Key, to show the replay.
4. Sends a create with fields missing, and one with an unknown product, to show the 422s.
5. Reads the campaign back, finds it by `external_ref` in the list, deletes it, and checks it answers 404 after.

The prompt Hermes's bots follow is `docs/hermes-agent-prompt.md`.

It never prints the key, approves nothing and spends nothing.
