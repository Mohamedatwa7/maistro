// /api/thumb — a fresh TikTok cover, because the signed cover links stored upstream expire within days.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, text } = require('../helpers');

const EMBED = '<script>{"itemInfos":{"covers":["https:\u002F\u002Fp16-common-sign.tiktokcdn.com\u002Fobj\u002Fcover.image?x-expires=1\u0026x-signature=s"]}}</script>';
const JPG = new Uint8Array([255, 216, 255, 224]);

test('reads the cover off the embed page and streams it, cached at the CDN', async () => {
  const f = mockFetch([
    [/tiktok\.com\/embed\/v2\/7695485112284122399$/, () => text(EMBED)],
    [/p16-common-sign\.tiktokcdn\.com\/obj\/cover\.image\?x-expires=1&x-signature=s$/, () => new Response(JPG, { status: 200, headers: { 'content-type': 'image/jpeg' } })],
  ]);
  const h = api('thumb.js');
  try {
    const r = res(); let body; r.end = (b) => { body = b; r.ended = true; return r; };
    await h.handler(req({ query: { vid: '7695485112284122399' } }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.headers['content-type'], 'image/jpeg');
    assert.match(r.headers['cache-control'], /s-maxage=43200/); assert.deepEqual([...body], [...JPG]);
  } finally { f.restore(); h.restore(); }
});

test('rejects a non-numeric id, needs a session, and 404s (briefly cached) when there is no cover or it is off TikTok\'s CDN', async () => {
  const h = api('thumb.js');
  const f = mockFetch([[/embed\/v2\/111111111$/, () => text('<html>nothing</html>')], [/embed\/v2\/222222222$/, () => text('"covers":["https://evil.example.com/x.jpg"]')]]);
  try {
    let r = res(); await h.handler(req({ query: { vid: '../x' } }), r); assert.equal(r.statusCode, 422);
    r = res(); await h.handler(req({ query: { vid: '111111111' }, session: false }), r); assert.equal(r.statusCode, 401);
    r = res(); await h.handler(req({ query: { vid: '111111111' } }), r); assert.equal(r.statusCode, 404); assert.match(r.headers['cache-control'], /s-maxage=600/);
    r = res(); await h.handler(req({ query: { vid: '222222222' } }), r); assert.equal(r.statusCode, 404);
    assert.equal(f.calls.filter((c) => /evil/.test(c.url || c[0] || '')).length, 0, 'never fetches a non-TikTok host');
  } finally { f.restore(); h.restore(); }
});
