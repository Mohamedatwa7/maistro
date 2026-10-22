# SECURITY — Phase 11: vulnerabilities, attack scenarios, fixes, and the owner's manual actions

Status 2026-10-22. Scope: the Maistro app (`demo-ui`, ma1stro.com). Findings in other repos are listed with their
owner action. Earlier fixes (Phase 4 / M1: bounded HTTP, SSRF allow-list, session gate on spend and write
endpoints) are in AUDIT.md and REBUILD_LOG.md; this document covers what Phase 11 found and fixed.

> **Read first (owner): final approvals now need a member sign-in.** Since S2, the shared password can no longer
> record the ADLCP final approval, reopen a stage, raise a budget or export the delivery package. Sign in once with
> the e-mail link (the Supabase Auth redirect must be set to ma1stro.com) before approving a final.

## 1. Scans (2026-10-22)

| Scan | Result | Action |
|---|---|---|
| `npm audit` (demo-ui) | 3 findings: **postcss** high (XSS in stringify output; file read via an attacker-controlled sourceMappingURL), **sharp** high (libvips, libheif, librsvg CVEs), **next** moderate (through postcss) | postcss pinned to **8.5.31** and sharp to **0.35.5** with npm `overrides`; the major next@16 upgrade is not needed. `npm audit`: **0 vulnerabilities**. Build, type check and tests pass. (db929fe) |
| Secrets in tracked files | none (patterns: Anthropic keys, JWTs incl. Supabase keys, postgres URLs with a password, AWS, GitHub, Supabase PAT, private keys, Slack) | — |
| Secrets in git history | 1 hit: `5cd057a` (2026-09-04), a **localhost** CI test-database URL with a password | **Low**: not a live system. Rotate only if that password is reused anywhere. |

## 2. Findings and fixes

| # | Finding | Severity | Fix | Where |
|---|---|---|---|---|
| F-A | **ADLCP and approval spoofing:** under the shared password, `/api/decisions` and the QC send-back took the approver's **role from the request body**. Anyone with the password could sign the final as `adlcp_approver` or reopen stages as `admin`. | **Critical** | **Member-only, always:** the final approval, reopen, budget raise, delivery package and member admin; a password session gets 403 `member_required` whatever it claims. **Interim claims** (other stage decisions, comment-handled, publishing slots, post links): the password session acts at **reviewer** level and is recorded as **"password session claim"**, never a role from the body. `MAISTRO_REQUIRE_MEMBER=1` closes the interim claims too. Tested: `tests/api/security.test.js` | `api/_auth.js` `memberOnly` / `claimActor`; decisions, studio, sentiment |
| F-B | `/api/projects` (Hermes campaigns) answered **anyone**, with `Access-Control-Allow-Origin: *` | High | Session or ingest bearer; no open CORS (db929fe) | `api/_handlers/projects.js` |
| F-C | Customer comments with author handles in the **public** `/api/track` and `/api/sentiment` reads, edge-cached, CORS `*` (152 comments with usernames on a 7-day read) | High | Session or ingest key; `private` caching; no open CORS (315c2c9); 401s `no-store` (4e6b0c4) | track, sentiment |
| F-D | Reads with `limit=2000`/`5000` silently stopped at the database's 1,000-row cap; e.g. older "handled" marks would have reverted | Medium (integrity) | `queryAll` pages every such read; tested past 1,000 (db929fe; handled d5eaf57) | `api/_supabase.js` |
| F-E | `Access-Control-Allow-Origin: *` on cookie-gated routes (director, higgsfield, qc-f1x8, translate, upload) | Low (cookies are not sent cross-site with `*`) | Removed; only the public trends feed keeps it (tested) | handlers |
| F-F | Tracker status routes (`/api/apify/status`, `/api/apify/sync` GET) are public: sync logs, actor and run ids, miscounted totals | Low | **Other repo** — TRACKER_INGESTION.md P6, needs approval | SamsungSentiment |
| F-G | **No login throttling:** the shared password can be guessed without limit | Medium | **Open.** Mitigation: a long random password, and member links (F-A) for every privileged action. A DB-backed per-IP attempt counter is proposed for Phase 12 | `/api/login` |
| F-H | Paid generation abuse ("burn the budget"): a session holder can create many pieces, each with its own cap | Medium | Every render is priced before submission and refused past its piece's cap; raising a cap is member-only (F-A); no test renders (the adapter refuses under `MAISTRO_NO_RENDER`). **Open:** a daily account-wide spend cap is proposed for Phase 12 | `api/_jobs.js` |

## 3. Realistic attack scenarios

1. **Forged Hermes pushes.** `/api/ingest` accepts a campaign only with the ingest bearer, compared timing-safe
   (`bearerMatches`). Without the key, a push is a 401. With a leaked key, an attacker can push campaigns that
   appear in the Studio. They cannot approve anything (F-A), and the parity checks flag content that breaks the
   brand rules. **Owner:** rotate `MAISTRO_INGEST_KEY` if it ever leaves Vercel or the Hermes host.
2. **Approval bypass and ADLCP spoofing (F-A).** Before S2: password + `{"stage":"final","role":"adlcp_approver"}`
   was a signed final. Now the final approval needs a member, a member session is HMAC-signed, and the member's
   role is re-read from the members table on each privileged call (`refreshMember`). The two ADLCP documents must
   be uploaded with a sha256 for that exact version, and a member cannot approve a version they generated.
3. **Leaked Supabase keys.**
   - The service-role key lives only in Vercel env, server-side; it never reaches the page.
   - Tables have row-level security on; `perf_payloads`, `piece_posts` and `publishing_slots` have no policies,
     so they are service-role only.
   - If the service-role key leaks, it reads and writes everything: **rotate it in Supabase immediately and
     update Vercel.**
   - The tracker key (`TRACK_SUPABASE_KEY`) is read-only in use but should be scoped read-only in the tracker
     project.
4. **Abuse of paid generation endpoints (F-H).** Generation needs a session; each render is priced by the
   provider's own `/estimate` and refused past the piece's cap ($20 at 720p / $50 at 1080p by default); a refused
   job keeps its estimate for audit. Remaining risk: many pieces × cap. Mitigation: member-only cap raises; a
   proposed account-wide daily ceiling.
5. **Customer data exposure (F-C).** Comment text and handles are behind the session; the stored 60-day copy is
   service-role only, served through the gated read; exports in the fixtures are anonymised (md5 tokens, no
   comment ids, names in text redacted).
6. **Cron spoofing.** Crons are recognised by `CRON_SECRET` (Vercel's bearer), not by the spoofable header. A cron
   URL hit without it is a non-cacheable 401, so nobody can plant a cached response at the cron path.

## 4. Manual actions for the owner

| Action | Why | When |
|---|---|---|
| **Rotate the Maistro database password** (it was pasted in a session) and update `MAISTRO_DATABASE_URL` wherever it is used | it has been in chat transcripts | now |
| **Rotate the shared app password** (`MAISTRO_APP_PASSWORD`) to a long random value | F-G, and it was pasted earlier | now |
| **Sign in once with the e-mail link** and invite the team as members (admin / line_manager / adlcp_approver / reviewer) | final approvals are member-only (F-A) | before approving a final |
| Set **`MAISTRO_REQUIRE_MEMBER=1`** in Vercel once the team has members | closes the interim password-session claims | after invites |
| Rotate `MAISTRO_INGEST_KEY`, `CRON_SECRET` and `HF_CREDENTIALS` if any was ever shared outside Vercel | standard hygiene | as needed |
| Approve TRACKER_INGESTION.md **P6** (gate the tracker status routes, fix their counts) | F-F | at the next tracker change |
| Scope the tracker key used by Maistro to **read-only** in the tracker's Supabase | least privilege | at the next tracker change |

## 5. Not done in Phase 11 (owner or Phase 12)
- **Login throttling (F-G) and an account-wide daily spend ceiling (F-H):** need a small store table each; proposed
  for Phase 12 with monitoring.
- The history hit in `5cd057a` is not rewritten (localhost only; rewriting public history costs more than it
  protects).
