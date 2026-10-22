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
  // 64 since 2026-10-22: six simulated-calendar checks became three manual-mode checks (8b, ADR-008)
  assert.ok(passes >= 64, `expected at least 64 PASS lines, got ${passes}\n${r.stderr}`);
  assert.equal(r.status, 0);
});
