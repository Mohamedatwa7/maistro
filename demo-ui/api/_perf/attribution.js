// Phase 7.5 — attribution records and analysis (PERFORMANCE_INSIGHTS.md §5). For each post linked to a content
// piece (piece_posts, migration 018): what the piece was made from and how — trend and its score at decision time,
// angle, product, creation path, F1X8 at QC and final, revision rounds and stage history — joined with how the post
// performed (its 7.2 standing in its own cell). The analysis compares standings by attribute with n shown and
// gives no attribute a weight until MIN_ATTRIBUTED posts exist. Every number is computed here, in code.
const MIN_ATTRIBUTED = 30, MIN_N = 20;
const STAGES = ['plan', 'mood', 'thumb', 'brief', 'board', 'draft', 'qc', 'final'];
const PATH = { studio: 'Studio', hermes_dispatch: 'Hermes', external_hermes: 'Hermes (external)' };
const num = (v) => (v == null || v === '' ? null : Number(v));

/** Pure: build one record per active link from rows already read. */
function records({ links, pieces, stages, versions, approvals, qc, decisions, scores, posts = {}, bench = null }) {
  const pieceBy = new Map(pieces.map((p) => [p.id, p]));
  const stagesBy = new Map(); for (const s of stages) (stagesBy.get(s.piece_id) || stagesBy.set(s.piece_id, []).get(s.piece_id)).push(s);
  const versionsBy = new Map(); for (const v of versions) (versionsBy.get(v.stage_id) || versionsBy.set(v.stage_id, []).get(v.stage_id)).push(v);
  const approvalsBy = new Map(); for (const a of approvals) (approvalsBy.get(a.artifact_version_id) || approvalsBy.set(a.artifact_version_id, []).get(a.artifact_version_id)).push(a);
  const qcBy = new Map(); for (const r of qc) { const cur = qcBy.get(r.artifact_version_id); if (!cur || String(r.created_at) > String(cur.created_at)) qcBy.set(r.artifact_version_id, r); }
  const scoreBy = new Map(scores.map((s) => [String(s.id), s]));
  return links.map((l) => {
    const p = pieceBy.get(l.piece_id) || {};
    const st = stagesBy.get(l.piece_id) || [];
    const stage = (k) => st.find((s) => s.kind === k) || null;
    const vs = (k) => { const s = stage(k); return s ? (versionsBy.get(s.id) || []).slice().sort((a, b) => a.version - b.version) : []; };
    // trend score at decision time: the pick decision's score row; else the newest score of that trend made before the piece
    const pick = decisions.filter((d) => d.trend_id === p.trend_id && d.decision === 'pick' && d.score_id != null && String(d.at) <= String(p.created_at || '9')).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    let sc = pick ? scoreBy.get(String(pick.score_id)) : null, basis = sc ? 'pick decision' : null;
    if (!sc) { sc = scores.filter((s) => s.trend_id === p.trend_id && String(s.at) <= String(p.created_at || '9')).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null; if (sc) basis = 'latest score before the piece'; }
    const qcStage = stage('qc'), finStage = stage('final');
    const qcRow = qcStage && qcStage.current_version_id ? qcBy.get(qcStage.current_version_id) : null;
    const finV = finStage ? vs('final').find((v) => v.id === finStage.current_version_id) : null;
    const finVer = finV && finV.payload && finV.payload.verification;
    const rounds = Object.fromEntries(STAGES.map((k) => [k, Math.max(0, vs(k).length - 1)]).filter(([k]) => stage(k)));
    const history = STAGES.flatMap((k) => vs(k).flatMap((v) => (approvalsBy.get(v.id) || []).map((a) => ({ stage: k, version: v.version, decision: a.decision, reasonCode: a.reason_code || null, by: a.name_as_signed, role: a.role_as_signed, at: a.decided_at }))))
      .sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const tp = posts[`${l.platform}|${l.post_id}`] || null;
    const be = bench && bench.posts ? bench.posts[String(l.post_id)] || null : null;
    return {
      link: { id: l.id, platform: l.platform, postId: l.post_id, url: l.url, account: l.account, linkedBy: l.linked_by_label, linkedAt: l.linked_at, source: l.source },
      piece: { legacyId: p.legacy_id || null, title: p.title || null, product: p.product || null, markets: p.markets || [], platforms: p.platforms || [], angle: p.angle || null, path: PATH[p.origin] || p.origin || null },
      trend: { id: p.trend_id || null, name: p.trend_name || null, score: sc ? num(sc.final_score) : null, confidence: sc ? sc.confidence || null : null, status: sc ? sc.status : null, scoredAt: sc ? sc.at : null, basis },
      f1x8: { qc: qcRow ? num(qcRow.score) : null, final: finVer && finVer.score != null ? num(finVer.score) : null, finalBefore: finVer && finVer.scoreBefore != null ? num(finVer.scoreBefore) : null },
      revisionRounds: rounds, totalRounds: Object.values(rounds).reduce((a, b) => a + b, 0),
      stageHistory: history,
      performance: tp ? { postedAt: tp.postedAt, metrics: tp.metrics, mediaType: tp.mediaType || null } : null,
      standing: be ? { band: be.band, format: be.format, giveaway: be.giveaway || null, ...(be.standing ? { metric: be.standing.metric, percentile: be.standing.percentile, of: be.standing.of, note: be.standing.note } : {}), ...(be.young ? { young: be.young } : {}) } : null,
    };
  });
}

/** Pure: compare standings by attribute. Percentiles from mature organic standings only; n ≥ MIN_N per group for a
 *  median, counts below; no attribute weight until MIN_ATTRIBUTED records exist. */
function analysis(recs) {
  const ranked = recs.filter((r) => r.standing && r.standing.percentile != null && r.standing.band === 'mature' && !r.standing.giveaway);
  const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s[Math.max(0, Math.ceil(s.length / 2) - 1)]; };
  const bucketRounds = (n) => (n === 0 ? '0' : n <= 2 ? '1–2' : '3+');
  const ATTRS = {
    path: (r) => r.piece.path, product: (r) => r.piece.product, format: (r) => (r.standing ? `${r.link.platform} ${r.standing.format}` : null),
    trendConfidence: (r) => r.trend.confidence, revisionRounds: (r) => bucketRounds(r.totalRounds), angle: (r) => r.piece.angle,
  };
  const out = {};
  for (const [attr, f] of Object.entries(ATTRS)) {
    const groups = {};
    for (const r of recs) { const k = f(r); if (k == null) continue; const g = groups[k] = groups[k] || { attributed: 0, ranked: [] }; g.attributed++; }
    for (const r of ranked) { const k = f(r); if (k == null) continue; groups[k].ranked.push(r.standing.percentile); }
    out[attr] = Object.entries(groups).map(([value, g]) => ({ value, attributed: g.attributed, ranked: g.ranked.length, ...(g.ranked.length >= MIN_N ? { medianPercentile: median(g.ranked) } : {}) })).sort((a, b) => b.attributed - a.attributed);
  }
  return { attributed: recs.length, ranked: ranked.length, minAttributed: MIN_ATTRIBUTED, minN: MIN_N, weightsWithheld: recs.length < MIN_ATTRIBUTED, byAttribute: out };
}

/** IO: read every table the records need. queryRows is the Maistro store reader. */
async function load(queryRows) {
  const inList = (xs) => xs.map((x) => encodeURIComponent(String(x))).join(',');
  const links = await queryRows('piece_posts', 'select=*&unlinked_at=is.null&order=linked_at.desc&limit=1000');
  if (!links.length) return { links, pieces: [], stages: [], versions: [], approvals: [], qc: [], decisions: [], scores: [] };
  const pids = [...new Set(links.map((l) => l.piece_id))];
  const pieces = await queryRows('content_pieces', `select=id,legacy_id,title,product,markets,platforms,angle,trend_id,trend_name,origin,created_at&id=in.(${inList(pids)})&limit=1000`);
  const stages = await queryRows('stages', `select=id,piece_id,kind,state,current_version_id&piece_id=in.(${inList(pids)})&limit=5000`);
  const sids = stages.map((s) => s.id);
  const versions = sids.length ? await queryRows('artifact_versions', `select=id,stage_id,version,payload,created_at&stage_id=in.(${inList(sids)})&limit=5000`) : [];
  const vids = versions.map((v) => v.id);
  const approvals = vids.length ? await queryRows('approvals', `select=artifact_version_id,decision,reason_code,name_as_signed,role_as_signed,decided_at&artifact_version_id=in.(${inList(vids)})&limit=5000`) : [];
  const qc = vids.length ? await queryRows('qc_results', `select=artifact_version_id,score,created_at&artifact_version_id=in.(${inList(vids)})&limit=5000`) : [];
  const tids = [...new Set(pieces.map((p) => p.trend_id).filter(Boolean))];
  const decisions = tids.length ? await queryRows('trend_decisions', `select=trend_id,score_id,decision,at&trend_id=in.(${inList(tids)})&limit=5000`) : [];
  const scores = tids.length ? await queryRows('trend_scores', `select=id,trend_id,at,status,final_score,confidence&trend_id=in.(${inList(tids)})&order=at.desc&limit=5000`) : [];
  return { links, pieces, stages, versions, approvals, qc, decisions, scores };
}

module.exports = { records, analysis, load, MIN_ATTRIBUTED, MIN_N };
