// The enum CHECK constraints of the real schema, read from db/migrations in order (a later
// `alter table … add constraint … check (col in (…))` replaces the earlier one). fake-postgrest
// enforces them, so a value production would reject (e.g. generation_records.kind 'assemble'
// before 017) fails the tests instead of failing silently in a best-effort write.
const fs = require('node:fs');
const path = require('node:path');

function load(dir = path.join(__dirname, '..', 'db', 'migrations')) {
  const out = {}; // table -> col -> [values]
  const files = fs.readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
  const values = (inner) => [...inner.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  for (const f of files) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/create table if not exists (\w+) \(([\s\S]*?)\n\);/g)) {
      const table = m[1];
      for (const c of m[2].matchAll(/\n\s*(\w+) text[^\n]*?check \(\1 in \(([^)]*)\)\)/g)) (out[table] = out[table] || {})[c[1]] = values(c[2]);
    }
    for (const m of sql.matchAll(/alter table (\w+) add constraint \w+ check \((\w+) in \(([^)]*)\)\)/g)) (out[m[1]] = out[m[1]] || {})[m[2]] = values(m[3]);
  }
  return out;
}

module.exports = { load };
