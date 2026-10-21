// Golden: the Performance page's merge of /api/track with the /api/sentiment snapshot, and its rendering.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, loadPage, json } = require('../helpers');

const track = fixture('track-14d.json');
const snap = fixture('sentiment-snapshot.json');

function pageWith({ track14 = track, track7 = null, track60 = null, snapshot = snap } = {}) {
  const fetchImpl = async (url) => {
    const u = String(url);
    const pick = u.includes('/api/sentiment') ? snapshot : u.includes('days=14') ? track14 : u.includes('days=7') ? track7 : u.includes('days=60') ? track60 : null;
    if (!pick) throw new Error('down');
    return json(pick);
  };
  return loadPage({ fetchImpl, hash: '#/performance' });
}

test('golden merge: track wins, snapshot fills missing comments/thumbs and appends unknown posts; twins collapsed', async () => {
  const X = pageWith();
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(X.SENTI.posts.length, 30, 'frozen 2026-10-21 (clock frozen at 2026-10-21T10:00Z): 20 track posts + 10 snapshot-only posts');
    assert.equal(X.SENTI.src, track.source);
    const withComments = X.SENTI.posts.filter((p) => p.comments && p.comments.length).length;
    assert.equal(withComments, 12);
    const list = X.pfPosts();
    const s = X.pfStats(list);
    assert.equal(X.pfState().days, '7');
    assert.deepEqual({ posts: s.posts, cmts: s.cmts, analyzed: s.analyzed, pos: s.pos, neg: s.neg, views: s.views }, { posts: 20, cmts: 81, analyzed: 11, pos: 1, neg: 1, views: 31221 });
    const html = X.rPerformance();
    assert.ok(!html.includes('No posts from the past 7 days'));
    assert.ok(html.includes('Total positive rate'));
  } finally { X.restore(); }
});

test('snapshot only (track down): posts load but the 7-day window is empty → zero KPIs (documented AUDIT C-18)', async () => {
  const X = pageWith({ track14: null, track7: null, track60: null });
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(X.SENTI.posts.length, 10);
    assert.equal(X.SENTI.src, 'sentiment tracker');
    const s = X.pfStats(X.pfPosts());
    assert.equal(s.posts, 0);
  } finally { X.restore(); }
});

test('sentiDedupe keeps the analyzed then most-liked copy and ignores whitespace/case in author', () => {
  const X = loadPage();
  try {
    const out = X.sentiDedupe([
      { author: 'Amal', text: 'great  phone', likes: 1, sentiment: 'neu' },
      { author: 'amal ', text: 'great phone', likes: 5, sentiment: null },
      { author: 'amal', text: 'great phone', likes: 2, sentiment: 'pos' },
      { author: 'ziad', text: 'great phone', likes: 9, sentiment: 'pos' },
    ]);
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((c) => [c.author, c.likes, c.sentiment]), [['amal', 2, 'pos'], ['ziad', 9, 'pos']]);
  } finally { X.restore(); }
});

test('radarToTrend maps the API shape to the card shape (platform always tiktok, audio from sound)', () => {
  const X = loadPage();
  try {
    const t = X.radarToTrend({ id: 'x', name: 'N', status: 'peaking', region: 'Global', lang: 'EN', category: 'Comedy', samsungFit: { strength: 'strong', score: 81, ownableBeat: 'beat', rationale: 'why', raw: 'raw' }, momentumPerDay: 12.4, avgEngagementPct: 7.5, mechanic: 'm', tags: ['a'], sound: { title: 'S', author: 'A', musicId: '1', cue: 'c', cleared: false, clearedCheckedAt: '2026-10-01T00:00:00Z' }, clips: [] }, 0);
    assert.equal(t.platform, 'tiktok');
    assert.deepEqual(t.markets, ['Global', 'EN']);
    assert.equal(t.vel, 12);
    assert.equal(t.fitTag, 'STRONG SAMSUNG FIT');
    assert.deepEqual(t.score, { fit: 81, total: 81, why: 'why' });
    assert.equal(t.audio.status, 'pending');
    assert.equal(t.audio.permits, 'Cue: c', 'a cue wins over the clearance sentence');
    assert.match(t.audio.source, /ID 1 · clearance checked 2026-10-01/);
    assert.equal(t.m.er, 0.075);
  } finally { X.restore(); }
});
