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

**Rollback and the schema.** A rollback changes code only: migrations stay applied, so an older deployment runs
on the newer schema.
- **All 23 migrations to date are additive**: new tables, new columns, and check constraints *widened* by drop
  and re-add (013, 014, 017, 021); the other drops re-create triggers and policies idempotently. Older code keeps
  working on them; it simply ignores what it does not know.
- **Before releasing a non-additive change** (a dropped or renamed column, a narrowed constraint, rewritten data),
  write and test its down-migration first, and note it here.

The release that introduced each recent migration. Rolling back to a deployment older than that commit means old
code on that table:

| Migration | Introduced in | Rolling back past it means |
|---|---|---|
| 018 piece_posts | 4e6b0c4 | attribution links stay; old code does not read them |
| 019 publishing_slots | 868268a | planned posts stay; the Calendar is the simulated one again |
| 020 perf_payloads | 465b390 | the stored 60-day copy is ignored (live reads) |
| 021 bench kind | 6ae67f8 | the stored benchmarks are ignored |
| 022 login_attempts, ops_alerts | 61d381e | no throttle, no alerts; the rows stay |
| 023 publishing_slots Sprinklr columns | c0ca368 | draft ids and statuses stay; old code does not read them |

To check a candidate: read the revision from `<deployment-url>/api/health`, then run
`git merge-base --is-ancestor <revision> <introducing-commit>`. A zero exit status means the deployment predates
that migration.

### Turning on Sprinklr drafts (ADR-008)
Maistro creates Sprinklr **drafts only**; a person schedules them in Sprinklr. Nothing in Maistro can schedule or post.
1. Apply migration 023 (`node db/migrate.mjs` with the production URL).
2. In Vercel (Production), set `SPRINKLR_API_KEY`, `SPRINKLR_ACCESS_TOKEN` and `SPRINKLR_ENV` (e.g. `prod2`; it is in
   the Sprinklr app URL and in the developer portal). Redeploy (`release.sh` or `vercel deploy --prod`).
3. As an admin, open `/api/studio?sprinklr=check`: `ok: true` with the API user means the credentials work.
4. Set `SPRINKLR_CAMPAIGN_ID` (the campaign the drafts are filed under) and `SPRINKLR_ACCOUNT_GROUPS`
   (`tiktok:samsunggulf=<account group id>,instagram:samsunggulf=<id>,…`, one per owned account in
   `MAISTRO_OWNED_ACCOUNTS`), then `SPRINKLR_DRAFTS=1`, and redeploy. The Calendar pill reads "Sprinklr: drafts only".
5. Plan one post and export it. The slot shows `SPRINKLR DRAFT <id>`; **Check draft** reads its status and
   **Preview** renders it. If the draft was not created, the slot says why in red (unmapped account, campaign, a
   Sprinklr error).
6. To switch back to manual mode, remove `SPRINKLR_DRAFTS` and redeploy.

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
- `campaign_events` (Hermes pushes), `content_pieces`, `stages`, `artifact_versions`, `approvals`, `adlcp_documents`,
  `qc_results`, `stage_checks`, `jobs`;
- `kb_documents`, `creative_specs`, `prompt_registry`, `generation_records`;
- `trend_snapshots`, `trend_scores`, `trend_decisions`;
- `piece_posts`, `publishing_slots`, `audit_log`, `members`, `schema_migrations`.

The list is `TABLES` in `.github/workflows/backup.yml`, and the deliberate exclusions are `EXCLUDED` beside it. `tests/api/backup-tables.test.js` fails when a migration creates a table that is in neither list.

**Deliberately not backed up** (tracker-derived copies of customer comment text; owner data-handling constraint):
- `sentiment_posts`, `perf_payloads`, and `reconciliation_reports` (whole table: its reports carry comment samples);
- all three are re-derivable from the tracker by the next cron run.

`trends_cache` (derived), `login_attempts` and `ops_alerts` (operational, short-lived) are not backed up either.

**Storage objects** (the ADLCP approval documents, piece assets) are not in the table dump. **Owner to choose:**
Supabase's own storage backups (plan-dependent), or a separate encrypted copy.

**How** (`.github/workflows/backup.yml`; it stays inert until the owner adds the secrets
`MAISTRO_DATABASE_URL` and `BACKUP_AGE_RECIPIENT`, the owner's age **public** key):
- **Nightly backup** (01:15 UTC): `pg_dump --format=custom` of the listed tables (schema and data), encrypted
  with `age` to the owner's key, kept 14 days as a workflow artifact. The private key never enters CI.
- **To restore:** download the artifact, `age -d -i <owner key>`, then `pg_restore --no-owner --no-privileges`
  into the target.
- **Restore drill** (monthly, or `workflow_dispatch` with `job=drill`): takes a fresh dump of the same tables,
  restores it into a throwaway Postgres 17 service container, and compares row counts table by table. Nothing is
  kept. Supabase-only objects (policies that reference `auth.*`) are listed as warnings; the drill proves the
  **data** comes back. The workflow run is the proof.

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

## Monitoring (Phase 12 O4)
The hourly `/api/monitor` cron (:40) checks, from stored data only, with no provider calls:

| Check | Fails when |
|---|---|
| trend scores stale | newest > 2 h |
| Trend Radar feed not fetched | newest snapshot > 2 h |
| Higgsfield failure rate | > 20 % of ≥ 5 jobs in 24 h |
| Higgsfield refusal spike | > 3 refused in 24 h |
| daily spend near the ceiling | ≥ 80 % |
| F1X8 timeouts | any in 24 h |
| tracker stale | a platform with no post in 48 h |
| reconciliation | newest missing, failed or > 26 h old |
| price card | missing, incomplete or > 26 h old |

Each failing check keeps **one** open `ops_alerts` row, which is resolved when the check passes. New alerts are
POSTed to `MAISTRO_ALERT_WEBHOOK` (a Slack-compatible `{text}`; optional, owner to set) and marked `sent_at`.
`GET /api/monitor` (signed-in) lists the open alerts, and `/api/health` shows `integrations` as ok or alert per
check.

## Environments (Phase 12 O3)
| Scope | Serves | Data |
|---|---|---|
| Production | ma1stro.com, maistro-demo.vercel.app | the Maistro Supabase project |
| Preview | every non-main push or PR (Vercel git integration) | **today the same project** — `/api/health` shows `dataIsolation: "preview uses the production database"` on a preview |
| Development | `vercel dev` / local | the developer's own env |

**Owner action for separation:**
1. Create a second Supabase project, `maistro-preview` (free tier).
2. Apply the migrations to it (`MAISTRO_DATABASE_URL=<preview url> node db/migrate.mjs`).
3. Set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` in the **Preview** scope to
   that project, plus `MAISTRO_PREVIEW_DB=1`.
4. Leave the tracker key in Preview **read-only**, or unset.

Never put production keys in the Development scope.

## Production cutover for ma1stro.com (Phase 12 O8)
ma1stro.com already serves this Vercel project (an alias on the `demo-ui` project), so there is no pending
cutover. For a future move (a new project, region or domain), keep it zero-downtime:
1. Lower the DNS TTL to 300 s a day ahead.
2. Deploy the new target and verify it on its own URL: `/api/health` ok, the page, the crons listed and the
   migrations applied.
3. Add the domain to the new project (Vercel verifies it) **before** removing it from the old one.
4. Move the alias; check `www.ma1stro.com/api/health` for the new revision from two networks.
5. Keep the old deployment for 48 h as the rollback target, then raise the TTL again.
