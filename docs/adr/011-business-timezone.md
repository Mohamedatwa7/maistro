# ADR-011 — One business timezone: Asia/Dubai

Status: accepted 2026-10-21

## Context
Windows and day buckets are computed in viewer-local or UTC time (AUDIT C-17); the business operates in the Gulf.

## Options
1. **Asia/Dubai fixed on the server** — one truth for KPIs and reconciliation with the tracker.
2. Viewer-local time — what happens today; totals differ per viewer (C-17).
3. UTC everywhere — reproducible but wrong for "today" and posting slots in the Gulf.

## Decision
Option 1. All day keys, windows ("past 7 days"), KPI buckets and slot labels are computed on the server in `Asia/Dubai`; timestamps travel as ISO-8601 with offset; the UI formats in Asia/Dubai regardless of the viewer's locale, showing the zone once per page.

## Consequences
Performance totals become reproducible between viewers and against the tracker (Phase 6 reconciliation).
