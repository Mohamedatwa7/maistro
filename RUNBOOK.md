# RUNBOOK — Maistro operations (Phase 12)

Production: **www.ma1stro.com** and **maistro-demo.vercel.app** (one Vercel project, `demo-ui`). Every release
goes through `bash demo-ui/scripts/release.sh <msg-file> <paths…>`, and every rollback through
`bash demo-ui/scripts/rollback.sh <deployment-url>`. Never use `vercel deploy` by hand or push `main` directly.

**Where to look first:**
- `GET /api/health` — revision, `ok`, tools, integrations;
- the Performance header pills (data as of, STALE);
- `ops_alerts` (newest rows);
- `reconciliation_reports` (newest row);
- the Vercel function logs.

**Crons (vercel.json):**

| Path | Schedule (UTC) | Job |
|---|---|---|
| `/api/track?cron=1` | 06:30 | 60-day read, snapshot, reconciliation, stored 60-day copy |
| `/api/track?cron=1&bench=1` | 06:50 | 90-day benchmarks copy |
| `/api/trends` | hourly at :15 | trend scoring, eval, price card |
| `/api/jobs` | every minute | generation jobs |

`vercel crons run "<path>"` runs one on demand (no secret needed).

## Incidents

### Bad deploy (page broken, errors after a release)
1. `vercel ls --prod` and pick the last good deployment URL. Its `/api/health` revision is the SHA it was
   released from.
2. Run `bash demo-ui/scripts/rollback.sh <that-url>`. It promotes the deployment and waits until both hosts
   report that revision and serve the same page. `main` in git does not change.
3. Fix forward: a new commit, then `release.sh`.

### Trend feed empty or stale
- Check `/api/trends` (it shows the board date) and whether the newest `trend_scores` row is under 2 h old.
- Kymah / Trend Radar is upstream (`TRENDRADAR_BASE_URL`). If its board publish failed, see the Trend Radar
  memory notes; the board-restore steps live in the Trend Radar repo.
- Re-run: `vercel crons run "/api/trends"`.

### Tracker data stale (a STALE pill; "no recent data" on a platform)
- Usually upstream. TRACKER_INGESTION.md F2 covers X and Facebook (scrapers "succeed" with no new items): check
  the scraper's runs in the Apify console (P1).
- Maistro shows the staleness and does not hide it. Nothing to fix in Maistro.

### A cron did not run (no reconciliation row today; the stored copy is older than 26 h)
- Run `vercel crons run "/api/track?cron=1"`, then read the newest `reconciliation_reports` row **after about 3
  minutes**: the 60-day read takes time, so don't conclude anything at minute 1.
- A partial 60-day read falls back to 14 days for the snapshot and stores no 60-day copy. The page then reads
  live; that is expected.

### Higgsfield failures or refusal spikes
- Look at the jobs' `error` and the `generation_records` status. An nsfw refusal on a product shot is retried
  once with the refusal rewrite.
- A provider outage is visible as `failed` / `timed_out`. Jobs stop at their cap, nothing is charged for failed
  renders, and the Studio shows the error.
- **No test renders** (owner rule): never "check" Higgsfield by rendering. Free `/estimate` calls are fine.

### Budget or ceiling reached ("budget cap" or "account daily ceiling" in a job error)
- Per piece: a line manager or admin uses **Set cap** on the piece (member sign-in).
- Account-wide: `MAISTRO_DAILY_SPEND_USD` in Vercel env (admin), or wait for 00:00 GST.

### F1X8 down or slow
- QC and final verification jobs time out (cap 30 min). Re-run QC from the piece once F1X8 is back.
- Cold starts take 10–20 min, so check `generation_records` latency before calling it down.

### Login locked out
- Password: 10 failed attempts from an address lock that address for up to 15 min (429 + Retry-After). Wait, or
  use the e-mail sign-in link, which is not throttled.
- A global failure spike only raises an `ops_alerts` row and locks nobody out.
- Final approvals, reopen, budget raise, the delivery package and member admin **need a member sign-in** (the
  e-mail link); the shared password cannot do them.

### Database restore
- See **Backup and restore** below. Restore into a scratch database first, verify, and only then point
  production at it.

### Secret rotation
Set the new value in Vercel (Production, plus Preview if used), redeploy with `release.sh` (or `vercel redeploy`
of the current production), then update any outside holder:

| Secret | Outside holders |
|---|---|
| `MAISTRO_DATABASE_URL` | the migrate command; the GitHub secret for backups |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase dashboard: roll the key, update Vercel |
| `MAISTRO_INGEST_KEY` | the Hermes host; the SamsungSentiment push scripts |
| `CRON_SECRET` | Vercel sets it for crons; just roll it |
| `MAISTRO_APP_PASSWORD` | tell the team |
| `HF_CREDENTIALS`, `F1X8_*`, `ANTHROPIC_API_KEY`, `TRACK_SUPABASE_KEY`, `SPRINKLR_*` | provider dashboards |

### A migration failed
- `node db/migrate.mjs` applies files in order and records each in `schema_migrations`. A failed file is not
  recorded: fix it and re-run.
- Never edit a migration that has been applied. Add the next number instead (e.g. 021 widened 020's check).

## Backup and restore

**What is backed up** (Maistro-owned data):
- `content_pieces`, `stages`, `artifact_versions`, `approvals`, `adlcp_documents`, `jobs`;
- `kb_documents`, `creative_specs`, `prompt_registry`, `generation_records`;
- `trend_snapshots`, `trend_scores`, `trend_decisions`;
- `piece_posts`, `publishing_slots`, `audit_log`, `members`, `schema_migrations`.

**Deliberately not backed up** (tracker-derived copies of customer comment text; owner data-handling constraint):
- `sentiment_posts`, `perf_payloads`, and the comment samples inside `reconciliation_reports.report`;
- all three are re-derivable from the tracker by the next cron run.

`login_attempts` and `ops_alerts` are operational and short-lived, and are not backed up either.

**Storage objects** (the ADLCP approval documents, piece assets) are not in the table dump. **Owner to choose:**
Supabase's own storage backups (plan-dependent), or a separate encrypted copy.

**How** (Phase 12 O5, once the owner adds the secrets): a nightly GitHub Action dumps the listed tables with
`pg_dump --data-only -t …` plus the schema, encrypts the dump with the owner's `age` public key, and keeps it 14
days as a workflow artifact. A monthly **restore drill** restores the newest dump into a throwaway Postgres
service container, runs `node db/migrate.mjs` (it must find 0 migrations to apply), and compares row counts per
table with the dump's manifest. The workflow run is the proof.

## Production deployment checklist
- [ ] Migrations for this change applied (`node db/migrate.mjs` with the production URL) — **before** the
      release when the code needs them.
- [ ] New env vars set in Vercel (Production scope), with defaults documented.
- [ ] `npm test`, `npm run evals`, `npm run typecheck`, `npm run build` green locally.
- [ ] `release.sh` used. It checks the suite, CI for the exact SHA, the fast-forward, the deploy, both hosts on
      the revision and an identical page.
- [ ] After the release: `/api/health` ok on both hosts; crons listed (`vercel crons ls`); the monitor shows no
      new critical alert.
- [ ] REBUILD_LOG.md entry; the checker told.
