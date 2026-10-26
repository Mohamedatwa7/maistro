// 7.4 — comment themes: false-positive lists in both languages, the counting rules, and per-theme precision /
// recall recomputed from the two labelled fixtures, which must equal the AUDIT table the page shows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('../helpers');
const T = require('../../api/_perf/themes.js');

const wilson = (k, n, z = 1.96) => { if (!n) return null; const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [+((c - m) / d).toFixed(3), +((c + m) / d).toFixed(3)]; };
function score(rows, id, truthOf) {
  let tp = 0, fp = 0, fn = 0;
  for (const r of rows) { const c = T.classify(r.text).ids.includes(id), t = truthOf(r).includes(id); if (c && t) tp++; else if (c) fp++; else if (t) fn++; }
  return { tp, fp, fn, precision: tp + fp ? +(tp / (tp + fp)).toFixed(3) : null, recall: tp + fn ? +(tp / (tp + fn)).toFixed(3) : null, pCI: wilson(tp, tp + fp), rCI: wilson(tp, tp + fn) };
}
function measured() {
  const ex = fixture('theme-audit-issues-2026-10-22.json').rows;
  const sm = fixture('theme-audit-sample-2026-10-22.json').rows.filter((r) => !r.truth.includes('brand_reply'));
  const out = {};
  for (const th of T.THEMES) {
    const exhaustive = th.group === 'product_issue' || th.group === 'complaint';
    out[th.id] = { basis: exhaustive ? 'every distinct candidate text (adjudicated)' : 'seeded sample', ...score(exhaustive ? ex : sm, th.id, (r) => (exhaustive ? r.adjudicated : r.truth)) };
  }
  return out;
}

test('theme false positives (EN / AR): no purchase intent in "how much I love it" / "كم حلو"; no praise inside an issue report; no question for exclamations; spam is only spam', () => {
  const ids = (t) => T.classify(t).ids;
  assert.deepEqual(ids('how much I love it'), []); assert.deepEqual(ids('كم حلو'), []);
  assert.deepEqual(ids('Light from the window'), []); assert.deepEqual(ids('My battery is amazing'), []);
  assert.equal(T.classify('what a phone').question, false); assert.equal(T.classify('Is it waterproof').question, true);
  assert.deepEqual(ids("for me the best combo, don't buy ios pods, you wont be disappointed").filter((x) => x.startsWith('complaint')), []);
  assert.deepEqual(ids('Doesn’t disappoint at all 🔥').filter((x) => x.startsWith('complaint')), []);
  assert.deepEqual(ids('Father please prophecy eternal #Seat28G … SUES, EXTORTIONS, SERVICE'), ['spam']);
  for (const [t, want] of [['How much is the Fold8 in AED?', 'purchase_price'], ['على كم', 'purchase_price'], ['متى ينزل في الإمارات؟', 'purchase_availability'], ['I would buy the Fold8', 'purchase_buy'],
    ['My S22 Ultra got green line', 'issue_screen'], ['#RedLine hardware defect', 'issue_screen'], ['انتفاخ البطاريات', 'issue_battery'], ['white line on screen due to software upgrade', 'issue_update'],
    ['after sales are a joke', 'complaint_service'], ['no warantty guranty', 'complaint_repair'], ['عايزين 11300 تغير الشاشه', 'complaint_repair'], ['Stay away from Samsung products', 'complaint_general'], ['اسوء خدمه عملاء', 'complaint_general']])
    assert.ok(ids(t).includes(want), `${t} → ${want} (got ${ids(t)})`);
});

test('counting: brand replies excluded; giveaway posts give entries, not praise; issues keep their product (from the comment first); shares only at n ≥ 20', () => {
  const posts = [
    { postId: 'g', platform: 'facebook', caption: 'Comment below for a chance to win a Galaxy Z Fold8!', comments: [
      { author: 'Samsung', text: 'Get the Fold8 for AED 7,999 on Samsung.com' }, { author: 'a', text: 'Mint colour all the way', sentiment: 'pos' }, { author: 'b', text: 'My S22 Ultra got green line after the update', sentiment: 'neg' }] },
    { postId: 'p', platform: 'instagram', caption: 'Galaxy Z Flip8 in Mint', comments: [{ author: 'c', text: 'Pink lines on my screen', sentiment: null }, { author: 'd', text: 'Love the colour', sentiment: 'pos' }] },
  ];
  const r = T.themes(posts, { seed: 't' });
  const get = (id) => r.themes.find((t) => t.id === id);
  assert.equal(r.brandRepliesExcluded, 1); assert.equal(r.total, 4);
  assert.equal(get('giveaway_entry').n, 1, 'the colour comment on the giveaway post is an entry');
  assert.equal(get('praise_design').n, 1, 'only the organic post\'s colour comment is praise');
  assert.equal(get('issue_screen').n, 2);
  assert.deepEqual(get('issue_screen').products, [{ name: 'Older models (pre-2026)', n: 1 }, { name: 'Galaxy Z Flip8', n: 1 }], 'product from the comment (an S22 Ultra counts as an older model), else the caption; no shares below n = 20');
  assert.deepEqual(get('issue_screen').sentiment, { pos: 0, neu: 0, neg: 1, notAnalysed: 1 });
  assert.equal(get('issue_screen').examples.length, 2);
});

test('per-theme precision and recall recomputed from the fixtures equal the AUDIT table the page shows', () => {
  const m = measured();
  assert.deepEqual(T.AUDIT, m);
});
