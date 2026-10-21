# ADR-004 — Long-running jobs: a jobs table, webhooks where available, a one-minute tick, on-demand reconcile

Status: accepted 2026-10-21

## Context
Seedance renders take 1–3 minutes, F1X8 analyses 10–30 minutes; today the browser polls and holds the only record (AUDIT C-07, C-15). Vercel functions must not wait on providers.

## Options
1. **`jobs` table + Vercel cron tick (every minute) + provider webhooks + reconcile on page open.**
2. A managed queue (Inngest, Trigger.dev, Vercel Queues) — cleaner retries, another vendor and bill; adoptable later behind the same `JobService` interface.
3. Keep client polling — rejected on durability.

## Decision
Option 1. `jobs(state, next_poll_at, attempts)`; the tick polls due rows with bounded concurrency and exponential backoff; F1X8 (our own Modal app) gets a callback URL; Higgsfield webhooks are used if the account supports them, otherwise polled. The client subscribes to job state (SWR) and never talks to a provider directly.

## Consequences
Needs a Vercel plan with minute-level crons. **Q-002 answered 2026-10-21: the project is on the Hobby plan** (12 serverless functions per deployment, crons once a day, 300 s max duration). On Hobby the design degrades to: provider webhooks (F1X8 is ours; Higgsfield if offered) + reconcile-on-open + the daily tick as a backstop — completion is detected when a user opens the piece, not within a minute. Upgrading to Pro (minute crons, more functions, 800 s) is the recommended path before M3 and is an owner decision; nothing in the code depends on it beyond the tick schedule.
