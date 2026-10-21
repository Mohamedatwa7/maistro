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
