# ADR-002 — Persistence: Maistro's own Supabase Postgres with migrations in the repo

Status: accepted 2026-10-21

## Context
Campaign, approval and ADLCP state lives in browser localStorage; the server has two append-only tables with no keys or versions (AUDIT A-01…A-07). The tracker's database is an external system Maistro must not write to.

## Options
1. **Supabase Postgres (the existing Maistro project)** with a real schema, RLS policies, Storage, migrations in `db/migrations/`.
2. Vercel Postgres / Neon — fine technically, a second vendor for no gain.
3. Keep event-sourcing in `campaign_events` and project views — fits the ingest path, not approvals, ADLCP or jobs; harder to query and enforce.

## Decision
Option 1, relational, with append-only tables where history matters (artifact_versions, approvals, audit_log) and upserts where identity matters (performance_snapshots by post + day).

## Consequences
The tracker's Supabase stays read-only behind `TrackerSource`. Migrations run in CI against a throwaway database before preview and production.
