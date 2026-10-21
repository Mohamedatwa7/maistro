// TREND_FRAMEWORK.md §3: lifecycle, timing and the deterministic scores are pure functions of snapshot rows.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../api/_trends/signals.js');

const NOW = '2026-10-21T10:00:00.000Z';
const row = (day, growth, extra = {}) => ({ trend_id: 't1', fetched_at: `${day}T09:00:00.000Z`, board_generated_at: `${day}T08:25:00.000Z`, growth_pct_per_day: growth, durability: 'ongoing', stage: 'peaking', ...extra });

test('boards(): one point per distinct board, newest first; repeated hourly fetches of the same board collapse', () => {
  const pts = S.boards([row('2026-10-19', 1), { ...row('2026-10-20', 2), fetched_at: '2026-10-20T10:00:00Z' }, { ...row('2026-10-20', 2), fetched_at: '2026-10-20T11:00:00Z' }]);
  assert.equal(pts.length, 2); assert.equal(pts[0].board_generated_at, '2026-10-20T08:25:00.000Z');
});

test('lifecycle: unknown with one board; emerging/rising/peaking/declining/evergreen from velocity, acceleration, days on board and board presence', () => {
  assert.equal(S.lifecycle([row('2026-10-21', 3)], { now: NOW, latestBoardAt: '2026-10-21T08:25:00Z' }).stage, 'unknown');
  let l = S.lifecycle([row('2026-10-20', 1), row('2026-10-21', 3)], { now: NOW, latestBoardAt: '2026-10-21T08:25:00Z' });
  assert.deepEqual([l.stage, l.velocity, l.acceleration, l.daysOnBoard, l.boardsSeen], ['emerging', 3, 2, 2, 2]);
  l = S.lifecycle([row('2026-10-17', 1), row('2026-10-18', 1.5), row('2026-10-19', 2), row('2026-10-20', 2.5), row('2026-10-21', 3)], { now: NOW, latestBoardAt: '2026-10-21T08:25:00Z' });
  assert.equal(l.stage, 'rising');
  l = S.lifecycle([row('2026-10-17', 4), row('2026-10-21', 3)], { now: NOW, latestBoardAt: '2026-10-21T08:25:00Z' });
  assert.equal(l.stage, 'peaking', 'decelerating but still growing');
  l = S.lifecycle([row('2026-10-17', 4), row('2026-10-19', 3)], { now: NOW, latestBoardAt: '2026-10-21T08:25:00Z' });
  assert.equal(l.stage, 'declining', 'left the board'); assert.equal(l.onLatestBoard, false);
  l = S.lifecycle([row('2026-10-19', 1), row('2026-10-21', -1)], { now: NOW, latestBoardAt: '2026-10-21T08:25:00Z' });
  assert.equal(l.stage, 'declining', 'negative velocity');
  const long = []; for (let d = 1; d <= 22; d++) long.push(row(`2026-09-${String(d).padStart(2, '0')}`, 1));
  long.push(row('2026-10-21', 1));
  l = S.lifecycle(long, { now: NOW, latestBoardAt: '2026-10-21T08:25:00Z' });
  assert.equal(l.stage, 'evergreen'); assert.equal(l.daysOnBoard, 51);
});

test('timing: end of life = first seen + class median stay, post-by = end of life − lead time; the lead time is flagged as assumed until measured', () => {
  const life = S.lifecycle([row('2026-10-19', 1), row('2026-10-21', 3)], { now: NOW });
  let t = S.timing(life, { now: NOW });
  assert.equal(t.stayDays, 6.5); assert.equal(t.leadDays, 5); assert.equal(t.leadAssumed, true);
  assert.equal(t.endOfLife, new Date(new Date('2026-10-19T08:25:00.000Z').getTime() + 6.5 * 864e5).toISOString());
  assert.equal(t.postBy, new Date(new Date(t.endOfLife).getTime() - 5 * 864e5).toISOString()); assert.equal(t.postByPassed, true, 'a 6.5-day stay minus a 5-day lead leaves 1.5 days: late by day two'); assert.equal(t.remainingDays, 4); assert.equal(t.basis, 'seed median');
  t = S.timing(life, { now: NOW, leadDays: 2.5, stayDays: { ongoing: 12 } });
  assert.equal(t.leadAssumed, false); assert.equal(t.stayFromHistory, true); assert.equal(t.stayDays, 12);
  const flash = S.lifecycle([row('2026-10-10', 5, { durability: 'flash' }), row('2026-10-12', 6, { durability: 'flash' })], { now: NOW, latestBoardAt: '2026-10-21T08:25:00Z' });
  t = S.timing(flash, { now: NOW });
  assert.equal(t.basis, 'left the board'); assert.equal(t.postByPassed, true); assert.ok(t.remainingDays < 0, 'a flash trend that left the board is past its end of life → V-EXPIRED');
  // still on today's board after 12 days: alive, so the stay is the conditional median of the history that outlasted it
  const old = []; for (let d = 10; d <= 21; d++) old.push(row(`2026-10-${d}`, 1));
  const oldLife = S.lifecycle(old, { now: NOW, latestBoardAt: '2026-10-21T08:25:00Z' });
  t = S.timing(oldLife, { now: NOW, staySamples: { ongoing: [3, 4, 5, 6, 7, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24] } });
  assert.equal(t.stayDays, 19, 'median of the stays beyond 12 days'); assert.match(t.basis, /conditional median given 12 d/); assert.ok(t.remainingDays > 0);
  t = S.timing(oldLife, { now: NOW, staySamples: { ongoing: [3, 4, 5] } });
  assert.equal(t.stayDays, 13, 'no history beyond its age → at least one more day'); assert.ok(t.remainingDays >= 1); assert.match(t.basis, /beyond the class median/);
  assert.equal(S.conditionalStay([1, 2, 3, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29], 5), 25, 'median of the 10 stays beyond 5'); assert.equal(S.conditionalStay([1, 2, 3, 20, 21, 22, 23, 24, 25, 26, 27, 28], 5), null, 'fewer than 10 beyond → no conditional estimate'); assert.equal(S.conditionalStay([1, 2, 30], 5), null);
});

test('momentum score follows stage and runway; calendar score detects Gulf windows; the final score is weighted in code and normalised over the criteria that have a value', () => {
  assert.equal(S.momentumScore({ stage: 'rising' }, { remainingDays: 12, leadDays: 5 }), 9.5);
  assert.equal(S.momentumScore({ stage: 'rising' }, { remainingDays: 6, leadDays: 5 }), 8);
  assert.equal(S.momentumScore({ stage: 'peaking' }, { remainingDays: 2, leadDays: 5 }), 4);
  assert.equal(S.momentumScore({ stage: 'declining' }, { remainingDays: 9, leadDays: 5 }), 1.5);
  assert.equal(S.momentumScore({ stage: 'unknown' }, { remainingDays: 9, leadDays: 5 }), 5);
  assert.equal(S.momentumScore({ stage: 'rising' }, { remainingDays: 3, leadDays: 5, postByPassed: true }), 2, 'late');
  assert.deepEqual(S.calendarScore('2026-11-27T00:00:00Z').events, ['white-friday', 'uae-national-day'], 'Nov 27 sits in both windows');
  assert.equal(S.calendarScore('2026-11-27T00:00:00Z').score, 9);
  assert.equal(S.calendarScore('2026-10-21T00:00:00Z').score, 5);
  assert.deepEqual(S.calendarScore('2027-09-20T00:00:00Z').events, ['ksa-national-day'], 'yearly events roll forward');
  const full = { momentum: 10, gulf: 10, product: 10, brand: 10, audience: 10, feasibility: 10, platform: 10, saturation: 10, calendar: 10 };
  const f = S.finalScore(full);
  assert.equal(f.score, 100, 'normalised to 100 over the active weights (historical inactive)'); assert.equal(f.parts.historical.weight, 0); assert.equal(f.activeWeight, 95);
  const half = S.finalScore({ momentum: 5, feasibility: 5, calendar: 5 });
  assert.equal(half.score, 50, 'missing criteria are normalised away, not counted as zero'); assert.equal(half.parts.gulf.note, 'missing');
  const mixed = S.finalScore({ momentum: 10, feasibility: 0, calendar: 5 });
  assert.equal(mixed.score, +(((20 * 1 + 15 * 0 + 5 * 0.5) / 40) * 100).toFixed(1));
});

test('deterministic vetoes: uncleared sound vetoes, unknown clearance needs review, expired post-by vetoes, infeasible class vetoes, missing id is a data veto', () => {
  const trend = { trendId: 'x', name: 'N', sound: { title: 'S', cleared: false, clearedCheckedAt: '2026-10-20T00:00:00Z' } };
  let v = S.deterministicVetoes({ trend, snapshotRow: { sound_cleared: false }, timingOut: { postByPassed: false }, feasibilityClass: 'scene / mood' });
  assert.deepEqual(v.map((x) => [x.code, x.needsReview]), [['V-AUDIO', false]]);
  v = S.deterministicVetoes({ trend: { ...trend, sound: { title: 'S', cleared: false, clearedCheckedAt: null } }, snapshotRow: { sound_cleared: null }, timingOut: { postByPassed: true, remainingDays: -3, endOfLife: '2026-10-18T00:00:00Z', stayDays: 3, postBy: '2026-10-10T00:00:00Z', leadDays: 5, leadAssumed: true }, feasibilityClass: 'infeasible' });
  assert.deepEqual(v.map((x) => [x.code, x.needsReview]), [['V-AUDIO', true], ['V-EXPIRED', false], ['V-UNPRODUCIBLE', false]]);
  assert.match(v[1].reason, /assumed/);
  assert.equal(S.deterministicVetoes({ trend: { name: '' }, snapshotRow: null, timingOut: null, feasibilityClass: null })[0].code, 'V-DATA');
  assert.equal(S.feasibilityScore('product-led visual'), 9.5); assert.equal(S.feasibilityScore('nope'), null);
});
