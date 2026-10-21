# ADR-001 — Frontend and server framework: Next.js (App Router) on Vercel

Status: accepted 2026-10-21

## Context
The product is a single 3,112-line HTML file with innerHTML rendering and ~190 global functions (AUDIT G-04, F-01, D-02). It must be rebuilt page by page while ma1stro.com keeps serving, stay on Vercel, and give the team one language for client and server.

## Options
1. **Next.js 15 App Router + React 19 + TypeScript** — route handlers replace `api/*.js`, server components for data-heavy pages, first-class Vercel deploys/previews/crons; the tracker already uses Next, so the team knows it.
2. SvelteKit — smaller bundles, smaller ecosystem, no team familiarity.
3. Vite + React SPA with the existing serverless functions — keeps the API/UI split that produced the state-in-browser design; no server rendering.

## Decision
Option 1. React's default escaping removes the XSS class in D-02; route handlers + zod give one validation layer; previews per branch enable the strangler migration (ADR-009).

## Consequences
A build step and a dependency tree where there was none (lockfile committed, Dependabot). The legacy file is served from `legacy/` until the last page moves.
