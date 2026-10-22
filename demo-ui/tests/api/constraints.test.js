// The test database enforces the migrations' enum CHECKs (tests/schema-constraints.js). This test keeps the gap
// visible: every other CHECK in the migrations is listed here as NOT enforced by fake-postgrest. A new check that is
// neither parsed nor listed fails this test, so it cannot slip in unseen.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { load, loadNumeric } = require('../schema-constraints.js');

// checks the fake does not enforce (none today; a multi-column or expression check would go here)
const UNENFORCED = [];

test('every CHECK in the migrations is either enforced by the fake (enum) or listed as unenforced', () => {
  const dir = path.join(__dirname, '..', '..', 'db', 'migrations');
  const enums = load(dir);
  const enforced = new Set(Object.entries(enums).flatMap(([t, cols]) => Object.keys(cols).map((c) => `${t}.${c}`)));
  const all = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '');
    for (const m of sql.matchAll(/check \(([^;]*?)\)(?=[,\n;)])/g)) all.push({ file: f, expr: m[1].replace(/\s+/g, ' ').trim() });
  }
  const numeric = loadNumeric(dir);
  const numCols = new Set(Object.values(numeric).flatMap((cols) => Object.keys(cols)));
  const unknown = all.filter((c) => !/^\w+ in \(/.test(c.expr) && !numCols.has((c.expr.match(/^(\w+)/) || [])[1]) && !UNENFORCED.some((u) => c.expr.includes(u)));
  assert.deepEqual(numeric.adlcp_documents.size_bytes, { min: 0, exclusiveMin: true }); assert.deepEqual(numeric.content_pieces.budget_warn_pct, { min: 1, max: 100 });
  assert.deepEqual(unknown, [], `CHECKs neither enforced nor listed:\n${unknown.map((u) => `${u.file}: ${u.expr}`).join('\n')}`);
  assert.ok(enforced.size >= 16, `the enum CHECKs are parsed (${enforced.size})`);
});
