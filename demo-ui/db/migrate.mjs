// Apply db/migrations/*.sql in order to Maistro's Postgres, recording each in
// schema_migrations so a re-run is a no-op (ADR-002).
//
//   MAISTRO_DATABASE_URL=postgres://... node db/migrate.mjs            # apply pending
//   MAISTRO_DATABASE_URL=postgres://... node db/migrate.mjs --status   # list applied/pending
//
// The direct (non-pooler) Supabase connection string is required for DDL.
// Needs the `pg` package (devDependency). Never run against the tracker's
// database — that one is read-only to Maistro.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "migrations");
const conn = process.env.MAISTRO_DATABASE_URL;
if (!conn) { console.error("MAISTRO_DATABASE_URL is not set"); process.exit(1); }
const require = createRequire(import.meta.url);
const { Client } = require("pg");

const u = new URL(conn);
u.searchParams.delete("sslmode");
const client = new Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: false }, statement_timeout: 300000 });
await client.connect();
try {
  await client.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const applied = new Set((await client.query(`select name from schema_migrations`)).rows.map((r) => r.name));
  const files = readdirSync(dir).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  if (process.argv.includes("--status")) {
    for (const f of files) console.log(`${applied.has(f) ? "applied" : "pending"}  ${f}`);
  } else {
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = readFileSync(join(dir, f), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query(`insert into schema_migrations (name) values ($1)`, [f]);
        await client.query("commit");
        console.log(`applied  ${f}`);
      } catch (e) {
        await client.query("rollback");
        console.error(`FAILED   ${f}: ${e.message}`);
        process.exit(1);
      }
    }
    console.log("up to date");
  }
} finally {
  await client.end();
}
