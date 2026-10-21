# ADR-003 — Authentication and roles

Status: accepted 2026-10-21 (roles proposed by the tech lead; the owner may rename or merge them)

## Context
No authentication exists; money-spending endpoints are public; approvals are not attributable (AUDIT D-01). The compliance story depends on knowing who approved what.

## Options
1. **Supabase Auth** (email magic link + Google) with a `members` table and role enum, server-side `requireRole` and matching RLS policies.
2. NextAuth with a custom adapter — more code for the same result.
3. Samsung SSO (SAML/OIDC) — desirable later; needs IT involvement; added as a provider when available.

## Decision
Option 1 now; the `members` table is designed so an SSO provider can be added without a migration.

Roles: `admin` (everything; can reopen approved work, audited), `creator` (create pieces, generate and regenerate, upload references, export manual packages), `reviewer` (approve or reject stages except final), `line_manager` (final approval with the line-manager document), `adlcp_approver` (final approval with the ADLCP document), `viewer` (read-only incl. performance and boost). Service principals: the external Hermes agent (ingest key) and crons (`CRON_SECRET`).

Rules: final needs both documents attached to the version being approved, each confirmed by a member holding the matching role; a member cannot approve a version they generated unless admin; every decision is an immutable row.

## Consequences
Invitations and onboarding become an admin task (a small members page). CORS closes to the app origin.
