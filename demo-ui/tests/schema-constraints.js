// The CHECK constraints of the real schema, read from db/migrations in order (a later
// `alter table … add constraint … check (col in (…))` replaces the earlier one). fake-postgrest
// enforces them, so a value production would reject (e.g. generation_records.kind 'assemble'
// before 017) fails the tests instead of failing silently in a best-effort write.
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'db', 'migrations');
const files = (dir) => fs.readdirSync(dir).filter((f) => /^\d+.*\.sql$/.test(f)).sort();
const read = (dir, f) => fs.readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '');

/** Enum CHECKs: table -> col -> [values]. */
function load(dir = DIR) {
  const out = {};
  const values = (inner) => [...inner.matchAll(/'([^']*)'/g)].map((m) => m[1]);
  for (const f of files(dir)) {
    const sql = read(dir, f);
    for (const m of sql.matchAll(/create table if not exists (\w+) \(([\s\S]*?)\n\);/g)) {
      const table = m[1];
      for (const c of m[2].matchAll(/\n\s*(\w+) text[^\n]*?check \(\1 in \(([^)]*)\)\)/g)) (out[table] = out[table] || {})[c[1]] = values(c[2]);
    }
    for (const m of sql.matchAll(/alter table (\w+) add constraint \w+ check \((\w+) in \(([^)]*)\)\)/g)) (out[m[1]] = out[m[1]] || {})[m[2]] = values(m[3]);
  }
  return out;
}

/** Numeric CHECKs: `col > n` in column definitions and `col between a and b` (incl. alter table add column). */
function loadNumeric(dir = DIR) {
  const out = {}; // table -> col -> { min, max, exclusiveMin }
  for (const f of files(dir)) {
    const sql = read(dir, f);
    for (const m of sql.matchAll(/create table if not exists (\w+) \(([\s\S]*?)\n\);/g)) {
      for (const c of m[2].matchAll(/check \((\w+) > (-?\d+(?:\.\d+)?)\)/g)) (out[m[1]] = out[m[1]] || {})[c[1]] = { min: Number(c[2]), exclusiveMin: true };
    }
    for (const m of sql.matchAll(/alter table (\w+) add column if not exists (\w+)[^;]*?check \(\2 between (-?\d+) and (-?\d+)\)/g)) (out[m[1]] = out[m[1]] || {})[m[2]] = { min: Number(m[3]), max: Number(m[4]) };
  }
  return out;
}

module.exports = { load, loadNumeric };
