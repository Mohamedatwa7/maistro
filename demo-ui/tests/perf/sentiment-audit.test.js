// 7.3 — sentiment quality, recomputed from the labelled fixture so every figure in PERFORMANCE_INSIGHTS.md §3 is
// code-computed: accuracy per language bucket × label source with Wilson 95 % intervals, per-class precision and
// recall, and an overall accuracy weighted by each bucket's share of the 60-day population (the sample is
// stratified). Labels are Claude's, blind; Arabic, Gulf, Arabizi, mixed and sarcasm need a native-speaker check.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../helpers');

const f = fixture('sentiment-audit-2026-10-22.json');
const wilson = (k, n, z = 1.96) => { const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [+((c - m) / d).toFixed(3), +((c + m) / d).toFixed(3)]; };
function cells() {
  const out = {};
  for (const r of f.rows) { const k = `${r.bucket}|${r.source}`; const c = out[k] = out[k] || { n: 0, ok: 0 }; c.n++; if (r.stored === r.truth) c.ok++; }
  for (const [k, c] of Object.entries(out)) { c.ci = wilson(c.ok, c.n); c.population = f.population[k] || 0; }
  return out;
}
function classes(source) {
  const rs = f.rows.filter((r) => r.source === source), out = {};
  for (const t of ['pos', 'neu', 'neg']) {
    const tp = rs.filter((r) => r.truth === t && r.stored === t).length;
    const truth = rs.filter((r) => r.truth === t).length, pred = rs.filter((r) => r.stored === t).length;
    out[t] = { truth, predicted: pred, recall: truth ? +(tp / truth).toFixed(3) : null, precision: pred ? +(tp / pred).toFixed(3) : null };
  }
  return out;
}

test('7.3 per bucket × source: accuracy with Wilson 95 % intervals (n = 20 each)', () => {
  const c = cells();
  const got = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, [v.ok, v.n, ...v.ci]]));
  assert.deepEqual(got, {
    'arabic|lexicon': [10, 20, 0.299, 0.701], 'arabic|tracker': [13, 20, 0.433, 0.819],
    'arabizi|lexicon': [7, 20, 0.181, 0.567], 'arabizi|tracker': [17, 20, 0.64, 0.948],
    'emoji_only|lexicon': [1, 20, 0.009, 0.236], 'emoji_only|tracker': [19, 20, 0.764, 0.991],
    'english|lexicon': [14, 20, 0.481, 0.855], 'english|tracker': [18, 20, 0.699, 0.972],
    'mixed|lexicon': [11, 20, 0.342, 0.742], 'mixed|tracker': [17, 20, 0.64, 0.948],
  });
});

test('7.3 overall: tracker 84/100 (weighted 0.90), keyword fallback 43/100 (weighted 0.64); classes and the neutral → positive confusion', () => {
  const c = cells();
  const weighted = (src) => { const ks = Object.keys(c).filter((k) => k.endsWith('|' + src)); const pop = ks.reduce((a, k) => a + c[k].population, 0); return +(ks.reduce((a, k) => a + (c[k].ok / c[k].n) * c[k].population, 0) / pop).toFixed(3); };
  const ok = (src) => f.rows.filter((r) => r.source === src && r.stored === r.truth).length;
  assert.equal(ok('tracker'), 84); assert.deepEqual(wilson(84, 100), [0.756, 0.899]); assert.equal(weighted('tracker'), 0.9);
  assert.equal(ok('lexicon'), 43); assert.deepEqual(wilson(43, 100), [0.337, 0.528]); assert.equal(weighted('lexicon'), 0.638);
  assert.deepEqual(classes('tracker'), { pos: { truth: 52, predicted: 62, recall: 0.962, precision: 0.806 }, neu: { truth: 34, predicted: 24, recall: 0.618, precision: 0.875 }, neg: { truth: 14, predicted: 14, recall: 0.929, precision: 0.929 } });
  assert.deepEqual(classes('lexicon'), { pos: { truth: 64, predicted: 13, recall: 0.172, precision: 0.846 }, neu: { truth: 34, predicted: 87, recall: 0.941, precision: 0.368 }, neg: { truth: 2, predicted: 0, recall: 0, precision: null } });
  // the tracker's main error: neutral comments (giveaway entries, bare product names) called positive
  assert.equal(f.rows.filter((r) => r.source === 'tracker' && r.truth === 'neu' && r.stored === 'pos').length, 12);
  // sarcasm: 5 flagged, all labelled by intent correctly by the tracker
  const sarc = f.rows.filter((r) => /sarcasm/.test(r.flag || ''));
  assert.equal(sarc.length, 5); assert.ok(sarc.every((r) => r.source === 'tracker' && r.stored === r.truth));
  assert.ok(!/jaehyeo|محمد فارس/i.test(JSON.stringify(f)), 'names in comment text redacted');
});
