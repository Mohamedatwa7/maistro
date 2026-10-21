// Characterization of the Studio's pure logic: deliverables, versions, QC fixes, director context, titles.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('../helpers');

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

test('esc escapes only & and < (AUDIT D-02 — a quote in a title survives into attributes)', () => {
  const X = loadPage();
  try {
    assert.equal(X.esc('a<b&"c\'d>'), 'a&lt;b&amp;"c\'d>');
    assert.equal(X.fmt(1234567), '1.2M'); assert.equal(X.fmt(950), '950'); assert.equal(X.pct(0.0349), '3.5%');
  } finally { X.restore(); }
});
