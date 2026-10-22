// Phase 12 O5 follow-up — the backup is an allowlist, so a table added by a new migration would silently go unbacked
// up. Every `create table` in db/migrations must be in backup.yml's TABLES or its deliberate EXCLUDED list, never both.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const yml = fs.readFileSync(path.join(ROOT, '..', '.github', 'workflows', 'backup.yml'), 'utf8');
const list = (name) => (yml.match(new RegExp(`^ *${name}: "([^"]*)"`, 'm')) || ['', ''])[1].split(/\s+/).filter(Boolean);

test('backup: every migrated table is either backed up or deliberately excluded', () => {
  const dir = path.join(ROOT, 'db', 'migrations');
  const created = new Set();
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql'))) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(/create table (?:if not exists )?(?:public\.)?([a-z_]+)/gi)) created.add(m[1].toLowerCase());
  }
  const tables = new Set(list('TABLES')); const excluded = new Set(list('EXCLUDED'));
  assert.ok(tables.size > 10 && excluded.size > 0, 'both lists parsed');
  assert.deepEqual([...tables].filter((t) => excluded.has(t)), [], 'a table is in both lists');
  assert.deepEqual([...created].filter((t) => !tables.has(t) && !excluded.has(t)).sort(), [], 'add the new table to TABLES or EXCLUDED in backup.yml');
});
