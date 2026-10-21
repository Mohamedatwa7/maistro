// Deterministic trend signals (TREND_FRAMEWORK.md §3, §2.1, §2.6, §2.9).
// Pure functions over trend_snapshots rows and the framework tables: no I/O,
// no model. Numbers come from here; the LLM never does arithmetic.

const DAY = 864e5;

// ---- framework tables (owner-editable; TREND_FRAMEWORK.md §4) ----
const CALENDAR = [
  { id: 'ramadan-2027', label: 'Ramadan 2027 (estimate — confirm by moon sighting)', from: '2027-02-07', to: '2027-03-08', estimate: true, ramadan: true },
  { id: 'eid-fitr-2027', label: 'Eid al-Fitr 2027 (estimate)', from: '2027-03-09', to: '2027-03-12', estimate: true },
  { id: 'eid-adha-2027', label: 'Eid al-Adha 2027 (estimate)', from: '2027-05-16', to: '2027-05-19', estimate: true },
  { id: 'ksa-national-day', label: 'Saudi National Day', from: '2026-09-23', to: '2026-09-23', yearly: true },
  { id: 'oman-national-day', label: 'Oman National Day', from: '2026-11-18', to: '2026-11-18', yearly: true },
  { id: 'white-friday', label: 'White Friday', from: '2026-11-23', to: '2026-11-29', yearly: true },
  { id: 'uae-national-day', label: 'UAE National Day', from: '2026-12-02', to: '2026-12-03', yearly: true },
  { id: 'bahrain-national-day', label: 'Bahrain National Day', from: '2026-12-16', to: '2026-12-16', yearly: true },
  { id: 'qatar-national-day', label: 'Qatar National Day', from: '2026-12-18', to: '2026-12-18', yearly: true },
  { id: 'kuwait-national-days', label: 'Kuwait National and Liberation Days', from: '2027-02-25', to: '2027-02-26', yearly: true },
];
const FEASIBILITY = { 'product-led visual': 9.5, 'scene / mood': 7.5, 'character-light': 5.5, performance: 1.5, infeasible: 0 };
const WEIGHTS = { momentum: 20, gulf: 12, product: 15, brand: 10, audience: 6, feasibility: 15, platform: 5, saturation: 7, calendar: 5, historical: 5 };
const WEIGHTS_VERSION = 'w1-2026-10-21';
// Seed medians (KYMAH_DATA.md §6) until Maistro's own history supplies them.
// Medians by distinct board dates over the Trend Radar git history
// (checker measurement 2026-10-21: flash n=56 median 3.0, ongoing n=76 median 6.5).
const SEED_STAY_DAYS = { flash: 3, ongoing: 6.5, seasonal: 6.5 };
const ASSUMED_LEAD_DAYS = 5;

const toDay = (iso) => new Date(iso).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / DAY);

/** Collapse a trend's snapshot rows (any order) into one point per distinct
 *  board (board_generated_at), newest first. */
function boards(rows) {
  const byBoard = new Map();
  for (const r of rows || []) {
    const k = r.board_generated_at || r.fetched_at;
    if (!byBoard.has(k) || String(r.fetched_at) > String(byBoard.get(k).fetched_at)) byBoard.set(k, r);
  }
  return [...byBoard.values()].sort((a, b) => String(b.board_generated_at || b.fetched_at).localeCompare(String(a.board_generated_at || a.fetched_at)));
}

/** Velocity, acceleration, days on board, first/last seen, lifecycle. */
function lifecycle(rows, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const latestBoardAt = opts.latestBoardAt || null;
  const pts = boards(rows);
  if (!pts.length) return { stage: 'unknown', velocity: null, acceleration: null, daysOnBoard: 0, firstSeen: null, lastSeen: null, boardsSeen: 0, onLatestBoard: false };
  const latest = pts[0], prev = pts[1] || null;
  const velocity = latest.growth_pct_per_day == null ? null : Number(latest.growth_pct_per_day);
  const acceleration = prev && prev.growth_pct_per_day != null && velocity != null ? +(velocity - Number(prev.growth_pct_per_day)).toFixed(3) : null;
  const firstSeen = pts[pts.length - 1].board_generated_at || pts[pts.length - 1].fetched_at;
  const lastSeen = latest.board_generated_at || latest.fetched_at;
  const daysOnBoard = daysBetween(toDay(firstSeen), toDay(lastSeen)) + 1;
  const onLatestBoard = latestBoardAt ? toDay(lastSeen) >= toDay(latestBoardAt) : true;
  const durability = latest.durability || null;
  let stage;
  // Cold start: with a single board in history nothing can be called
  // emerging or rising; the stage is 'unknown' until two distinct boards exist
  // (the git-history backfill gives most trends that history on day one).
  if (pts.length < 2 && onLatestBoard && !(velocity != null && velocity < 0)) stage = 'unknown';
  else if (!onLatestBoard || (velocity != null && velocity < 0)) stage = 'declining';
  else if (durability === 'ongoing' && daysOnBoard >= 21) stage = 'evergreen';
  else if (daysOnBoard <= 2 && (velocity == null || velocity > 0)) stage = 'emerging';
  else if (acceleration != null && acceleration > 0 && velocity != null && velocity >= 2) stage = 'rising';
  else stage = 'peaking';
  return { stage, velocity, acceleration, daysOnBoard, firstSeen, lastSeen, boardsSeen: pts.length, onLatestBoard, durability, upstreamStage: latest.stage || null, now: now.toISOString() };
}

/** Median of the stays that outlasted `age` (conditional survival) from a
 *  sorted sample; null when fewer than `min` samples outlast it. */
function conditionalStay(samples, age, min = 10) {
  if (!Array.isArray(samples) || !samples.length) return null;
  const beyond = samples.filter((d) => d > age).sort((a, b) => a - b);
  if (beyond.length < min) return null;
  return beyond[Math.floor(beyond.length / 2)];
}

/** Remaining window and post-by date (TREND_FRAMEWORK.md §3.3–3.4).
 *  A trend still on the latest board has not ended: its expected total stay
 *  is the conditional median given the age it has already reached (from
 *  opts.staySamples[durability], Maistro's own history); without enough
 *  history, the class median or at least one more day. A trend that left the
 *  board is expired. */
function timing(life, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const cls = life.durability || 'ongoing';
  const classMedian = (opts.stayDays && opts.stayDays[cls]) || SEED_STAY_DAYS[cls] || SEED_STAY_DAYS.ongoing;
  const lead = opts.leadDays != null ? opts.leadDays : ASSUMED_LEAD_DAYS;
  const leadAssumed = opts.leadDays == null;
  const stayFromHistory = Boolean(opts.stayDays && opts.stayDays[cls]);
  if (!life.firstSeen) return { endOfLife: null, remainingDays: null, postBy: null, leadDays: lead, leadAssumed, stayDays: classMedian, stayFromHistory, basis: 'none' };
  const first = new Date(life.firstSeen).getTime();
  const age = life.daysOnBoard || 1;
  let stay = classMedian, basis = stayFromHistory ? 'class median' : 'seed median';
  let endOfLife;
  if (life.stage === 'evergreen') { endOfLife = new Date(now.getTime() + 30 * DAY); basis = 'evergreen'; }
  else if (life.onLatestBoard === false) { endOfLife = new Date(new Date(life.lastSeen).getTime()); basis = 'left the board'; }
  else {
    const cond = conditionalStay(opts.staySamples && opts.staySamples[cls], age);
    if (cond != null) { stay = cond; basis = `conditional median given ${age} d on board`; }
    else if (classMedian <= age) { stay = age + 1; basis = 'still on the board beyond the class median (+1 day)'; }
    endOfLife = new Date(first + stay * DAY);
    if (endOfLife < new Date(now.getTime() + DAY)) endOfLife = new Date(now.getTime() + DAY); // alive today → at least tomorrow
  }
  const remainingDays = Math.round((endOfLife - now) / DAY);
  const postBy = new Date(endOfLife.getTime() - lead * DAY);
  return { endOfLife: endOfLife.toISOString(), remainingDays, postBy: postBy.toISOString(), postByPassed: postBy < now, leadDays: lead, leadAssumed, stayDays: stay, stayFromHistory, basis };
}

/** Criterion 2.1 momentum & timing, 0–10 (§3.5). */
function momentumScore(life, t) {
  if (!t.remainingDays && t.remainingDays !== 0) return 5;
  const runway = t.leadDays ? t.remainingDays / t.leadDays : 0;
  if (life.stage === 'declining') return 1.5;
  if (life.stage === 'unknown') return 5;
  if (life.stage === 'evergreen') return 6;
  if (t.postByPassed) return 2; // late: life left but not enough for our lead time
  if (life.stage === 'rising' || life.stage === 'emerging') return runway >= 2 ? 9.5 : runway >= 1 ? 8 : 4;
  // peaking
  return runway >= 1 ? 6.5 : runway > 0 ? 4 : 1;
}

/** Criterion 2.9 calendar alignment, 0–10, plus the matched events. */
function calendarScore(postByIso, opts = {}) {
  if (!postByIso) return { score: 5, events: [], note: 'no post-by date' };
  const day = new Date(postByIso);
  const hits = [];
  for (const ev of opts.calendar || CALENDAR) {
    const from = new Date(ev.from), to = new Date(ev.to);
    // a window of 10 days before the event up to its end counts as aligned
    const lo = new Date(from.getTime() - 10 * DAY);
    const inWindow = (d) => d >= lo && d <= new Date(to.getTime() + DAY);
    if (inWindow(day)) hits.push(ev.id);
    else if (ev.yearly) { for (const shift of [1, 2]) { const f = new Date(from); f.setFullYear(f.getFullYear() + shift); const t2 = new Date(to); t2.setFullYear(t2.getFullYear() + shift); if (day >= new Date(f.getTime() - 10 * DAY) && day <= new Date(t2.getTime() + DAY)) hits.push(ev.id); } }
  }
  return { score: hits.length ? 9 : 5, events: hits, note: hits.length ? 'post-by date falls in a Gulf calendar window' : 'no calendar window near the post-by date' };
}

/** Final weighted score (§2), computed in code. `criteria` holds 0–10 values. */
function finalScore(criteria, opts = {}) {
  const w = opts.weights || WEIGHTS;
  const historicalActive = Boolean(opts.historicalActive);
  let total = 0, weightSum = 0;
  const parts = {};
  for (const [k, weight] of Object.entries(w)) {
    if (k === 'historical' && !historicalActive) { parts[k] = { weight: 0, score: null, note: 'inactive until ≥ 30 attributed posts' }; continue; }
    const s = criteria[k];
    if (typeof s !== 'number' || !Number.isFinite(s)) { parts[k] = { weight, score: null, note: 'missing' }; continue; }
    const clamped = Math.max(0, Math.min(10, s));
    parts[k] = { weight, score: clamped, contribution: +(weight * clamped / 10).toFixed(2) };
    total += weight * clamped / 10; weightSum += weight;
  }
  // Normalised to 100 over the criteria that have a value: a missing
  // criterion does not zero the total, and an inactive 'historical' weight
  // does not cap a perfect trend at 95 (TREND_FRAMEWORK.md §2).
  const normalised = weightSum ? +((total / weightSum) * 100).toFixed(1) : 0;
  return { score: normalised, parts, weightsVersion: opts.weightsVersion || WEIGHTS_VERSION, activeWeight: weightSum };
}

/** Deterministic vetoes (§1): audio clearance, expiry, data, feasibility. */
function deterministicVetoes({ trend, snapshotRow, timingOut, feasibilityClass }) {
  const out = [];
  if (!trend || !trend.name || !(trend.trendId || trend.id)) out.push({ code: 'V-DATA', reason: 'record has no name or id', needsReview: false });
  const cleared = snapshotRow && typeof snapshotRow.sound_cleared === 'boolean' ? snapshotRow.sound_cleared : (trend && trend.sound && typeof trend.sound.cleared === 'boolean' && trend.sound.clearedCheckedAt ? trend.sound.cleared : null);
  if (trend && trend.sound && trend.sound.title) {
    if (cleared === false) out.push({ code: 'V-AUDIO', reason: `sound "${trend.sound.title}" is flagged not cleared for commercial use by TikTok`, needsReview: false });
    else if (cleared === null) out.push({ code: 'V-AUDIO', reason: `commercial-use status of "${trend.sound.title}" is unknown — verify in the business account`, needsReview: true });
  }
  // Expired = the estimated end of life is behind us. A passed post-by date
  // with life left is "late", which the momentum score punishes (§3.5) —
  // a veto there would empty the board on day one (median stay 6.5 d vs a
  // 5-day lead time) and hide the trade-off instead of showing it.
  if (timingOut && timingOut.remainingDays != null && timingOut.remainingDays < 0) out.push({ code: 'V-EXPIRED', reason: `estimated end of life ${timingOut.endOfLife.slice(0, 10)} has passed (stay ${timingOut.stayDays} d${timingOut.stayFromHistory ? '' : ', seed'}; lead time ${timingOut.leadDays} d${timingOut.leadAssumed ? ', assumed' : ''})`, needsReview: false });
  if (feasibilityClass === 'infeasible') out.push({ code: 'V-UNPRODUCIBLE', reason: 'format depends on real people, live events or licensed footage our pipeline cannot produce', needsReview: false });
  return out;
}

const feasibilityScore = (cls) => (cls in FEASIBILITY ? FEASIBILITY[cls] : null);

module.exports = { CALENDAR, FEASIBILITY, WEIGHTS, WEIGHTS_VERSION, SEED_STAY_DAYS, ASSUMED_LEAD_DAYS, boards, lifecycle, timing, conditionalStay, momentumScore, calendarScore, finalScore, deterministicVetoes, feasibilityScore };
