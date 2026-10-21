# HIGGSFIELD — capability matrix, gaps in our usage, client design

Phase 6.0 deliverable, 2026-10-21. Sources: the official documentation at docs.higgsfield.ai (pages fetched today: `/docs/concepts/requests`, `/docs/concepts/errors.md`, `/docs/concepts/rate-limits.md`, `/docs/concepts/billing-and-retention.md`, `/docs/concepts/idempotency.md`, `/docs/concepts/file-uploads.md`, `/docs/how-to/webhooks.md`, `/docs/help/faq.md`, `/docs/models/image-generation`, `/docs/models/video-generation`, `/docs/models/soul-2/generate.md`, `/docs/models/soul-standard/generate.md`, `/docs/models/soul-id/create-character.md`, `/docs/models/seedance-2-5/{text-to-video,image-to-video,reference-to-video}.md`), the installed SDK `@higgsfield/client 0.2.6` (`dist/v2/*.d.ts`, `dist/errors.d.ts`, `README.md`), our adapter `demo-ui/api/_adapters/higgsfield.js`, the job service `demo-ui/api/_jobs.js`, and the recorded responses in `demo-ui/tests/api/{generation,jobs}.test.js`. **No live call was made** (constraint 9). Where the documentation is silent, the matrix says "not documented".

## 1. Platform facts that bind every integration

| Topic | Documented behaviour | Source |
|---|---|---|
| Auth | `Authorization: Key <KEY_ID>:<KEY_SECRET>` on `https://api.higgsfield.ai`; server-side only | SDK README, model pages |
| Submission | `POST /<endpoint-id>` with a JSON body → immediately `{status:"queued", request_id, status_url, cancel_url}`; poll `status_url` or receive a webhook | concepts/requests |
| Statuses | `queued` (cancelable) → `in_progress` (not cancelable) → terminal `completed` / `failed` (+`error`) / `nsfw` (moderated) / `canceled` | concepts/requests; SDK `V2RequestStatus` lacks `canceled` |
| Outputs | `images[{url}]` or `video{url}` (some models `audio`, `zip`, `mov`…) | concepts/requests |
| **Retention** | output URLs "retained for at least seven days", may be removed after; download to your own storage | requests, billing-and-retention, FAQ |
| Idempotency | optional `Idempotency-Key` header (1–255 visible ASCII, UUID recommended): same key + same body replays the original `request_id` without charge; same key + different body → `422`; rejected requests do not consume the key; the webhook is part of the identity | concepts/idempotency |
| **Rate limits** | no published per-minute figures; the limit is **concurrency** (requests queued or processing at once, value in the Console); exceeding it answers **`400 {"detail":"Maximum number of concurrent requests (N) has been reached."}`** — no `429`, no `Retry-After`; back off with jitter; keep polling traffic separate from submissions | concepts/rate-limits |
| Errors | body `{"detail": …}` (list for validation); 400 invalid/rejected/concurrency; 401 credentials; 403 insufficient credits; 404; 422 validation or idempotency conflict; 423 model temporarily blocked; 500; 503 model disabled; `X-Correlation-ID` on every response | concepts/errors |
| Billing | pay-as-you-go credits (expire after one year); cost depends on model + parameters; **failed / nsfw / canceled-while-queued are not charged** (reserved credits refunded); **`POST /estimate/<endpoint-id>`** with the same body returns `{credits, usd}` before generating | billing-and-retention, FAQ |
| Webhooks | `?hf_webhook=<https url>` on submit; envelope `{request_id, status (completed\|failed\|nsfw), error, payload}` with `payload.images[{url,content_type}]` / `payload.video{url,content_type}`; **no signature**; endpoint must answer 2xx within 10 s; 5xx/network retried for up to 2 h, 4xx final; deduplicate on `request_id`+`status` | how-to/webhooks |
| Uploads | `POST /files/generate-upload-url {content_type}` → presigned `PUT` (`upload_url`, `upload_headers`), use the returned `public_url` as a media input; jpeg/png/webp/gif, wav, mp4; tagged `retention=temporary` (period not stated); media inputs must be **public** URLs, `asset://` rejected | concepts/file-uploads, model pages |
| Cancel | only while every job is queued; `202`, else `400` | concepts/requests |
| SLA / timeouts | no SLA; "model-specific timeouts" exist, values not published; the SDK defaults to 2 min request timeout and 5 min max poll | FAQ, SDK config |

## 2. Model matrix — what we use and what exists

### 2.1 Images

| Capability | SOUL V2 `higgsfield-ai/soul/v2/standard` (our default image path) | SOUL `higgsfield-ai/soul/standard` | Deprecated v1 `/v1/text2image/soul` (our reference path) |
|---|---|---|---|
| Inputs | `prompt` (req), `aspect_ratio` 9:16 16:9 4:3 3:4 1:1 2:3 3:2 (default 1:1), `resolution` 720p/1080p, `batch_size` 1/4, `seed` 1–1,000,000, `style_id` (list via `GET /v1/text2image/soul-styles/v2`), `style_strength` 0–1 (documented as currently no effect), `custom_reference_id` + `custom_reference_strength` (>0), `enhance_prompt` | same shape plus `image_reference_url` (a URI that "guides prompt enhancement" — not a layout or product-fidelity control); default 4:3; v1-family styles | SDK v1 typing: `prompt`, `width_and_height` (fixed list), `quality` 720p/1080p, `batch_size`, `style_id`/`style_strength`, `custom_reference_id`/`strength`, `image_reference {type:'image_url', image_url}`, `enhance_prompt`, `seed`; polled at `/v1/job-sets/{id}` |
| **Image reference** | **none** — the schema has no reference-image field | `image_reference_url` (prompt guidance only) | `image_reference` (what our thumbnail path relies on) |
| Identity / consistency | `custom_reference_id` = a **Soul ID** character trained from 1–100 public image URLs (`POST /v1/custom-references`, `model_version` v1/v2/cinema, poll `GET /v1/custom-references/{id}`); documented for **characters only**, products not addressed | same | same |
| Output | `images[{url}]`, ≥ 7-day retention | same | `jobs[0].results.raw.url` |
| Status in docs | current | current | **not in the current documentation**; the SDK marks the v1 client "Deprecated" |

Other image models with explicit multi-image references (candidates for product fidelity, not yet verified by test calls): **Ads Studio** (`/docs/models/ads-studio`: "marketing brief plus optional product references into 1–8 ad images", GPT Image 2.5 Flare), **Grok Image 2.0** (up to ten image references, generate and edit), **Qwen Image 3** (edit with 1–3 references), **Ideogram 4.0** (optional image reference), **Marketing Studio Image** (campaign image generation and editing).

### 2.2 Video (Seedance 2.5, ByteDance)

| Endpoint | Inputs | Notes |
|---|---|---|
| `bytedance/seedance-2.5/text-to-video` (our draft/final path) | `prompt` (req), `duration` 4–30 (default 5), `resolution` 480p/720p/1080p (default 720p), `aspect_ratio` 16:9 4:3 1:1 3:4 9:16 21:9, `generate_audio` (default **true**), `bitrate_mode` standard/high (default high), `output_format` mp4/mov; **no `seed`**; `additionalProperties:false` | output `video.url` |
| `bytedance/seedance-2.5/image-to-video` | `image_url` (req, sets framing), optional `prompt`, `end_image_url` (last frame), `duration` 4–30, `resolution`, `bitrate_mode`, `generate_audio`; **no `aspect_ratio`**, no camera/motion controls documented | the storyboard-keyframe → clip path of Phase 6.6 |
| `bytedance/seedance-2.5/reference-to-video` | `prompt`, `image_urls` 1–30, `video_urls` 1–10, `audio_urls` 1–10 (≤ 50 items, ≤ 30 s per media type), `duration`, `resolution`, `aspect_ratio`, `generate_audio`, `bitrate_mode` | multi-reference generation (product + style references) |
| video edit, video extend | exist (sibling pages, not fetched) | later phases |

Other video families on the catalog (22): Kling 2.5/2.6/3.0/O3/Omni (first/last frame, image and video references, motion control), Wan 2.6/2.7/3.0, MiniMax H3, Hailuo 2.3, LTX-2.5, PixVerse V6, Genjutsu (motion transfer, restyle), Cinema Studio 4.0 (camera and style controls), Grok Imagine Video 1.5.

## 3. Our usage against the documentation (`api/_adapters/higgsfield.js`, `api/_jobs.js`)

| # | Finding | Severity | Evidence | Fix |
|---|---|---|---|---|
| H-1 | The product-reference image path calls the **deprecated v1** endpoint `/v1/text2image/soul` with `image_reference`; the current SOUL V2 has **no reference-image input** and SOUL standard's `image_reference_url` only guides prompt enhancement. Product fidelity by reference is therefore a v1 artefact that can disappear without notice. | High | adapter `:44–66`; docs soul-2/generate, soul-standard/generate; SDK README "V1 Client (Deprecated)" | Keep v1 as-is for now (it works today, 2026-10-09 verification in the rebuild notes), add a contract test that fails loudly on a non-2xx from v1, and evaluate the documented routes in 6.1/6.2: **Soul ID** (train a "character" from the product photos — needs a test to see whether it holds device geometry), **Ads Studio / Grok Image 2.0 / Qwen Image 3** multi-reference generation, and **Seedance reference-to-video** for video. Choose by a recorded eval (6.10), not by assumption. |
| H-2 | Submits carry **no `Idempotency-Key`**; the job service retries a submit up to three times after an ambiguous failure, so a timed-out-but-accepted submit can be **charged twice** and produce two renders. | High | adapter `:59, :82`; `_jobs.js` MAX_SUBMIT_ATTEMPTS | Send `Idempotency-Key = job id` on every submit (v2 REST and v1); a replay returns the original `request_id`. |
| H-3 | A **concurrency limit answers `400`**, which `_jobs.js` treats as a permanent 4xx failure → the stage returns to `ready` and the person is told the render failed, when it only needed to wait. | High | rate-limits page; `_jobs.js advance()` "a 4xx from validation never gets better" | Classify `400` whose `detail` mentions the concurrent-request limit, plus `423` and `503`, as **retry later** (backoff with jitter); `403` insufficient credits → fail with the exact reason (owner action); `401/404/422` permanent. |
| H-4 | **Output URLs expire after ≥ 7 days** but the legacy page renders `imageUrl`/`videoUrl` straight from the provider. Copies exist in the private `assets` bucket (M3) but are not what the page shows. | High | FAQ, billing-and-retention; `index.html` stage renderers | Serve stored assets through signed URLs (`GET /api/jobs?asset=`) in the page renderers — before M5, because pieces older than a week will otherwise show broken media. Reconcile copy-in failures (ops item from M3). |
| H-5 | The v2 submit goes through the SDK's `subscribe()` (`withPolling:false`), raced against our own 30 s timer; the SDK adds its own retries (`maxRetries 3`, backoff) that we cannot see, cannot mock in tests, and that compound H-2. | Medium | adapter `:69–82`; SDK config defaults | Submit with plain REST (`POST https://api.higgsfield.ai/<endpoint-id>`, `Authorization: Key …`) through `fetchT`, so timeouts, retries and headers are ours and the path is testable with recorded responses; drop the SDK dependency once nothing else uses it. |
| H-6 | `seed` is never set; Seedance text-to-video has no seed at all, SOUL V2 accepts one. Reproducibility (6.9 "every generation is reproducible") needs the seed recorded where it exists. | Medium | docs; adapter | Record the seed in the Generation Record (6.1) for SOUL; for Seedance record the full body and `request_id` (no seed available). |
| H-7 | `generate_audio` defaults to **true** on Seedance and we never set it; the artifact says "Native audio — generated by Seedance 2.5", which matches the default but is not controlled. Licensed-audio policy (6.4) will need `generate_audio:false` + our own audio. | Low | docs; adapter input | Make it explicit in the request. |
| H-8 | Cost is unknown before a render; `POST /estimate/<endpoint-id>` exists and returns `{credits, usd}` for the same body. | Medium (6.9 cost control) | billing-and-retention | Call the estimate before every job (free), store it on the job, enforce per-piece budgets. |
| H-9 | `X-Correlation-ID` is returned on every response and is never logged. | Low | errors page | Log it with `request_id` on submit and status. |
| H-10 | Webhooks are available (`hf_webhook`, no signature, 2 h retries); the job service polls only. | Low (polling works on Pro) | how-to/webhooks | Optional later: `?hf_webhook=https://www.ma1stro.com/api/jobs?hook=<per-job token>`; dedupe on `request_id`+`status`; polling stays the fallback. |
| H-11 | Media inputs must be **public** URLs: the reference photo path uses the public `refs` bucket (ADR-006 wants it private). The documented route is Higgsfield's presigned upload (`/files/generate-upload-url`) from our private copy at submit time. | Medium (privacy, ADR-006) | file-uploads page; `upload.js` refs bucket | In 6.1: upload the active reference to Higgsfield's temporary storage per submit and close the public bucket. |
| H-12 | Hard-coded values: model ids, v1 size table, resolution/aspect lists, 30 s submit timeout, 10 s status timeout. | Low | adapter constants | Move to `config` with the job-kind timing tables; the allowed-value lists stay in code as the documented enums (they are validation, not configuration). |
| H-13 | The SDK's `V2RequestStatus` omits `canceled`; our status mapping handles it (`['failed','nsfw','canceled']`). | None | adapter `:90`, `_jobs.js` | keep |

What the code already does right: bounded timeouts on every call; `nsfw` treated as a non-retryable, refunded outcome with a user-facing message; `in_progress`/`queued` polled with backoff by kind; results copied into private storage with a checksum at completion; stage state driven by the domain.

## 4. Client design (typed `HiggsfieldClient`, M3 adapter → 6.0 contract)

One method per capability, validated inputs, explicit job lifecycle, structured errors, cost recorded per call; the job service stays the only caller.

```ts
interface HiggsfieldClient {
  estimate(endpoint: EndpointId, body: object): Promise<{ credits: number; usd: number }>;       // POST /estimate/<id>
  submit(endpoint: EndpointId, body: object, opts: { idempotencyKey: string; webhook?: string }): Promise<{ requestId: string; statusUrl: string; correlationId: string | null }>;
  status(requestId: string): Promise<{ status: 'queued'|'in_progress'|'completed'|'failed'|'nsfw'|'canceled'; images?: {url}[]; video?: {url}; error?: string }>;
  cancel(requestId: string): Promise<boolean>;                                                   // 202 → true, 400 → false
  uploadMedia(bytes: Buffer, contentType: string): Promise<{ publicUrl: string }>;              // presigned PUT
  soulStylesV2(): Promise<Style[]>;                                                             // cached at startup
}
// Endpoint ids used: 'higgsfield-ai/soul/v2/standard', 'bytedance/seedance-2.5/text-to-video',
// 'bytedance/seedance-2.5/image-to-video', 'bytedance/seedance-2.5/reference-to-video';
// the deprecated v1 path stays behind `legacyReferenceImage()` until 6.2 replaces it.
```

Error classes map the documented statuses: `Retryable` (400 concurrency, 423, 500, 503, network, timeout → backoff with jitter, idempotent replay), `PolicyRefusal` (`nsfw` → never retried, user-facing reason, refunded), `InsufficientCredits` (403 → fail the job with the exact reason, surface to the owner), `Permanent` (401, 404, 422, other 400). Contract tests use recorded bodies for every status and error (see `tests/api/jobs.test.js`; new recordings for 400-concurrency, 403, 422-idempotency, `canceled`).

## 5. What changes now (code on the branch, tests recorded) and what waits

- Now (this phase, no behaviour change for a successful render): H-2 Idempotency-Key, H-3 retry classification, H-5 REST submit through `fetchT`, H-9 correlation id in the job row. Covered by `tests/api/jobs.test.js`.
- Before M5 pages: H-4 signed URLs for stored assets in the page renderers.
- 6.1/6.2 with recorded evals and owner-approved spend: H-1 product-fidelity route, H-11 private references via presigned upload, H-8 estimates and budgets, H-7 audio policy.
