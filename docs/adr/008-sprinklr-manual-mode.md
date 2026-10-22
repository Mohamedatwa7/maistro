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
- **Deviation: the Sprinklr adapter is a gated stub, not a client.** Sprinklr's developer documentation is not
  publicly reachable; a web search on 2026-10-22 found only help-centre pages and a third-party listing. Writing
  calls against guessed endpoints would be the kind of faked integration this ADR forbids.
  - `SprinklrAdapter` reads `SPRINKLR_API_KEY`, `SPRINKLR_API_SECRET` and `SPRINKLR_ENV` only to report
    "configured". `publish()` throws 501 `sprinklr_not_implemented`.
  - The app always uses `ManualExportAdapter`.
  - When access is granted, implement asset upload, message creation, scheduling and status from the real
    documentation, behind the same interface, with recorded-response tests.
