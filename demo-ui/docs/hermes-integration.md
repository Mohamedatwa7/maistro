# Maistro ⇄ Hermes bots: the integration contract

Maistro makes each campaign asset by calling one bot on the owner's Hermes Agent gateway. The bots share a
"campaign ledger" on the Hermes side, but **Maistro decides what each bot is told and when each run happens**.
This page covers what Maistro sends, how it names sessions, how it decides that an asset is out of date, and
how it routes failures.

The code lives in:

| File | What it holds |
|---|---|
| `api/_studio/hermes-contract.js` | Session ids, the product spec, budgets, response schemas, staleness, review mapping, redaction (pure, no I/O) |
| `api/_adapters/hermes.js` | Request builders (`renderRun`, `briefRun`, `reviewRun`), submit, poll, parse |
| `api/_jobs.js` | Submit/poll lifecycle, attaching results, failure routing (frame fix, credits halt), PLAN mode |
| `api/_handlers/studio.js` | The studio actions that create the jobs |

## Transport (unchanged)

- `POST {HERMES_API_URL}/p/<profile>/v1/runs` with body `{ input, instructions, session_id }` returns
  `202 { run_id, status }`.
- Maistro then polls `GET /p/<profile>/v1/runs/{run_id}` from the job service until the status is one of
  `completed | failed | cancelled | interrupted | waiting_for_approval`.
- Headers:
  - `Authorization: Bearer <that profile's key>`.
  - `Idempotency-Key: <job id>[:<resubmit n>]`.
  - `User-Agent: Maistro/1.0`. Without it, Cloudflare answers "error code 1010".
- Keys live only in Vercel env (`HERMES_KEY_<ROLE>` or `HERMES_KEY_MAISTRO_<PROFILE>`). They are never logged.

| Role | Profile | Session suffix | Makes |
|---|---|---|---|
| brief | `maistro-brief` | `brief` | brief, captions, hashtags |
| mood | `maistro-moodboard` | `mood` | look images (3 moods × 2) |
| board | `maistro-storyboard` | `board` | story, shot list, keyframes |
| thumb | `maistro-thumbnail` | `thumb` | cover image |
| video | `maistro-video` | `draft` | one clip per shot |
| organizer | `maistro-organizer` | none (review session) | campaign review |

## Session ids

The ledger regex on the Hermes side is `^maistro-gen-([A-Za-z0-9]+)-([a-z]+)`.

- **Format:** `maistro-gen-<campaignId>-<suffix>[-v<n>]`.
  - `campaignKey(pieceId)`: the page's piece id without its `gen-` prefix and with every non-alphanumeric
    character removed. For example, `gen-k3x9-ab_2` becomes `k3x9ab2`.
  - The key is the same for every bot of a campaign, so they share one ledger.
  - An id that leaves nothing alphanumeric is refused.
- **Versions (G):**
  - `-v<n>` is the campaign version of the asset being made: the storyboard version for keyframes, the draft
    version for clips, the moodboard version for moods, and the next version for brief and thumbnail runs.
  - v1 has no suffix. Each new version starts a fresh session, so one session no longer collects every
    re-render.
- **Review:** `maistro-review-<campaignId>-<timestamp>` (deliberately not a `maistro-gen-` id).
- **Tests:** use the campaign id `zztest01` and never a real campaign's session.

## What every request carries

`input` is a JSON string. Fields marked "all" go to every bot on every call (B).

| Field | Bots | Notes |
|---|---|---|
| `task`, `prompt`, `aspect`, `resolution`, `count` | all render bots | as before |
| `product` | all, brief included | `{ family, colour, model_code }` — the campaign's locked spec |
| `product_image_urls` | all, brief included | official front, back, side images (KB catalog `referenceImages`, campaign colour), then the 3D-model views, then the campaign photo |
| `moodboard_image_urls` + `moodboard_images` | mood, thumb, board | `moodboard_images: [{ url, look_reference: true }]`; the rules say look only, never the device in them (F) |
| `shot_index`, `shot_count`, `story`, `shot_list`, `previous_keyframe_urls` | board (one keyframe) | see A below |
| `brief`, `story`, `shot_count_range`, `target_duration_s` | board (PLAN mode) | see A below |
| `fix_request` | board | the video bot's note (D) or a review fix |
| `first_frame_url`, `duration`, `audio` | video | the first frame is the storyboard shot's **current** keyframe (C) |
| `style_reference_urls` | render bots | the user's own reference images |
| `reviewer_changes` | render bots | a re-render's requested changes |
| `max_credits` | render bots | from the budgets below (E); 1 in TEST MODE |

The product spec:

- **Source of truth:** `productSpec({ family, colour, catalog })` in the contract.
  - The family is the campaign's product.
  - The colour comes from the request's `productColour` (the COLOUR field in the studio header), else the plan
    version's `productColour`, else the product's default.
  - The model code comes from `PRODUCT_SPECS` (for example, Galaxy S26 Ultra / Sky Blue / SM-S948BLBIMEA) and the
    KB catalog's `modelCodes`. **A code that isn't known is sent as `null`, never guessed.**
- **Generic look line removed:** the bots no longer receive the catalog look line ("2026 flagship bar phone…").
  Every prompt says "Samsung Galaxy S26 Ultra in Sky Blue (SM-S948BLBIMEA)" instead.
- **Dropped fields (F):** `seed` is no longer sent. The generator can't use it, but Maistro still records it on
  the job.
- **Text and logo rules (H), in every image run:**
  - "No logos / no text" means no generated text and no third-party logos. The product's own SAMSUNG back
    wordmark stays.
  - End cards are clean plates with the centre left empty. An end-card shot's "Samsung logo…" action is rewritten
    to "clean plate", so the bot is never asked to draw the logo.
  - The page composites the official white lettermark in post. *(Gap: the brand-kit lettermark asset and the
    composite step are not in the repo yet; see "Remaining gaps".)*

### A. Storyboard keyframes

- **Default mode:** Claude writes the shot list (`storyboard-v3`).
  - The shot list now includes a `story` `{ logline, product_truth, emotional_arc, acts }` and, per shot, `act`,
    `angle`, `lens`, `move` and `devicePose`.
  - Then one keyframe run per shot, each with:
    - `shot_index` (1-based) and `shot_count`.
    - `story`: the shot list's story, else one built from the brief's storyline.
    - `shot_list`: the whole approved list as `{ index, act, beat, shot_size, angle, lens, move, action,
      device_pose, duration_s, transition }`.
    - `previous_keyframe_urls`: the rendered, not-rejected keyframes of the earlier shots. They are signed for
      24 h when the job is submitted and kept on the job.
- **PLAN mode** (the "Let the storyboard bot plan it" checkbox, `plan: true`, or `MAISTRO_BOARD_PLAN_MODE=1`):
  - One run with the task "Write the story and shot list, then make all keyframes".
  - The reply `{ story, frames[], note, qa }` becomes the storyboard version's shots, each with its keyframe and
    the per-frame `act`, `beat`, `device_pose`, `transition`, `qa` and `story_flag`.

The storyboard page shows the story, each shot's act, device pose and transition, the bot's QA verdict, notes and
spec card, and any story flag.

### E. Budgets (`max_credits`)

Change these in one place: `BUDGET_DEFAULTS` in the contract, or the env var
`MAISTRO_HERMES_BUDGETS='{"keyframe":8}'`. A 2k Nano Banana Pro image costs 2 credits; a 4k image costs 4.

| Run | Default |
|---|---|
| keyframe | max(6, 3 × image) — the image + two QA re-renders |
| moodboard | max(6, 3 × image) × count (3 × count × 2 at 2k) |
| thumbnail | max(6, 3 × image) |
| PLAN mode | max(6, 3 × image) × 8 frames |
| video | priced clip × 1.25, at least 4 (4 s at 720p → 23) |
| cap | 150 |

## Responses

The answer is the **last** fenced JSON block in `output`. Each reply is validated against its schema, and unknown
fields are ignored.

| Bot | Shape |
|---|---|
| moodboard | `{ images[], variation_plan[], swap_proposals[], note, qa }` |
| thumbnail | `{ images[], note, qa }` |
| storyboard | `{ story?, frames[], note, qa }` |
| video | `{ video, first_frame?, duration_s, resolution, aspect, shot_list?, note, qa }` |
| brief | `{ brief: {...} }` |
| organizer | `{ review[], story_check, miscommunications[], fixes_requested[], qa }` |
| any error | `{ error, note, error_code?, fallback? }` |
| `qa` | `{ checked, passed, regenerated, dropped, product, spec_card, notes, verdict? }` |

How Maistro handles a reply:

- **Problems:** a schema mismatch is kept as `contractProblems` on the asset. It is not fatal.
- **Stored with each asset:** `qa`, `story_flag` and `budget_blocked_retry`. They live on the keyframe, the clip,
  the mood or the thumbnail, and the page shows them as badges ("BOT QA · PASS", "STORY FLAG", "QA RE-RENDER
  BLOCKED BY BUDGET").

## Staleness (C)

- **Stage level:** every version records the versions it was built from (`artifact_versions.inputs`, per
  `CONSUMES` in `src/domain/stages.js`). The dependency order is now **brief → moodboard → storyboard → thumbnail
  → video**:
  - A new brief makes the moodboard and the thumbnail stale.
  - A new moodboard makes the storyboard and the thumbnail stale.
  - A new storyboard makes the draft stale.
  - The page shows "Out of date" on a stale stage. It can still be approved.
- **Shot level:**
  - A draft clip is **stale** when its storyboard shot has a newer keyframe than the one the clip started from
    (`staleClips`, computed on `GET ?shots=…&stage=draft`).
  - The part shows "STALE — KEYFRAME CHANGED" and a one-click "↻ Re-render from current keyframe".
  - A clip re-render always starts on the shot's current keyframe and updates the draft shot to it.
- **Order:**
  - `mood`, `board`, `thumb` and `draft` answer with `orderWarnings` when an earlier step is not approved
    (skipped steps count as done). The page shows them as a warning.
  - `MAISTRO_PIPELINE_ORDER=strict` blocks with 409 instead; `off` disables the check. The default is `warn`.
  - *Gap:* the brief bot's own prompt still reads the moodboard/thumbnail context when it exists (unchanged
    behaviour).

## Failure routing (D)

| The bot says | Maistro does |
|---|---|
| `{error, note}` whose note asks for a new/changed first frame (video bot) | The clip is marked `needsNewFrame` with the note. **"🖼 New first frame & retry"** calls `frame-fix`: the storyboard bot re-renders that shot with `fix_request` = the note (same `shot_index` / `shot_list`), and when it lands the clip renders again from the new frame. `MAISTRO_HERMES_AUTO_FRAME_FIX=1` does this without the click. It is off by default because it spends. Refused while the storyboard is approved. |
| `error_code: "higgsfield_credits_exhausted"` (any `fallback`) | Never retried. The piece's other live Hermes renders are cancelled, one critical `ops_alerts` row (`hermes_credits_exhausted`) is raised and posted to `MAISTRO_ALERT_WEBHOOK`, and new Hermes submits fail with the reason until an admin resumes ("Resume bots" → `hermes-resume`) or `MAISTRO_HERMES_HALT_MIN` (default 60) passes. |
| `budget_blocked_retry: true` | The asset is kept and badged "QA RE-RENDER BLOCKED BY BUDGET". |
| `{refused}` | As before: explained, a compliant rewrite suggested, never resubmitted. |
| run `interrupted` | As before: resubmitted under a fresh idempotency key, up to 2 times. |

## Campaign review (I)

- **Start:** "🔍 Review campaign" (studio header) sends `POST /api/studio { action: 'review' }`.
- **Submit:** Maistro submits to `maistro-organizer` with input `review campaign <campaignId>` and session
  `maistro-review-<campaignId>-<ts>`.
- **Poll:** the page polls `GET /api/studio?review=<pieceId>&ref=organizer:<run>`.
- **Display:** the page shows the verdicts, the story check and the miscommunications.
- **Fixes:** each `fixes_requested` item maps to a run:

| `to` | Run |
|---|---|
| storyboard + shot | `board-shot` with `changes` |
| video + shot | `draft-shot` with `changes` |
| moodboard | `mood` |
| thumbnail | `thumb` |
| brief | `brief` |

## TEST MODE (no spend)

- **How it works:** with `payload.testMode` or `MAISTRO_HERMES_TEST_MODE=1`, every run's instructions begin with
  `TEST MODE: run every maistro_media.py command with --dry-run only and set image/video URLs to "dry-run".` and
  `max_credits` is 1, below the cost of any image (2), and never 0, which a helper could read as "unset".
- **Why the cap matters:** the media helper cannot spend even if a bot ignores the instruction.
- **Script:** `node scripts/hermes-dryrun.js` runs the whole pipeline on `zztest01` through the real gateway. It
  prints each request with secrets and signed-URL tokens redacted, and each parsed reply.

## Remaining gaps

- **Official product images:** the catalog's `referenceImages` (front/back/side per colour) are empty in the KB
  seed. Until they are filled, `product_image_urls` falls back to the 3D-model views or the campaign photo.
- **Model codes:** only Galaxy S26 Ultra / Sky Blue (SM-S948BLBIMEA) is known. Other products send
  `model_code: null` until `modelCodes` is added to their catalog entry.
- **Logo composite:** compositing the official lettermark in post needs the brand-kit asset. The bots are no
  longer asked to draw it, but the composite step is not built.
- **PLAN mode checks:** PLAN-mode frames get the bot's own QA. The per-keyframe vision check and the F1X8 hook
  check run only in the default mode.
- **`previous_keyframe_urls`:** the first batch of keyframes renders in parallel, so this field is empty for it.
  It fills on re-renders and frame fixes.
