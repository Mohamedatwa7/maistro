# ADR-006 — Asset storage: private Supabase Storage buckets with signed URLs; generated media copied in

Status: accepted 2026-10-21

## Context
Reference photos sit in a public bucket; generated media exists only at Higgsfield URLs with unknown expiry; ADLCP documents are not stored at all (AUDIT A-02, A-08, A-09).

## Options
1. **Private Supabase Storage buckets + signed URLs, generated media copied in** — one vendor, RLS-aware, cheap for ≤ 10 s videos.
2. Keep provider URLs (Higgsfield CDN) and the public bucket — no copy cost, but expiry is unknown and product shots are world-readable (A-08, A-09).
3. S3/R2 with a CDN — more control and cheaper egress at scale; a second vendor and IAM surface for a volume we do not have yet.

## Decision
Option 1. Three private buckets (`assets`, `approvals`, `refs`); signed URLs (1 hour) issued by the server to authorised members only; every finished Higgsfield or F1X8 output is copied into `assets` with its sha256 at job completion; ADLCP and line-manager documents are stored immutably under the artifact version with checksum and uploader. Objects in today's public bucket are migrated and the bucket closed.

## Consequences
Storage cost scales with campaigns (acceptable; videos are at most 10 seconds). Embeds in exported packages are time-limited by design.
