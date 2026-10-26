# ADR-008 — Publishing: a Sprinklr adapter behind an interface, manual/export mode until access exists

Status: accepted 2026-10-21

## Context
Posting is simulated today with a fake API toast (ARCHITECTURE_CURRENT §6.8). There is no Sprinklr API access yet.

## Options
1. **Adapter interface with `ManualExportAdapter` active and `SprinklrAdapter` gated by credentials** — honest today, drop-in when access arrives.
2. Keep the simulated flow until access exists — zero work, but it misrepresents a "connected" integration (AUDIT 6.8, D-01 context "no integration faked").
3. Build directly against platform APIs (TikTok/Meta/X) — deferred by the owner on 2026-09-04; Sprinklr is the chosen route.

## Decision
Option 1. `PublishingAdapter` interface (`schedule`, `publish`, `status`, `recordPermalink`). `SprinklrAdapter` is implemented against Sprinklr's documented publishing API (media asset upload, post creation, scheduling, status polling) and gated by `SPRINKLR_*` environment variables; without them the app runs `ManualExportAdapter`: the approved final version, caption, platform/account and slot are exported as a package (zip + JSON), the operator posts and records the permalink, which creates the `posts` row that performance tracking keys on. Everywhere publishing appears the UI states "Sprinklr: not connected — manual mode".

## Consequences
The calendar becomes real in manual mode (approved pieces, chosen slots, posted and permalink state) instead of simulated events; the simulated July 2026 data retires when the page is rebuilt.

## Amendment 2026-10-22 (8b built)
- **Manual/export mode is live.**
  - `publishing_slots` (migration 019) holds the plan: an approved final, platform, owned account (R-8's list),
    Gulf time and caption.
  - The Calendar lists approved finals waiting for a slot, sorted by their trend's post-by date, plus the planned
    posts.
  - **Export** marks the slot exported and downloads the existing delivery package (`final-package`). The
    operator posts by hand.
  - Linking the published post on the final ("Published as", `piece_posts`, migration 018) marks the slot
    **posted**. Cancel keeps the row.
  - The simulated July 2026 events, the invented account list and the "SPRINKLR API · CONNECTED" claims are
    removed.
- **Deviation: the Sprinklr adapter is a gated stub, not a client — for now.** The reason first recorded here
  ("the documentation is not publicly reachable") was **wrong**: one shallow web search missed the portal.
  - **Correction (2026-10-22, later the same day):** the v3 docs are public at developer.sprinklr.com, and the
    OpenAPI 3.0.3 spec downloads from `https://developer.sprinklr.com/_spec/apis/sprinklr-v3.json`.
  - **Server and auth:** `https://api3.sprinklr.com/{env}/api/v3`, a Bearer token plus a `Key` header; `GET /me`
    verifies the credentials.
  - **Publishing endpoints:** `POST /media/upload`, `POST /publishing/draft`, `POST /publishing/draft/schedule`,
    `POST /publishing/post`.
  - **Access:** the owner reports having API access.
  - **Why it is still a stub:** the stub stands only until the credentials are in the Vercel env and the owner's
    read-only first probe is done. The real adapter will then be built from a **vendored copy of the spec**
    (pinned version), not from guesses.
  - `SprinklrAdapter` reads `SPRINKLR_API_KEY`, `SPRINKLR_API_SECRET` and `SPRINKLR_ENV` only to report
    "configured". `publish()` throws 501 `sprinklr_not_implemented`.
  - The app always uses `ManualExportAdapter`.
  - When access is granted, implement asset upload, message creation, scheduling and status from the real
    documentation, behind the same interface, with recorded-response tests.

## Amendment 2026-10-26 (drafts mode built; no live posts)
- **Owner's scope:** build the Sprinklr publishing integration "without pushing live posts to our social media
  accounts". Maistro therefore creates **drafts only**; a person schedules them inside Sprinklr.
- **Contract:** `docs/vendor/sprinklr-v3-publishing.json` is a pinned subset of the public v3 spec (downloaded
  2026-10-26, full-spec sha256 in `info.x-full-sha256`), holding only the endpoints called and their schemas.
- **Client** (`api/_studio/sprinklr/client.js`): `Authorization: Bearer SPRINKLR_ACCESS_TOKEN`,
  `Key: SPRINKLR_API_KEY`, base `https://api3.sprinklr.com/{SPRINKLR_ENV}/api/v3`. It refuses every call that is not
  on its allowlist (`GET /me`, `POST /publishing/draft`, `GET /publishing/draft`, `GET /publishing/preview/generate`,
  `GET /publishing/preview/status`, `GET /publishing/post`) **before** any request leaves. Scheduling
  (`POST /publishing/draft/schedule`), publishing (`POST /publishing/post`), messages and replies are not on it.
- **Drafts mode** turns on only with the credentials, `SPRINKLR_DRAFTS=1` and `SPRINKLR_CAMPAIGN_ID`. Otherwise the
  app stays in manual/export mode exactly as before.
  - An export also creates one draft per slot (`OutboundMessage`: caption, the approved final as a `VideoAttachment`
    by a 7-day signed URL, thumbnail as `previewUrl`, slot time as `scheduleDate`, campaign, tags
    `maistro-piece-…`/`maistro-slot-…`, `externalId maistro-slot-<id>`, the account group from
    `SPRINKLR_ACCOUNT_GROUPS`). A repeated export reuses the draft.
  - A failure (unmapped account, missing campaign, no stored video, Sprinklr error) is recorded on the slot
    (`sprinklr_error`); the export itself still stands.
  - `slot-draft-check` reads the draft's status back (stored as `sprinklr_status`) and, with `preview: true`,
    requests a PNG preview, then reads it with `previewId`.
  - `GET /api/studio?sprinklr=check` (admin) runs the read-only `GET /me` check.
- **Migration 023** adds `sprinklr_draft_id`, `sprinklr_status`, `sprinklr_checked_at`, `sprinklr_error` to
  `publishing_slots`. It must be applied before drafts mode is switched on.
- **Not built, and why:**
  - **Media upload.** `POST /media/upload` and `/media/upload/url` have no documented request body. The video
    goes in by URL instead, which `VideoAttachment.url` documents.
  - **Post ids for a draft.** No documented call returns the posts a scheduled draft produced. `GET
    /publishing/post` needs post ids, so the post is still linked by hand ("Published as").
  - **Approval sync.** `PUT /publishing/draft/workflow` only edits tags and custom properties, and the draft's
    `approval.type` is unresolved in the spec.
- **To confirm on the first real probe** (recorded responses, then tighten the tests): whether `scheduleDate` is
  epoch milliseconds; whether a signed Supabase URL is fetched by Sprinklr at draft time or at publish time (7-day
  expiry); the shape of `POST /publishing/draft` and the preview-generate response (spec: a string).
- `SPRINKLR_API_SECRET` is no longer read; v3 calls use the access token.

## Amendment 2026-10-26 (later): the Calendar shows the accounts' real Sprinklr calendar
- With credentials set, the Calendar loads `GET /api/studio?sprinklr=feed`: what the Samsung Gulf accounts posted
  and have lined up in Sprinklr. It reads only; Maistro still never schedules or posts.
  - The accounts are Facebook 6625, Instagram 53027, TikTok 1776286, X 7952 and YouTube 7953;
    `SPRINKLR_FEED_ACCOUNTS` overrides them.
  - **The call:** `POST /reports/query` on the `OUTBOUND_MESSAGE` engine (the time field is the schedule date),
    filtered to those accounts and `MESSAGE_TYPE` 2 ("Update" = a feed post). DMs, comments and replies are other
    types.
  - **Two queries:** the future window and the past window are queried separately, so two weeks of posts can't
    page the scheduled ones out.
  - **Detail:** text, permalink and media come from `GET /publishing/post` (and `GET /publishing/draft` for drafts
    and posts in approval), 50 ids per call. The result is cached per instance for 10 minutes; an uncached load
    takes about 6–14 s.
  - **Found the hard way:** grouping by `PUBLISHED_TIME` silently drops every scheduled post (they have no value
    for it), so the time shown is the schedule date. For a sent post it is within seconds of the publish time.
- The client allowlist gains `POST /reports/query`, a read. `WRITES` lists the only call that changes anything
  in Sprinklr: `POST /publishing/draft`.
- The API user (a client admin) cannot create campaigns (403 on `POST /campaign`) or search accounts. Drafts mode
  still needs a campaign and the account group ids.
