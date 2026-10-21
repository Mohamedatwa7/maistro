// api/_http.js: hard timeout, retries only on 429/5xx/network, no retry without opting in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchT } = require('../../api/_http.js');

function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return Promise.resolve().then(fn).finally(() => { globalThis.fetch = real; });
}

test('times out with a named error', async () => {
  await withFetch((u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'TimeoutError' })))), async () => {
    await assert.rejects(fetchT('https://x.test/slow', {}, { timeoutMs: 30 }), (e) => e.code === 'ETIMEDOUT' && /timed out after 30 ms/.test(e.message));
  });
});

test('retries 5xx then returns the good response; counts attempts', async () => {
  let n = 0;
  await withFetch(async () => { n++; return new Response('x', { status: n < 3 ? 503 : 200 }); }, async () => {
    const r = await fetchT('https://x.test/', {}, { timeoutMs: 1000, retries: 2 });
    assert.equal(r.status, 200); assert.equal(n, 3);
  });
});

test('no retry by default and never on 4xx', async () => {
  let n = 0;
  await withFetch(async () => { n++; return new Response('x', { status: 503 }); }, async () => {
    assert.equal((await fetchT('https://x.test/', {}, { timeoutMs: 1000 })).status, 503); assert.equal(n, 1);
  });
  n = 0;
  await withFetch(async () => { n++; return new Response('x', { status: 404 }); }, async () => {
    assert.equal((await fetchT('https://x.test/', {}, { timeoutMs: 1000, retries: 3 })).status, 404); assert.equal(n, 1);
  });
});

test('network error is retried then rethrown', async () => {
  let n = 0;
  await withFetch(async () => { n++; throw new Error('ECONNRESET'); }, async () => {
    await assert.rejects(fetchT('https://x.test/', {}, { timeoutMs: 1000, retries: 1 }), /ECONNRESET/);
    assert.equal(n, 2);
  });
});
