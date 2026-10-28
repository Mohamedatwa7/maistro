// Owner decision 2026-10-22: no Higgsfield spend for testing. The adapter refuses submits under MAISTRO_NO_RENDER,
// the eval runner sets it and drops the credentials, and every script that could render refuses to run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mockFetch, json } = require('../helpers');

const ROOT = path.join(__dirname, '..', '..');

test('the adapter refuses a submit when MAISTRO_NO_RENDER=1 — before any request leaves', async () => {
  const saved = { c: process.env.HF_CREDENTIALS, n: process.env.MAISTRO_NO_RENDER };
  process.env.HF_CREDENTIALS = 'id:secret'; process.env.MAISTRO_NO_RENDER = '1';
  const f = mockFetch([[/higgsfield/, () => json({ status: 'queued', request_id: 'should-not-happen' })]]);
  try {
    delete require.cache[require.resolve(path.join(ROOT, 'api', '_adapters', 'higgsfield.js'))];
    const hf = require(path.join(ROOT, 'api', '_adapters', 'higgsfield.js'));
    await assert.rejects(hf.submit({ kind: 'image', prompt: 'p', aspect_ratio: '9:16' }), (e) => e.code === 'renders_disabled' && e.status === 403);
    assert.equal(f.calls.length, 0, 'nothing was sent');
  } finally {
    f.restore();
    if (saved.c === undefined) delete process.env.HF_CREDENTIALS; else process.env.HF_CREDENTIALS = saved.c;
    if (saved.n === undefined) delete process.env.MAISTRO_NO_RENDER; else process.env.MAISTRO_NO_RENDER = saved.n;
  }
});

test('the Hermes adapter refuses a run when MAISTRO_NO_RENDER=1 too (its bots call paid generators) — before any request leaves', async () => {
  const saved = { u: process.env.HERMES_API_URL, k: process.env.HERMES_API_KEY, n: process.env.MAISTRO_NO_RENDER };
  process.env.HERMES_API_URL = 'https://hermes.test'; process.env.HERMES_API_KEY = 'hk'; process.env.MAISTRO_NO_RENDER = '1';
  const f = mockFetch([[/hermes\.test/, () => json({ run_id: 'run_x', status: 'started' })]]);
  try {
    const hermes = require(path.join(ROOT, 'api', '_adapters', 'hermes.js'));
    for (const role of hermes.ROLES) await assert.rejects(hermes.submit(role, { input: 'p' }), (e) => e.code === 'renders_disabled' && e.status === 403);
    assert.equal(f.calls.length, 0, 'nothing was sent');
  } finally {
    f.restore();
    for (const [k, v] of [['HERMES_API_URL', saved.u], ['HERMES_API_KEY', saved.k], ['MAISTRO_NO_RENDER', saved.n]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('the eval runner drops HF_CREDENTIALS and HERMES_API_KEY and sets MAISTRO_NO_RENDER before anything else', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'evals.js'), 'utf8');
  const first = s.indexOf("delete process.env.HF_CREDENTIALS"), hermes = s.indexOf('delete process.env.HERMES_API_KEY'), flag = s.indexOf("process.env.MAISTRO_NO_RENDER = '1'"), firstRequire = s.indexOf('require(');
  assert.ok(first > 0 && hermes > 0 && flag > 0 && first < firstRequire && hermes < firstRequire && flag < firstRequire);
});

test('every script that can reach a Higgsfield render endpoint refuses to run', () => {
  const RENDER = /@higgsfield\/client|higgsfield\.ai\/v1\/(?:text2image|image2video|generations)|\/higgsfield-ai\/|\/bytedance\/seedance/;
  for (const f of fs.readdirSync(path.join(ROOT, 'scripts')).filter((x) => /\.(m?js|cjs)$/.test(x))) {
    if (f === 'evals.js') continue;
    const s = fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8');
    if (!RENDER.test(s)) continue;
    assert.match(s, /DISABLED \(owner decision 2026-10-22\)[\s\S]*process\.exit\(1\)/, `${f} can render and must refuse`);
  }
});
