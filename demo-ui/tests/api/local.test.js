// `npm run local` (scripts/local.js) — the one-command local run boots on seeded fakes, needs no keys, never reaches
// the network, and keeps renders off.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

test('local run: page, login, trends and tracker data from the fakes; renders refused; unknown hosts get 503', async () => {
  const env = { ...process.env, PORT: '0', ANTHROPIC_API_KEY: 'must-be-dropped', HF_CREDENTIALS: 'must-be-dropped' };
  const child = spawn(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'local.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const base = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => { out += d; const m = out.match(/http:\/\/localhost:(\d+)/); if (m) resolve(`http://127.0.0.1:${m[1]}`); });
      child.on('exit', (c) => reject(new Error('local.js exited ' + c + ' ' + out)));
      setTimeout(() => reject(new Error('local.js did not start: ' + out)), 15000);
    });
    const page = await fetch(base + '/');
    assert.equal(page.status, 200); assert.match(await page.text(), /<script>/);
    assert.equal((await fetch(base + '/api/track?days=14')).status, 401, 'the session gate still applies');
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'local' }) });
    assert.equal(login.status, 204);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const health = await (await fetch(base + '/api/health')).json();
    assert.equal(health.revision, 'local'); assert.equal(health.configured.ANTHROPIC_API_KEY, false, 'real keys in the shell are dropped');
    const trends = await (await fetch(base + '/api/trends', { headers: { cookie } })).json();
    assert.ok(trends.count > 0, 'the recorded Trend Radar feed');
    const track = await (await fetch(base + '/api/track?days=14', { headers: { cookie } })).json();
    assert.equal(track.posts.length, 20); assert.ok(track.comments.matched > 0);
    assert.ok(Date.now() - Date.parse(track.posts[0].postedAt) < 3 * 864e5, 'fixture dates shifted to end yesterday');
    const hf = await fetch(base + '/api/higgsfield', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'image', prompt: 'x' }) });
    assert.ok(hf.status >= 400, 'no renders locally');
  } finally { child.kill(); }
});
