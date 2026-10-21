# ADR-009 — Strangler migration; git-connected Vercel with previews and manual production promotion

Status: accepted 2026-10-21

## Context
Deploys are CLI uploads of a working tree (AUDIT G-03); the site must stay up while it is rebuilt.

## Options
1. **Strangler: new app owns the domain, legacy file served per route behind flags, git-connected previews, manual promotion** — the site never goes dark; each page is proven before it replaces the old one.
2. Big-bang rewrite on a separate domain, switch DNS at the end — long period with two products and no user feedback; riskier cutover.
3. Keep CLI deploys from a working tree — what is deployed is not what is committed (G-03); rejected.

## Decision
Option 1. Connect the Vercel project to the GitHub repo: every branch gets a preview; `main` reaches production only by manual promotion. The new Next.js app owns the domain and serves the legacy file at the old hash routes until each page is replaced, behind per-page flags; the external `/api/trends` and `/api/ingest` contracts keep their URLs and shapes. Each milestone in `MIGRATION_PLAN.md` ships to preview, is verified end to end, then promoted; rollback is promoting the previous production deployment (documented in `RUNBOOK.md`).

## Consequences
The Next.js app lives in `demo-ui/` (the Vercel root) with the legacy single file served at `/` via a rewrite until the last page moves; CI gates every push (lint, type-check, tests, migrations).

Amendment 2026-10-21 (M2): the Hobby plan caps a deployment at 12 serverless functions and the legacy endpoints used all twelve, so they are consolidated behind one dispatcher (`api/[route].js` → `api/_handlers/*`) with identical URLs and shapes. New server routes must either live in the dispatcher or stay within the remaining function budget until the plan changes. Git connection still requires the owner to set Root Directory = `demo-ui` in the dashboard first.
