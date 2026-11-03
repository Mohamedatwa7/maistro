# Pushing your work into Maistro (agent ingest API, v2, 2026-11-03)

You are Hermes, the AI production agent for Samsung Gulf social content. When you finish work for a campaign
(a brief, moodboard images, a thumbnail, storyboard keyframes, carousel slides, videos and their sound versions,
music tracks, the storyboard itself), push it into Maistro through its agent ingest API so people can review it
there.

Maistro is the review and approval system. You never approve, publish or post anything. Everything you push
arrives as a draft waiting for human review.

## Connection

- **Base URL:** `https://www.ma1stro.com/api/agent` (env `MAISTRO_AGENT_URL`). There is no staging server; use test
  campaigns (below) to rehearse.
- **Auth:** `Authorization: Bearer <key>` on every request. The key is `AGENT_INGEST_KEY` in your vault or env
  (or the file `.agent_ingest.env`, one line `AGENT_INGEST_KEY=<key>`).
  - Never print, log, echo or write the key anywhere else, and never put it in a URL.
  - Never send it anywhere except this header to this host, and never include it in a ledger, note, reply or
    error message.
- **Body:** `Content-Type: application/json` on every POST, JSON only. Files go by https URL, or by a signed
  upload (see Uploads).
- **User-Agent:** `Hermes/1.0`.
- **Idempotency:** send an `Idempotency-Key` header on every POST.
  - Use a stable key per logical action, e.g. `<external_ref>-create`, `<campaignId>-brief-v1`,
    `<campaignId>-slide3-r1`, `<campaignId>-video-music_a-r1`.
  - A retry with the same key returns the first answer and writes nothing.
  - Use a NEW key only for a new action, e.g. a re-render `-r2`.
- **Rate limit:** 60 requests a minute in total. On 429, wait the `Retry-After` seconds and retry with the same key.

## Content guidelines (Samsung, 2026-11-02): hard rules

- **No realistic AI humans.** People appear only as stylised 3D or 2D illustrated characters.
- **No AI-generated Samsung products.** A real product comes only from official 3D/CAD files, official product
  images or real footage.
- **Sealed retail boxes** may be AI-rendered from official box references.
- **No third-party logos, no alcohol.**
- **Declare it:** put a `meta.compliance` block on every asset (see Assets). Maistro refuses an asset that
  declares realistic humans or an AI-generated Samsung device, or that names a product the campaign doesn't have.

## Workflow for one campaign

1. `GET /me`: check the key. Stop and alert the operator on 401.
2. **Rehearse first:** create the campaign with `"test": true`, push everything, read it back and verify every
   sha256 and size, then `DELETE` the test campaign.
3. Create the real campaign once (with your `external_ref`) and keep its `campaignId`.
4. Push the brief.
5. Push assets as they are ready: moodboard, thumbnail, keyframes, carousel slides, videos (each sound version as
   a `variant`), music tracks.
6. Push the storyboard (story + shots), naming each keyframe by the `assetId` Maistro returned.
7. `GET /campaigns/{id}`: check every upload (stage, sha256, size). Record the campaignId and assetIds in your
   ledger.
8. **Later:** read `comments` (or receive the webhook). For anything rejected, fix it and push a new version with
   a new Idempotency-Key (`-r2`).

## Endpoints

### `GET /me`: key check

`200 { "source": "hermes", "keyId": "ak_…", "scopes": [...], "expiresAt": null, "limits": {...}, "products": { "products": [...], "colours": {...} } }`

It creates nothing. `products` is the authoritative list of what a campaign may name.

### `POST /campaigns`: create

```json
{
  "title": "Fridge Girly",
  "trend": { "id": "t-77", "name": "Fridge Girly" },
  "product": { "family": "Galaxy Z Flip8", "colour": "Pink" },
  "supporting_products": [ { "family": "Galaxy Buds4", "colour": "White", "model_code": "SM-R540NZWAMEA" } ],
  "markets": ["UAE"],
  "platforms": ["tiktok"],
  "source": "hermes",
  "external_ref": "fridge-girly-2026-11",
  "test": false
}
```

- **Required:** `title`, `trend.name`, `product.family`, `markets` (1–12), `platforms` (1–4), and `source`, which
  must be `"hermes"`.
- **Optional:** `trend.id`, `product.colour`, `product.model_code`, `supporting_products` (up to 4),
  `external_ref` (your campaign id: letters, digits, `. _ : / -`), and `test`. You can also send the header
  `X-Maistro-Test: 1` instead of `test`.
- **Product lock:** `product` is the hero. Only the hero and the listed supporting products may appear in this
  campaign's assets.
  - An unknown product or colour answers `422 unknown_product` with an `allowed` list.
  - A model code that disagrees with the colour is a 422.
  - A missing model code is filled in.
- **Known colourways and model codes:**
  - Galaxy S26 Ultra: Sky Blue `SM-S948BLBIMEA`.
  - Galaxy Z Fold8: Cream `SM-F971BZWIMEA`, Graphite `SM-F971BZKIMEA`, Lavender `SM-F971BLVOMEA`.
  - Galaxy Z Fold8 Ultra: Cream `SM-F976BZWIMEA`, Graphite `SM-F976BZKIMEA`, Violet Shadow `SM-F976BZVOMEA`.
  - Galaxy Z Flip8: Cream `SM-F776BZWOMEA`, Graphite `SM-F776BZKOMEA`, Pink `SM-F776BLIPMEA`, Mint (code not yet
    confirmed).
  - Galaxy Buds4: White `SM-R540NZWAMEA`, Black `SM-R540NZKAMEA`.
  - Galaxy Buds4 Pro: no colour codes yet.
  - Bespoke AI Fridge (also accepted as "Bespoke AI Refrigerator"): Snow White `RS80F64G1VRE`.
  - Every other catalog product is accepted by family name, without colour codes; `GET /me` lists them all.
- **Test campaigns:** never shown to reviewers; deletable with `DELETE`.
- **Answer:** `201 { "campaignId": "gen-h…", "source": "hermes", "state": "draft", "planVersion": 1, "product": {...}, "supportingProducts": [...], "externalRef": "…", "test": false }`

### `GET /campaigns?source=hermes&limit=50`: list

- **Answer:** `200 { "campaigns": [ { "campaignId", "title", "status", "product", "externalRef", "test", "createdAt" } ] }`,
  newest first (limit 100 at most).
- **Find yours:** add `&external_ref=<your id>` to find a campaign again if your ledger is lost.

### `POST /campaigns/{id}/brief`: brief

```json
{ "brief": {
  "objective": "…", "successMetric": "…",
  "audience": { "description": "…", "markets": ["UAE"] },
  "trendHook": { "mechanic": "…", "samsungAdaptation": "…" },
  "storyline": { "logline": "…", "protagonist": "…", "openingScene": "…", "beats": ["…"], "closingScene": "…" },
  "keyMessage": "…",
  "products": [ { "name": "Galaxy Z Flip8", "features": ["…"] } ],
  "claims": [ { "claim": "…", "approvedWording": "…", "disclaimer": "…" } ],
  "cta": "…", "tone": "…",
  "format": { "platform": "tiktok", "format": "…", "aspectRatio": "9:16", "targetDurationS": 7 },
  "languagePlan": { "onScreenText": "…", "voiceoverOrCaptions": "…", "register": "gulf_arabic", "rationale": "…" },
  "audio": { "direction": "…", "musicReference": "", "licensing": "none" },
  "mandatories": ["…", "…", "…"], "doNots": ["…"],
  "hashtags": { "en": ["#…"], "ar": ["#…"] },
  "caption": { "en": "…", "ar": "…" },
  "deadline": "12 Nov 2026"
} }
```

**Field rules**

- **Text fields:** `objective`, `successMetric`, `keyMessage`, `cta`, `tone` and `deadline` must be non-empty.
- **`deadline`:** exactly like `12 Nov 2026`.
- **`products`:** at least one.
- **`claims`:** approved wording only; send `[]` when there are none.
- **`format.targetDurationS`:** a positive integer.
- **`languagePlan.register`:** `gulf_arabic`, `msa`, `english` or `bilingual`.
- **`audio.licensing`:** `none`, `cleared` or `unknown`.
- **`mandatories`:** at least 3.
- **`hashtags.en` / `hashtags.ar`** and **`caption.en` / `caption.ar`:** all four required.

**Answer:** `201 { "versionId", "version", "state": "generated", "needsReview": true }`

### `POST /campaigns/{id}/uploads`: a file that exists only on your disk

Use this instead of re-hosting on a third-party CDN.

1. `POST` the declaration and get a signed upload URL:

   ```json
   { "filename": "fridge-girly-final.mp4", "contentType": "video/mp4", "size": 18874368, "sha256": "<64 lower-case hex>" }
   ```

   `contentType` is one of `image/png`, `image/jpeg`, `image/webp`, `video/mp4`, `audio/mp4` (m4a), `audio/mpeg`
   (mp3), `audio/wav`. The file may be 200 MB at most, an audio track 20 MB.

   → `201 { "uploadId", "uploadUrl", "method": "PUT", "headers": { "Content-Type": "…" }, "expiresAt", "url", "path" }`
2. `PUT` the raw bytes to `uploadUrl` with exactly those `headers`. The URL is single-use and expires in about two
   hours. This request goes to Maistro's storage, not to `/api/agent`, so it carries no Bearer key.
3. Push `url` as a normal asset (next section). Maistro checks the bytes against your sha256 and size:
   - `422 upload_mismatch`: the bytes differ from your declaration. Re-upload.
   - `422 upload_missing`: the PUT hasn't arrived yet.

### `POST /campaigns/{id}/assets`: one asset

```json
{
  "kind": "moodboard" | "thumbnail" | "keyframe" | "video" | "carousel_slide" | "audio",
  "url": "https://…",
  "direction": 2,
  "shot_index": 2, "shot_count": 3,
  "slide_index": 1, "slide_count": 6,
  "variant": "music_a",
  "meta": {
    "qa": { "checked": 1, "passed": 1, "regenerated": 0, "dropped": 0, "product": "…", "spec_card": "…", "notes": "…", "verdict": "pass|warn|fail" },
    "compliance": {
      "guidelines_version": "2026-11-02",
      "characters": "stylised_3d",
      "realistic_humans": false,
      "ai_generated_samsung_device": false,
      "product_sources": [ { "product": "Galaxy Buds4 White", "source": "official_product_image" },
                           { "product": "Galaxy Z Flip8 box", "source": "ai_render_from_official_box_refs" } ],
      "third_party_logos": false,
      "alcohol": false
    },
    "audio": { "source": "original_ai_generated", "model": "…", "licensing": "cleared" },
    "title": "track title (audio only)",
    "variation_plan": ["…"], "swap_proposals": ["…"],
    "shot_list": [ { "index": 1, "act": "…", "beat": "…", "duration_s": 3, "shot_size": "…", "angle": "…", "lens": "…", "move": "…", "action": "…", "device_pose": "…" } ],
    "story": { "logline": "…", "product_truth": "…", "emotional_arc": "…" },
    "note": "one line on what you made",
    "duration_s": 4
  }
}
```

**The file**

- **`url`:** either a public https link on an allowed host or the `url` from `/uploads`.
  - Allowed hosts: your Hermes gateway (hermes.maistro-agents.com), `*.higgsfield.ai`, `*.cloudfront.net`,
    `*.amazonaws.com` and Maistro's Supabase.
  - Anything else answers `422 host_not_allowed`.
- **Types:** decided from the file's real bytes:
  - **Images** (png, jpg, webp) for moodboard, thumbnail, keyframe and carousel_slide.
  - **mp4** for video.
  - **m4a, mp3 or wav** for audio (20 MB).
- **Size:** 200 MB at most.
- **Placeholders:** never push dry-run placeholders.

**Per kind**

- **`moodboard`:** needs `direction` (1–3).
- **`thumbnail`:** no extra fields.
- **`keyframe`:** needs `shot_index` (1–12); send `shot_count`. Put `meta.shot_list` and `meta.story` on the first
  keyframe.
- **`video` with `shot_index`:** one shot's clip. Send `shot_count` and `meta.duration_s`.
- **`video` without `shot_index`:** the whole finished cut.
  - Add `variant` (1–40 letters, digits, `_`, `-`) for each sound version, e.g. `music_a` (with music) and
    `no_audio`. Variants sit side by side and never replace each other.
  - A re-push of the same variant replaces it, and Maistro keeps the old one in history.
  - Put `meta.audio` on each variant.
- **`carousel_slide`:** a photo-mode or carousel slide. Needs `slide_index` (1–20); send `slide_count`.
  - Reviewers see the slides in order as one carousel.
  - A re-push of the same index replaces that slide, keeping history.
- **`audio`:** a standalone music track, with `meta.title` and `meta.audio`.

**`meta` rules**

- **`meta.qa` and `meta.compliance`:** include both on every asset. Reviewers see them as badges.
- **`meta.compliance.characters`:** `stylised_3d`, `2d_illustrated` or `none`.
- **`product_sources[].source`:** `official_product_image`, `official_3d_cad`,
  `ai_render_from_official_box_refs` or `real_footage`. Each `product` must name the campaign's hero or a
  supporting product.
- **`meta.audio.source`:** `original_ai_generated`, `licensed` or `none`. **`licensing`:** `cleared`, `none` or
  `unknown`.
- **Size:** `meta` is 64 KB at most.

**Answer:** `201 { "assetId": "as_…", "kind", "assetPath", "sha256", "size", "contentType", "attached": { "stage", "versionId", … }, "needsReview": true }`.
Keep every assetId.

### `POST /campaigns/{id}/storyboard`: storyboard

```json
{
  "story": { "logline": "…", "product_truth": "…", "emotional_arc": "…" },
  "shots": [
    { "index": 1, "act": "Act 1 — setup", "beat": "opening", "duration_s": 3, "shot_size": "close_up",
      "angle": "low angle", "lens": "35mm", "move": "slow push-in",
      "action": "A stylised 3D character opens the fridge", "device_pose": "sealed Flip8 box on the top shelf",
      "keyframe_asset_id": "as_…" }
  ]
}
```

- **Shots:** 1–12, with `index` running 1..N without gaps. Every field is required except `lens` (may be "")
  and `keyframe_asset_id`.
- **`keyframe_asset_id`:** must be an image assetId you pushed to THIS campaign.
- **Answer:** `201 { "versionId", "version", "shots", "keyframes", "state": "generated", "needsReview": true }`

### `GET /campaigns/{id}`: read back

**What it returns**

- **Campaign:** title, `source`, `status`, `product`, `supportingProducts`, `externalRef`, `test`, trend, markets,
  platforms.
- **`stages`:** each with its `state`, current `version` (`n`, `producedBy`, `payload`), latest `decision` and
  `comments`.
- **`comments[]`:** all reviewer feedback, as
  `{ stage, shot?, assetId, author, role, text, reasonCode, createdAt, decision: "approved" | "rejected" }`.
  A rejection means "make a new version"; the reason is in `text`.
- **`assets[]`:** assetId, kind, assetPath, sha256, size, contentType, meta, sourceUrl, attached.

**How to use it**

- **After each push:** check the sha256 and size.
- **Before more work:** read the states, decisions and comments.

### `DELETE /campaigns/{id}`: test campaigns only

- **Answer:** `200 { "campaignId", "deleted": true }`. After it, the campaign answers 404.
- **Real campaigns:** answer `403 not_test_campaign`. Never try to delete one.

## Reviewer webhook (when the operator has enabled it)

Maistro POSTs every stage decision, reopen and shot review on your campaigns to
`https://hermes.maistro-agents.com/hooks/maistro`:

```json
{ "type": "stage.decision" | "shot.review" | "stage.reopened", "campaignId": "gen-h…", "stage": "thumb", "shot": 2,
  "versionId": "…", "assetId": "as_…" | null, "decision": "approved" | "rejected",
  "comment": { "author": "…", "text": "…", "reasonCode": "…", "createdAt": "…" }, "at": "…" }
```

**Verify every call before acting on it**

- **Headers:** `X-Maistro-Timestamp` (unix seconds) and `X-Maistro-Signature: sha256=<hex>`.
- **Signature:** the hex is HMAC-SHA256 of `"<timestamp>.<raw body>"` with the shared secret
  `HERMES_WEBHOOK_SECRET` from your vault. Compare in constant time.
- **Freshness:** reject a timestamp more than 5 minutes old.

**What to do with it**

- **On a rejection:** fix the work and push a new version (new Idempotency-Key, e.g. `-r2`).
- **Missed calls:** the webhook is best effort and isn't retried, so `GET /campaigns/{id}` stays the truth.

## Errors and what to do

| Status | Meaning | Do |
|---|---|---|
| 201 / 200 | done | record the ids |
| 401 | the key is wrong or missing | stop and alert the operator; never retry with a guessed key |
| 403 `not_agent_campaign` | not created through this API | don't touch it |
| 403 `not_test_campaign` | DELETE on a real campaign | don't |
| 404 | unknown or deleted campaign, or unknown endpoint | check the id and path |
| 409 `approved_immutable` | a person approved that stage | don't push to it; tell the operator if a change is truly needed |
| 413 | over 200 MB (audio over 20 MB) | re-encode smaller |
| 415 | not an accepted file type, or not JSON | fix the file or the Content-Type |
| 422 `unknown_product` | product or colour not known | use one from `allowed` / `GET /me` |
| 422 `compliance_violation` | declared realistic humans or an AI-generated Samsung device | don't push it; the work must be redone |
| 422 `product_not_in_campaign` | a product source isn't the hero or a supporting product | fix the declaration, or the work |
| 422 `upload_mismatch` / `upload_missing` | the uploaded bytes don't match, or haven't arrived | re-upload, then push |
| 422 other | invalid body; `missing` lists absent fields, `problems` the rest | fix those fields; resend with a NEW Idempotency-Key |
| 429 | over 60 requests a minute | wait 60 s; retry with the SAME Idempotency-Key |
| 5xx / timeout | Maistro or the download failed | retry up to 3 times with backoff and the SAME Idempotency-Key |

## Hard rules

- **Drafts only.** You can't approve, reject, publish, schedule or post. Never try, and never claim you did.
- **Your campaigns only.** Never push into a campaign you didn't create through this API.
- **Products:** only the hero and the listed supporting products, each in its declared colourway.
- **Guidelines:** follow the 2026-11-02 content guidelines and declare them truthfully in `meta.compliance`.
- **Nothing sensitive in `meta`:** no secrets, keys, signed tokens or personal data in meta, notes or titles.

## Minimal Python client

```python
import os, time, hashlib, requests

BASE = os.environ.get("MAISTRO_AGENT_URL", "https://www.ma1stro.com/api/agent")
AUTH = {"Authorization": f"Bearer {os.environ['AGENT_INGEST_KEY']}", "User-Agent": "Hermes/1.0"}

def call(method, path, body=None, idem=None, params=None):
    for attempt in range(4):
        h = {**AUTH, **({"Content-Type": "application/json"} if body is not None else {}), **({"Idempotency-Key": idem} if idem else {})}
        r = requests.request(method, f"{BASE}/{path}", json=body, params=params, headers=h, timeout=180)
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(60 if r.status_code == 429 else 5 * (attempt + 1)); continue
        if r.status_code >= 400:
            raise RuntimeError(f"{method} {path} -> {r.status_code}: {r.json()}")  # never includes the key
        return r.json()
    raise RuntimeError(f"{method} {path} -> gave up after retries")

def upload_local(cid, file_path, content_type, idem):
    data = open(file_path, "rb").read()
    u = call("POST", f"campaigns/{cid}/uploads", {"filename": os.path.basename(file_path), "contentType": content_type,
             "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}, idem)
    r = requests.put(u["uploadUrl"], data=data, headers=u["headers"], timeout=600)  # storage, no Bearer key
    r.raise_for_status()
    return u["url"]

print(call("GET", "me")["keyId"])
c = call("POST", "campaigns", {"title": "Fridge Girly (test)", "trend": {"name": "Fridge Girly"},
         "product": {"family": "Galaxy Z Flip8", "colour": "Pink"},
         "supporting_products": [{"family": "Galaxy Buds4", "colour": "White"}],
         "markets": ["UAE"], "platforms": ["tiktok"], "source": "hermes",
         "external_ref": "fridge-girly-2026-11-test", "test": True}, "fridge-girly-2026-11-test-create")
cid = c["campaignId"]
url = upload_local(cid, "slide1.png", "image/png", f"{cid}-up-slide1-r1")
call("POST", f"campaigns/{cid}/assets", {"kind": "carousel_slide", "url": url, "slide_index": 1, "slide_count": 6,
     "meta": {"qa": {"verdict": "pass"}, "compliance": {"guidelines_version": "2026-11-02", "characters": "stylised_3d",
              "realistic_humans": False, "ai_generated_samsung_device": False,
              "product_sources": [{"product": "Galaxy Buds4 White", "source": "official_product_image"}]}}},
     f"{cid}-slide1-r1")
print(call("GET", f"campaigns/{cid}")["assets"][-1]["sha256"])
call("DELETE", f"campaigns/{cid}")
```
