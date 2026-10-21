// The scoring engine (TREND_FRAMEWORK.md §1–§3, §6): for every trend on a
// fetched board, deterministic signals from trend_snapshots → vetoes →
// judgement (cached per trend × board × prompt version) → final score, all
// stored in trend_scores so rankings are reproducible. Called by the hourly
// refresh after the snapshots are written. Never triggers collection.
const { queryRows, insertRows } = require('../_supabase.js');
const S = require('./signals.js');
const { judgeTrend } = require('./judge.js');
const { PRODUCT_CATALOG } = require('../_brand.js');
const promptV = require('./prompts/profile-v1.js');

const q = (v) => encodeURIComponent(String(v));
const DAY = 864e5;

/** Median pick → final-approval time over Maistro's own pieces; null until ≥ 5. */
async function measuredLeadDays() {
  try {
    const finals = await queryRows('stages', `select=piece_id,id&kind=eq.final&state=eq.approved&limit=500`);
    if (finals.length < 5) return { leadDays: null, sample: finals.length };
    const pieces = await queryRows('content_pieces', `select=id,created_at&id=in.(${finals.map((f) => q(f.piece_id)).join(',')})`);
    const versions = await queryRows('artifact_versions', `select=id,stage_id&stage_id=in.(${finals.map((f) => q(f.id)).join(',')})`);
    const approvals = await queryRows('approvals', `select=artifact_version_id,decided_at&decision=eq.approved&artifact_version_id=in.(${versions.map((v) => q(v.id)).join(',')})`);
    const created = new Map(pieces.map((p) => [p.id, p.created_at]));
    const stageOfVersion = new Map(versions.map((v) => [v.id, v.stage_id]));
    const pieceOfStage = new Map(finals.map((f) => [f.id, f.piece_id]));
    const days = [];
    for (const a of approvals) {
      const pid = pieceOfStage.get(stageOfVersion.get(a.artifact_version_id));
      if (pid && created.get(pid)) days.push((new Date(a.decided_at) - new Date(created.get(pid))) / DAY);
    }
    if (days.length < 5) return { leadDays: null, sample: days.length };
    days.sort((a, b) => a - b);
    return { leadDays: +days[Math.floor(days.length / 2)].toFixed(1), sample: days.length };
  } catch (e) { return { leadDays: null, sample: 0, error: e.message }; }
}

/** Median days on board per durability class from Maistro's own snapshots (≥ 20 trends per class). */
async function measuredStayDays(now) {
  try {
    const since = new Date(now.getTime() - 60 * DAY).toISOString();
    const rows = await queryRows('trend_snapshots', `select=trend_id,board_generated_at,fetched_at,durability&fetched_at=gte.${since}&order=fetched_at.asc&limit=20000`);
    const per = new Map();
    for (const r of rows) { const k = r.trend_id; const d = (r.board_generated_at || r.fetched_at).slice(0, 10); const e = per.get(k) || { first: d, last: d, dur: r.durability }; e.first = e.first < d ? e.first : d; e.last = e.last > d ? e.last : d; e.dur = r.durability || e.dur; per.set(k, e); }
    const byClass = {};
    for (const e of per.values()) { const days = Math.round((new Date(e.last) - new Date(e.first)) / DAY) + 1; (byClass[e.dur || 'ongoing'] = byClass[e.dur || 'ongoing'] || []).push(days); }
    const out = {};
    for (const [k, arr] of Object.entries(byClass)) if (arr.length >= 20) { arr.sort((a, b) => a - b); out[k] = arr[Math.floor(arr.length / 2)]; }
    return out;
  } catch (e) { return {}; }
}

async function snapshotsFor(trendIds, now) {
  const since = new Date(now.getTime() - 90 * DAY).toISOString();
  const out = new Map();
  for (let i = 0; i < trendIds.length; i += 40) {
    const chunk = trendIds.slice(i, i + 40);
    const rows = await queryRows('trend_snapshots', `select=trend_id,fetched_at,board_generated_at,stage,growth_pct_per_day,durability,sound_cleared&trend_id=in.(${chunk.map(q).join(',')})&fetched_at=gte.${since}&order=fetched_at.desc&limit=5000`);
    for (const r of rows) (out.get(r.trend_id) || out.set(r.trend_id, []).get(r.trend_id)).push(r);
  }
  return out;
}

async function cachedJudgements(trendIds, boardGeneratedAt) {
  if (!boardGeneratedAt) return new Map();
  const out = new Map();
  for (let i = 0; i < trendIds.length; i += 40) {
    const chunk = trendIds.slice(i, i + 40);
    const rows = await queryRows('trend_scores', `select=trend_id,judgement,prompt_version,model&board_generated_at=eq.${q(boardGeneratedAt)}&prompt_version=eq.${q(promptV.VERSION)}&trend_id=in.(${chunk.map(q).join(',')})&judgement=not.is.null&order=at.desc&limit=500`);
    for (const r of rows) if (!out.has(r.trend_id)) out.set(r.trend_id, r);
  }
  return out;
}

/** Score one trend given its snapshots and (optionally) a judgement. Pure apart from the judge call. */
function scoreOne({ trend, snaps, judgement, leadDays, stayDays, now, latestBoardAt, historicalActive }) {
  const life = S.lifecycle(snaps, { now, latestBoardAt });
  const t = S.timing(life, { now, leadDays, stayDays });
  const latestSnap = S.boards(snaps)[0] || null;
  const feasibilityClass = judgement ? judgement.feasibilityClass : null;
  const vetoes = S.deterministicVetoes({ trend, snapshotRow: latestSnap, timingOut: t, feasibilityClass });
  if (judgement) {
    for (const [k, code] of [['safety', 'V-SAFETY'], ['culture', 'V-CULTURE'], ['origin', 'V-ORIGIN'], ['audioExplicit', 'V-AUDIO']]) {
      const v = judgement[k];
      if (v && v.verdict === 'veto') vetoes.push({ code, reason: v.rationale, evidence: v.evidence, needsReview: false });
      else if (v && v.verdict === 'needsReview') vetoes.push({ code, reason: v.rationale, evidence: v.evidence, needsReview: true });
    }
  }
  const cal = S.calendarScore(t.postBy);
  const criteria = {
    momentum: S.momentumScore(life, t),
    calendar: cal.score,
    feasibility: feasibilityClass ? S.feasibilityScore(feasibilityClass) : null,
    gulf: judgement ? judgement.criteria.gulf.score : null,
    product: judgement ? judgement.criteria.product.score : null,
    brand: judgement ? judgement.criteria.brand.score : null,
    audience: judgement ? judgement.criteria.audience.score : null,
    platform: judgement ? judgement.criteria.platform.score : null,
    saturation: judgement ? judgement.criteria.saturation.score : null,
  };
  const hardVeto = vetoes.some((v) => !v.needsReview);
  const needsReview = !hardVeto && vetoes.some((v) => v.needsReview);
  const fin = S.finalScore(criteria, { historicalActive });
  return {
    status: hardVeto ? 'vetoed' : needsReview ? 'needs_review' : judgement ? 'scored' : 'unjudged',
    lifecycle: life, timing: t, calendar: cal, vetoes, criteria, final: fin,
    productMapping: judgement ? { product: judgement.criteria.product.product, feature: judgement.criteria.product.feature, catalogMatch: judgement.criteria.product.catalogMatch !== false } : null,
    confidence: judgement ? judgement.profile.confidence : 'low',
  };
}

/** Score a whole board. `judge` can be injected (tests); `maxJudgements` bounds spend per run. */
async function scoreBoard(board, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const trends = (board.raw || []).filter((t) => t && t.name && (t.trendId || t.id));
  const ids = trends.map((t) => String(t.trendId || t.id));
  const [lead, stayDays, snaps, cached] = await Promise.all([measuredLeadDays(), measuredStayDays(now), snapshotsFor(ids, now), cachedJudgements(ids, board.boardGeneratedAt)]);
  const judge = opts.judge || judgeTrend;
  const maxJ = opts.maxJudgements != null ? opts.maxJudgements : 60;
  const results = []; let judged = 0, reused = 0, failed = 0, usage = { input: 0, output: 0 };
  const rows = [];
  for (const trend of trends) {
    const id = String(trend.trendId || trend.id);
    const s = snaps.get(id) || [];
    let judgement = null, promptVersion = promptV.VERSION, model = null, judgeError = null, capNotes = [];
    const hit = cached.get(id);
    if (hit) { judgement = hit.judgement; model = hit.model; promptVersion = hit.prompt_version; reused++; }
    else if (judged < maxJ && (process.env.ANTHROPIC_API_KEY !== undefined || opts.judge)) {
      const pre = scoreOne({ trend, snaps: s, judgement: null, leadDays: lead.leadDays, stayDays, now, latestBoardAt: board.boardGeneratedAt });
      const computed = { lifecycle: pre.lifecycle, timing: pre.timing, calendarEvents: pre.calendar.events, snapshotsSeen: s.length };
      try {
        const r = await judge({ trend, computed, catalog: PRODUCT_CATALOG, calendarNote: pre.calendar.note });
        if (r && r.judgement) { judgement = r.judgement; model = r.model; promptVersion = r.promptVersion; capNotes = r.capNotes || []; judged++; if (r.usage) { usage.input += r.usage.input_tokens || 0; usage.output += r.usage.output_tokens || 0; } }
        else { judgeError = r ? `${r.error}: ${(r.problems || []).slice(0, 3).join('; ')}` : 'no answer'; failed++; }
      } catch (e) { judgeError = e.message; failed++; }
    }
    const scored = scoreOne({ trend, snaps: s, judgement, leadDays: lead.leadDays, stayDays, now, latestBoardAt: board.boardGeneratedAt, historicalActive: false });
    const row = {
      trend_id: id, name: trend.name, board_generated_at: board.boardGeneratedAt || null, prompt_version: promptVersion, model, weights_version: scored.final.weightsVersion,
      status: scored.status, final_score: scored.status === 'scored' ? scored.final.score : null, lifecycle: scored.lifecycle.stage, post_by: scored.timing.postBy || null,
      vetoes: scored.vetoes, criteria: scored.final.parts, judgement, inputs: { snapshots: s.length, leadDays: lead, stayDays, timing: scored.timing, calendar: scored.calendar, capNotes, judgeError },
      product: scored.productMapping ? scored.productMapping.product : null, confidence: scored.confidence, at: now.toISOString(),
    };
    rows.push(row);
    results.push({ ...scored, trendId: id, name: trend.name, judgement, judgeError });
  }
  let stored = 0;
  if (rows.length && opts.store !== false) { try { await insertRows('trend_scores', rows); stored = rows.length; } catch (e) { console.warn('[trends] trend_scores write failed:', e.message); } }
  results.sort((a, b) => (b.status === 'scored' ? b.final.score : -1) - (a.status === 'scored' ? a.final.score : -1));
  return { results, summary: { trends: trends.length, judged, reused, failed, stored, lead, stayDays, usage, promptVersion: promptV.VERSION, at: now.toISOString() } };
}

/** The latest scored run as the page wants it: ranked + rejected + needs review. */
async function latestScores() {
  const last = await queryRows('trend_scores', 'select=board_generated_at,at&order=at.desc&limit=1');
  if (!last.length) return { at: null, ranked: [], rejected: [], needsReview: [] };
  const at = last[0].at;
  const rows = await queryRows('trend_scores', `select=*&at=eq.${q(at)}&order=final_score.desc.nullslast&limit=300`);
  const view = (r) => ({ scoreId: r.id, trendId: r.trend_id, name: r.name, status: r.status, score: r.final_score, lifecycle: r.lifecycle, postBy: r.post_by, product: r.product, confidence: r.confidence, vetoes: r.vetoes, criteria: r.criteria, timing: r.inputs && r.inputs.timing, profile: r.judgement && r.judgement.profile, productMapping: r.judgement && r.judgement.criteria && r.judgement.criteria.product, promptVersion: r.prompt_version, model: r.model, weightsVersion: r.weights_version });
  return { at, boardGeneratedAt: last[0].board_generated_at, ranked: rows.filter((r) => r.status === 'scored').map(view), rejected: rows.filter((r) => r.status === 'vetoed').map(view), needsReview: rows.filter((r) => r.status === 'needs_review' || r.status === 'unjudged').map(view) };
}

module.exports = { scoreBoard, scoreOne, latestScores, measuredLeadDays, measuredStayDays };
