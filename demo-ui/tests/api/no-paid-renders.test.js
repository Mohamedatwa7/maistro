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

test('the eval runner drops HF_CREDENTIALS and sets MAISTRO_NO_RENDER before anything else', () => {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'evals.js'), 'utf8');
  const first = s.indexOf("delete process.env.HF_CREDENTIALS"), flag = s.indexOf("process.env.MAISTRO_NO_RENDER = '1'"), firstRequire = s.indexOf('require(');
  assert.ok(first > 0 && flag > 0 && first < firstRequire && flag < firstRequire);
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
