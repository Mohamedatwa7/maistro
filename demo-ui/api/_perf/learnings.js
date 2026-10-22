// Phase 7.6 — closing the loop (PERFORMANCE_INSIGHTS.md §6). Turns the 7.5 attribution analysis into proposals
// for trend calibration (5.7), content generation (6.10) and the boost recommendation (8a). Nothing changes
// automatically: proposals are computed on read and each consumer shows them to a person. No proposal is made
// until MIN_ATTRIBUTED posts are attributed, and then only for a group with n ≥ MIN_N ranked posts whose median
// percentile differs from the rest by at least GAP points (a stated, fixed threshold — not a significance claim).
const MIN_ATTRIBUTED = 30, MIN_N = 20, GAP = 15, HALF_N = 5;
// which attribute informs which loop
const TARGETS = {
  trendConfidence: 'trend_calibration', // does the judge's confidence track performance?
  path: 'content', angle: 'content', revisionRounds: 'content', product: 'content',
  format: 'boost', // which platform·format cells outperform their peers
};
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.max(0, Math.ceil(s.length / 2) - 1)] : null; };

/** recs: attribution records (api/_perf/attribution.js records()). */
function learnings(recs, { attrs } = {}) {
  const ranked = recs.filter((r) => r.standing && r.standing.percentile != null && r.standing.band === 'mature' && !r.standing.giveaway);
  if (recs.length < MIN_ATTRIBUTED) return { withheld: true, attributed: recs.length, needed: MIN_ATTRIBUTED, proposals: [] };
  const keyFns = attrs || {
    trendConfidence: (r) => r.trend.confidence, path: (r) => r.piece.path, angle: (r) => r.piece.angle, product: (r) => r.piece.product,
    revisionRounds: (r) => (r.totalRounds === 0 ? '0' : r.totalRounds <= 2 ? '1–2' : '3+'), format: (r) => (r.standing ? `${r.link.platform} ${r.standing.format}` : null),
  };
  // with several attributes and values, some group clears the gap by chance: every proposal is a hypothesis, says
  // how many groups were compared, and must hold in BOTH halves of the window (split at the median post date) —
  // same direction, at least GAP points, each half with ≥ HALF_N in the group and in the rest
  const dateOf = (r) => String((r.performance && r.performance.postedAt) || r.link.linkedAt || '');
  const dates = ranked.map(dateOf).sort();
  const cut = dates[Math.floor(dates.length / 2)];
  const halves = [ranked.filter((r) => dateOf(r) < cut), ranked.filter((r) => dateOf(r) >= cut)];
  const halfGap = (rs, f, value) => {
    const a = rs.filter((r) => f(r) === value).map((r) => r.standing.percentile), b = rs.filter((r) => f(r) != null && f(r) !== value).map((r) => r.standing.percentile);
    return a.length >= HALF_N && b.length >= HALF_N ? median(a) - median(b) : null;
  };
  const proposals = [];
  let compared = 0;
  for (const [attr, f] of Object.entries(keyFns)) {
    const groups = new Map();
    for (const r of ranked) { const k = f(r); if (k == null) continue; (groups.get(k) || groups.set(k, []).get(k)).push(r.standing.percentile); }
    for (const [value, xs] of groups) {
      const rest = ranked.filter((r) => f(r) != null && f(r) !== value).map((r) => r.standing.percentile);
      if (xs.length < MIN_N || rest.length < MIN_N) continue;
      compared++;
      const m = median(xs), mr = median(rest), gap = m - mr;
      if (Math.abs(gap) < GAP) continue;
      const hg = halves.map((h) => halfGap(h, f, value));
      if (!hg.every((g) => g != null && Math.sign(g) === Math.sign(gap) && Math.abs(g) >= GAP)) continue;
      proposals.push({ target: TARGETS[attr] || 'content', attribute: attr, value, n: xs.length, nRest: rest.length, medianPercentile: m, restMedianPercentile: mr, gap, halfGaps: hg,
        statement: `Hypothesis — ${attr} = ${value}: median P${m} over ${xs.length} posts vs P${mr} for the other ${rest.length} (${gap > 0 ? '+' : ''}${gap} points; ${hg.map((g) => (g > 0 ? '+' : '') + g).join(' / ')} in each half of the window) — for review, not an automatic change` });
    }
  }
  proposals.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  for (const p of proposals) p.groupsCompared = compared;
  return { withheld: false, attributed: recs.length, needed: MIN_ATTRIBUTED, minN: MIN_N, gap: GAP, groupsCompared: compared, proposals };
}

module.exports = { learnings, MIN_ATTRIBUTED, MIN_N, GAP, TARGETS };
