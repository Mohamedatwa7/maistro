# ADR-009 — Strangler migration; git-connected Vercel with previews and manual production promotion

Status: accepted 2026-10-21

## Context
Deploys are CLI uploads of a working tree (AUDIT G-03); the site must stay up while it is rebuilt.

## Decision
Connect the Vercel project to the GitHub repo: every branch gets a preview; `main` reaches production only by manual promotion. The new Next.js app owns the domain and serves the legacy file at the old hash routes until each page is replaced, behind per-page flags; the external `/api/trends` and `/api/ingest` contracts keep their URLs and shapes. Each milestone in `MIGRATION_PLAN.md` ships to preview, is verified end to end, then promoted; rollback is promoting the previous production deployment (documented in `RUNBOOK.md`).

## Consequences
The repo root becomes the Next.js app (`demo-ui/` moves to `legacy/`); CI gates every push (lint, type-check, tests, migrations).
