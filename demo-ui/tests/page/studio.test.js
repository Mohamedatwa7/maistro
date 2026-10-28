// Characterization of the Studio's pure logic: deliverables, versions, QC fixes, director context, titles.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, json } = require('../helpers');

function piece(X, extra = {}) {
  const p = { id: 'gen-test', generated: true, studio: true, stage: 1, title: 'Deadpan Fold', trend: 'T', product: 'Galaxy Z Fold8', markets: ['UAE'], platforms: ['tiktok'], th: ['#000', '#111'], map: { product: 'Galaxy Z Fold8', msg: 'm', angle: 'a' }, ...extra };
  X.PROJECTS.unshift(p);
  return p;
}

test('attachTo: first attach creates a pending deliverable; regeneration bumps the version and resets any decision', () => {
  const X = loadPage();
  try {
    const p = piece(X);
    X.attachTo(p, 'thumb', { imageUrl: 'https://cdn/1.png', prompt: 'p', note: 'n', title: 'T', sub: 's' }, 'Pixel');
    assert.equal(p.stage, 3, 'thumb is stage 2 → pointer 3');
    let d = X.DELIVS.find((x) => x.id === 'd-gen-test-thumb');
    assert.deepEqual([d.st, d.ver, d.by, d.stage], ['pending', 'v1', 'Pixel', 'thumb']);
    d.st = 'approved'; d.appr = { name: 'A', info: 'i', at: 'now' };
    X.attachTo(p, 'thumb', { imageUrl: 'https://cdn/2.png', prompt: 'p2', note: 'n2', title: 'T', sub: 's' }, 'Pixel');
    d = X.DELIVS.find((x) => x.id === 'd-gen-test-thumb');
    assert.deepEqual([d.st, d.ver, d.appr], ['pending', 'v2', undefined], 'AUDIT A-04: the previous approval is discarded');
    assert.equal(X.DELIVS.filter((x) => x.proj === 'gen-test').length, 1);
  } finally { X.restore(); }
});

test('qcFixes distils the F1X8 draft verdict; absent until a real draft run exists', () => {
  const X = loadPage();
  try {
    const p = piece(X);
    assert.equal(X.qcFixes(p), null);
    p.qc = { real: true, runs: { draft: { score: 6.4, verdict: { summary: 'ok', risks: [{ rank: 1, issue: 'slow open', suggested_fix: 'cut 1s' }], revision_brief: { objective: 'faster' } } } } };
    assert.deepEqual(X.qcFixes(p), { score: 6.4, fixes: ['#1 slow open → cut 1s'], revisionBrief: { objective: 'faster' }, summary: 'ok' });
  } finally { X.restore(); }
});

test('genCtx forwards only prompts of mood/thumb/board; delivTitle covers every stage shape', () => {
  const X = loadPage();
  try {
    const p = piece(X, { mood: { prompt: 'mp', note: 'mn' }, thumb: { imageUrl: 'u', title: 'T' }, board: [{ tc: '0:00' }], brief: { objective: 'o' } });
    assert.deepEqual(X.genCtx(p), { mood: { prompt: 'mp', note: 'mn' } });
    assert.equal(X.delivTitle('mood', { tiles: [1, 2, 3] }), 'Moodboard — 3 palette tiles');
    assert.equal(X.delivTitle('mood', { imageUrl: 'u' }), 'Moodboard — generated art-direction board');
    assert.equal(X.delivTitle('thumb', { title: 'T' }), 'Thumbnail — “T”');
    assert.equal(X.delivTitle('board', [1, 2]), 'Storyboard — 2 beat-mapped frames');
    assert.equal(X.delivTitle('board', { imageUrl: 'u' }), 'Storyboard — 6-panel generated sheet');
    assert.equal(X.delivTitle('draft', { version: 'v1' }), 'First draft v1 — Seedance cut');
    assert.equal(X.delivTitle('final', { version: 'v2', qcRevised: true, variants: [] }), 'Final cut v2 — F1X8 fixes implemented');
    assert.equal(X.delivTitle('final', { version: 'v1', variants: [1, 2] }), 'Final cut v1 — 2 variants');
    assert.equal(X.delivTitle('qc', { real: true, avg: 7.25 }), 'QC report — F1X8 real analysis · composite 7.3/10');
    assert.equal(X.delivTitle('qc', { f1x8: [{ s: 80 }, { s: 90 }] }), 'QC report — F1X8 85/100 + human review');
  } finally { X.restore(); }
});

test('stageArtifact: studio piece shows a create box for an empty stage and the final box stays locked until draft + QC exist', () => {
  const X = loadPage();
  try {
    const p = piece(X);
    assert.match(X.stageArtifact(p, 1), /READY TO CREATE/);
    assert.match(X.stageArtifact(p, 7), /Unlocks after the Quality Check/);
    p.draft = { videoUrl: 'https://cdn/v.mp4', version: 'v1', dur: '5s', audio: 'a', variants: [{ a: '16:9', l: '720p', k: 'seedance', st: 'ready' }] };
    p.qc = { real: true, runs: { draft: { score: 6, verdict: { risks: [], revision_brief: {} } } } };
    assert.match(X.stageArtifact(p, 7), /Implement F1X8's fixes/);
  } finally { X.restore(); }
});

test('esc escapes & < > " \' (M1 fix for AUDIT D-02) and a hostile campaign title cannot inject markup', () => {
  const X = loadPage();
  try {
    assert.equal(X.esc('a<b&"c\'d>'), 'a&lt;b&amp;&quot;c&#39;d&gt;');
    const p = piece(X, { title: '<img src=x onerror=alert(1)>', product: 'P"', trend: 'T' });
    X.STATE.proj = p.id;
    X.DELIVS.unshift({ id: 'd-' + p.id + '-brief', proj: p.id, stage: 'brief', title: 'Brief <script>', ver: 'v1', by: 'Quill<', at: 'Just now', st: 'approved', appr: { name: 'Eve<svg onload=1>', info: 'i', at: 'now' } });
    const html = X.rStudio();
    assert.ok(!html.includes('<img src=x onerror'), 'title is escaped in the studio header and tabs');
    assert.ok(!html.includes('<svg onload'), 'approver name is escaped in the Production Center');
    assert.ok(!html.includes('Brief <script>'), 'deliverable title is escaped');
    assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
    assert.equal(X.fmt(1234567), '1.2M'); assert.equal(X.fmt(950), '950'); assert.equal(X.pct(0.0349), '3.5%');
  } finally { X.restore(); }
});

test('stageArtifact qc: a simulated dispatch estimate is labelled as such and shows no human sign-off; a pushed qc with a named reviewer still renders', () => {
  const X = loadPage();
  try {
    const p = piece(X, { studio: false, stage: 6, qc: { f1x8: [{ n: 'Audience fit', s: 70 }], f1x8Note: 'estimate', simulated: true, human: null, humanNote: null } });
    let html = X.stageArtifact(p, 6);
    assert.match(html, /Pre-flight estimate \(Claude\) — not an F1X8 result/);
    assert.match(html, /AWAITING HUMAN REVIEW/);
    assert.ok(!/QC PASSED/.test(html));
    p.qc = { f1x8: [{ n: 'Audience fit', s: 88 }], f1x8Note: 'n', human: 'N. Haddad · lead', humanNote: 'ok' };
    html = X.stageArtifact(p, 6);
    assert.match(html, /F1X8 automated check/); assert.match(html, /N\. Haddad · lead/); assert.match(html, /QC PASSED/);
  } finally { X.restore(); }
});

test('approval record: stored documents render name, checksum and an OPEN link; a pre-storage string record is labelled as name only', () => {
  const X = loadPage();
  try {
    assert.match(X.docLabel({ name: 'adlcp.pdf', path: 'documents/2026/abc-def123.pdf', sha256: 'deadbeef' + '0'.repeat(56) }), /adlcp\.pdf · <span title="sha256 deadbeef0+">deadbeef<\/span> · <a href="#" onclick="event\.preventDefault\(\);docOpen\('documents\/2026\/abc-def123\.pdf'\)"/);
    assert.match(X.docLabel('ADLCP-approval'), /ADLCP-approval <span class="dim">\(name only/);
    assert.equal(X.docLabel(null), '');
  } finally { X.restore(); }
});

test('stored assets (H-4): an artifact with an assetPath renders without a provider src and with data-asset + data-fallback, hydrateAssets signs it once and caches the URL; QC assets carry the stored path', async () => {
  const signs = [];
  const X = loadPage({ fetchImpl: async (u) => { if (String(u).startsWith('/api/jobs?asset=')) { signs.push(String(u)); return json({ url: 'https://sb.test/storage/v1/object/sign/assets/x?token=t', expiresIn: 3600 }); } return new Promise(() => {}); } });
  try {
    const stored = { imageUrl: 'https://cdn/t.png', assetPath: 'pieces/gen-test/thumb/a-b.png', sha256: 'f'.repeat(64) };
    assert.equal(X.mediaAttrs(stored, 'imageUrl'), 'data-asset="pieces/gen-test/thumb/a-b.png" data-fallback="https://cdn/t.png"');
    assert.equal(X.mediaAttrs({ imageUrl: 'https://cdn/t.png' }, 'imageUrl'), 'src="https://cdn/t.png"', 'no copy → provider URL as before');
    assert.equal(X.mediaAttrs(null, 'imageUrl'), '');
    const p = piece(X, { stage: 3, thumb: stored, draft: { videoUrl: 'https://cdn/v.mp4', assetPath: 'pieces/gen-test/draft/c-d.mp4', version: 'v1', dur: '5s', audio: 'a', variants: [{ a: '16:9', l: '720p', k: 'seedance', st: 'ready' }] } });
    const html = X.stageArtifact(p, 2);
    assert.match(html, /<img class="gen-media"[^>]*data-asset="pieces\/gen-test\/thumb\/a-b\.png" data-fallback="https:\/\/cdn\/t\.png"/); assert.ok(!/src="https:\/\/cdn\/t\.png"/.test(html), 'the expiring provider URL is not the src');
    assert.deepEqual(X.qcAssets(p).map((a) => [a.sid, a.url, a.assetPath]), [['thumb', 'https://cdn/t.png', 'pieces/gen-test/thumb/a-b.png'], ['draft', 'https://cdn/v.mp4', 'pieces/gen-test/draft/c-d.mp4']]);
    const el = (path) => ({ dataset: { asset: path }, src: '' });
    const a = el('pieces/gen-test/thumb/a-b.png'), b = el('pieces/gen-test/thumb/a-b.png');
    await X.hydrateAssets({ querySelectorAll: () => [a, b] });
    assert.equal(a.src, 'https://sb.test/storage/v1/object/sign/assets/x?token=t'); assert.equal(b.src, a.src); assert.equal(signs.length, 1, 'cached');
    assert.ok(X.ASSET_URLS['pieces/gen-test/thumb/a-b.png'].exp > Date.now());
    // a re-render that never calls hydrateAssets (stage switch, job polling) still has the image
    assert.equal(X.mediaAttrs(stored, 'imageUrl'), 'data-asset="pieces/gen-test/thumb/a-b.png" src="https://sb.test/storage/v1/object/sign/assets/x?token=t" data-hydrated="1" data-fallback="https://cdn/t.png"');
    X.ASSET_URLS['pieces/gen-test/thumb/a-b.png'].exp = Date.now() - 1;
    assert.equal(X.mediaAttrs(stored, 'imageUrl'), 'data-asset="pieces/gen-test/thumb/a-b.png" data-fallback="https://cdn/t.png"', 'an expired URL is signed again, not reused');
  } finally { X.restore(); }
});

test('setView: an identical Studio re-render (job polling, server sync) leaves the DOM alone; changed markup or another view in #view redraws', () => {
  const X = loadPage({ fetchImpl: async () => new Promise(() => {}) });
  try {
    let writes = 0; let html = '';
    const view = { get innerHTML() { return html; }, set innerHTML(h) { writes++; html = h; view.firstChild = { h }; }, firstChild: null, querySelectorAll: () => [] };
    const qs = X.document.querySelector; X.document.querySelector = (s) => (s === '#view' ? view : qs.call(X.document, s));
    assert.equal(X.setView('<div>a</div>'), true); assert.equal(X.setView('<div>a</div>'), false); assert.equal(writes, 1, 'same markup → no redraw');
    assert.equal(X.setView('<div>b</div>'), true); assert.equal(writes, 2);
    view.innerHTML = '<div>calendar</div>'; assert.equal(X.setView('<div>b</div>'), true, 'another view replaced #view → redraw'); assert.equal(writes, 4);
  } finally { X.restore(); }
});
