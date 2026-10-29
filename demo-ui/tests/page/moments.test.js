// Trend Analysis → Moments (the calendar and breaking columns) and part 3 on the live feed:
// each micro trend's reach, its link to a moment, and the niche trends hidden by default.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage } = require('../helpers');

const trend = (X, o) => X.radarToTrend({ id: o.id, name: o.name, status: 'peaking', region: 'Global', lang: 'EN', category: 'Dance', samsungFit: { strength: o.strong ? 'strong' : 'fit', score: o.fit ?? 40 }, momentumPerDay: 5, viewsPerWeek: o.views ?? null, tags: o.tags || [], clips: Array.from({ length: o.creators ?? 3 }, (_, k) => ({ vid: String(k), handle: '@h' + k })) }, 0);

function seed(X) {
  X.LIVE.on = true;
  X.TRENDS.length = 0;
  X.TRENDS.push(
    trend(X, { id: 'big', name: 'Big dance', views: 9e6 }),
    trend(X, { id: 'mid', name: 'Mid dance', views: 1e6 }),
    trend(X, { id: 'solo', name: 'Solo dance', views: 1e6, creators: 1 }),
    trend(X, { id: 'small', name: 'Small dance', views: 2e5 }),
    trend(X, { id: 'unk', name: 'Unmeasured dance' }),
    trend(X, { id: 'fit', name: 'Small but on-brand', views: 1e5, fit: 72, strong: true }),
    trend(X, { id: 'hw', name: 'La Calabaza Halloween Dance', views: 4e5 }),
    trend(X, { id: 'bo', name: '"why is everyone clapping?" edit', views: 3e5, tags: ['ballondor2026', "ballon d'or"] }),
  );
  Object.assign(X.MOMENTS, {
    loaded: true,
    upcoming: [{ id: 'halloween', label: 'Halloween', keywords: ['halloween', 'calabaza'], category: 'culture', markets: ['AE'], from: '2026-10-31', to: '2026-10-31', daysUntil: 2, prepBy: '2026-10-17', leadDays: 14, status: 'prep', estimate: false, note: 'n' },
      { id: 'ramadan', label: 'Ramadan', keywords: ['ramadan'], category: 'religious', markets: ['AE'], from: '2027-02-08', to: '2027-03-09', daysUntil: 102, prepBy: '2026-12-25', leadDays: 45, status: 'later', estimate: true, note: 'n' }],
    breaking: { classifiedBy: 'claude', items: [{ id: 'bo', label: "Ballon d'Or 2026", keywords: ["ballon d'or"], category: 'sport', markets: ['AE'], sources: ['google'], traffic: 1000, wikiViews: 0, scale: 'macro', brandSafe: true, why: 'w', samsungAngle: 'a', news: [] }], hidden: [], routine: 3 },
  });
}

test('part 3: reach comes from weekly views (one creator drops a level), a moment tie makes a trend broad and links it, and moments outside 60 days do not link', () => {
  const X = loadPage({ hash: '#/' });
  try {
    seed(X);
    const by = Object.fromEntries(X.TRENDS.map((t) => [t.id, t]));
    assert.deepEqual(['big', 'mid', 'solo', 'small', 'unk'].map((k) => X.trendReach(by[k])), [3, 2, 1, 1, 0]);
    assert.deepEqual(X.momentFor(by.hw), { label: 'Halloween', when: 'in 2 days' });
    assert.deepEqual(X.momentFor(by.bo), { label: "Ballon d'Or 2026", when: 'spiking now' }, 'breaking moments win, matched on the hashtags');
    assert.equal(X.trendReach(by.hw), 3, 'tied to a moment');
    assert.equal(X.momentFor({ name: 'Ramadan iftar recipe' }), null, 'Ramadan is 102 days out: no link yet');
    assert.equal(X.momentFor({ name: 'Unpumpkinable' }), null, 'keywords match whole words only');
  } finally { X.restore(); }
});

test('part 3: the live feed hides niche and unmeasured trends unless on-brand, lists moment-linked trends first, and can show everything', () => {
  const X = loadPage({ hash: '#/' });
  try {
    seed(X);
    X.STATE.trView = 'live';
    let html = X.rTrends();
    for (const n of ['Big dance', 'Mid dance', 'Small but on-brand', 'La Calabaza Halloween Dance']) assert.ok(html.includes(n), n);
    for (const n of ['Solo dance', 'Small dance', 'Unmeasured dance']) assert.ok(!html.includes(`>${n}</h3>`), `${n} is hidden`);
    assert.match(html, /Show 3 niche trends/); assert.match(html, /3 niche or unmeasured trends are hidden/);
    { const at = (n) => html.indexOf(`>${n}</h3>`); assert.ok(at('La Calabaza Halloween Dance') < at('Big dance') && html.indexOf('why is everyone clapping') < at('Big dance'), 'moment-linked trends first'); }
    assert.match(html, /TIES TO HALLOWEEN · IN 2 DAYS/); assert.match(html, /TIES TO BALLON D&#39;OR 2026 · SPIKING NOW/);
    assert.match(html, />BROAD</); assert.match(html, />GROWING</);
    X.STATE.showNiche = true; html = X.rTrends();
    assert.ok(html.includes('>Unmeasured dance</h3>')); assert.match(html, /REACH NOT MEASURED/); assert.match(html, /Hide 3 niche trends/);
    // the Moments view itself
    X.STATE.trView = 'moments'; html = X.rTrends();
    assert.match(html, /③ · Moments/); assert.match(html, /Plan for these/); assert.match(html, /What the Gulf is searching/);
    assert.match(html, /Production window is open/); assert.match(html, /DATE TO CONFIRM/); assert.match(html, /3 routine searches/);
  } finally { X.restore(); }
});
