// Runs the existing DOM-stub smoke script as a child process and requires every check to pass.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('.smoke-test.js: every check passes', () => {
  const r = spawnSync(process.execPath, ['.smoke-test.js'], { cwd: path.join(__dirname, '..', '..'), encoding: 'utf8' });
  const passes = (r.stdout.match(/^PASS /gm) || []).length;
  const fails = (r.stdout.match(/^FAIL /gm) || []).length;
  assert.equal(fails, 0, r.stdout.split('\n').filter((l) => l.startsWith('FAIL')).join('\n'));
  // 59 since 2026-10-26: the Performance redesign checks each of its four tabs (11 checks) instead of one long page (16)
  assert.ok(passes >= 59, `expected at least 59 PASS lines, got ${passes}\n${r.stderr}`);
  assert.equal(r.status, 0);
});
