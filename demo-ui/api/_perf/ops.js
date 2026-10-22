// Phase 10 — generation-side efficiency (BASELINES.md): latency and success per generation kind, F1X8 latency,
// turnaround per stage (first version → approval) and cost per approved piece, all computed in code from rows the
// store already keeps (generation_records, stages, artifact_versions, approvals). Nothing here renders or calls a
// provider. Percentiles are nearest rank and shown only at n ≥ MIN_N; counts below.
const MIN_N = 5;
const rank = (sorted, q) => sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)];
const pct = (xs) => { const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b); return s.length >= MIN_N ? { n: s.length, p50: rank(s, 0.5), p90: rank(s, 0.9) } : { n: s.length }; };
const r2 = (x) => Math.round(x * 100) / 100;

function ops({ records, stages, versions, approvals, days }) {
  const byKind = {};
  for (const r of records) {
    const k = byKind[r.kind] = byKind[r.kind] || { total: 0, succeeded: 0, failed: 0, refused: 0, timed_out: 0, lat: [], cost: 0 };
    k.total++; k[r.status] = (k[r.status] || 0) + 1;
    if (r.latency_ms != null) k.lat.push(Number(r.latency_ms) / 1000);
    if (r.cost_usd != null) k.cost += Number(r.cost_usd);
  }
  const kinds = Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { total: v.total, succeeded: v.succeeded, failed: v.failed, refused: v.refused, timedOut: v.timed_out, successRate: v.total ? r2(v.succeeded / v.total) : null, latencyS: pct(v.lat), costUsd: r2(v.cost) }]));

  // turnaround per stage: first version created → the approval of the version that was approved
  const vBy = new Map(); for (const v of versions) (vBy.get(v.stage_id) || vBy.set(v.stage_id, []).get(v.stage_id)).push(v);
  const aBy = new Map(); for (const a of approvals) if (a.decision === 'approved') { const cur = aBy.get(a.artifact_version_id); if (!cur || String(a.decided_at) < String(cur.decided_at)) aBy.set(a.artifact_version_id, a); }
  const turn = {};
  for (const s of stages) {
    const vs = (vBy.get(s.id) || []).slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    if (!vs.length) continue;
    const appr = vs.map((v) => aBy.get(v.id)).filter(Boolean).sort((a, b) => String(a.decided_at).localeCompare(String(b.decided_at)))[0];
    if (!appr) continue;
    const h = (Date.parse(appr.decided_at) - Date.parse(vs[0].created_at)) / 36e5;
    if (Number.isFinite(h) && h >= 0) (turn[s.kind] = turn[s.kind] || []).push(h);
  }
  const turnaroundH = Object.fromEntries(Object.entries(turn).map(([k, xs]) => [k, ((p) => (p.p50 != null ? { ...p, p50: r2(p.p50), p90: r2(p.p90) } : p))(pct(xs))]));

  // cost per approved piece: everything recorded against pieces whose final is approved, divided by their count
  const approvedPieces = new Set(stages.filter((s) => s.kind === 'final' && s.state === 'approved').map((s) => s.piece_id));
  let costApproved = 0, costAll = 0;
  for (const r of records) { if (r.cost_usd == null || !r.piece_id) continue; costAll += Number(r.cost_usd); if (approvedPieces.has(r.piece_id)) costApproved += Number(r.cost_usd); }
  const piecesWithCost = new Set(records.filter((r) => r.piece_id && r.cost_usd != null).map((r) => r.piece_id)).size;
  return {
    days, minN: MIN_N, kinds,
    f1x8LatencyS: kinds.f1x8 ? kinds.f1x8.latencyS : { n: 0 },
    turnaroundH,
    cost: { approvedPieces: approvedPieces.size, perApprovedPieceUsd: approvedPieces.size ? r2(costApproved / approvedPieces.size) : null, approvedPiecesUsd: r2(costApproved), allPiecesUsd: r2(costAll), piecesWithCost, note: 'cost_usd is the provider estimate recorded on each succeeded render; Claude and F1X8 calls are not priced here' },
  };
}

async function load(queryRows, days) {
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const records = [];
  for (let off = 0; off < 50000; off += 1000) {
    const page = await queryRows('generation_records', `select=kind,status,latency_ms,cost_usd,piece_id,stage,at&at=gte.${since}&order=id.asc&limit=1000&offset=${off}`);
    records.push(...page); if (page.length < 1000) break;
  }
  const { queryAll } = require('../_supabase.js');
  const stages = await queryAll('stages', 'select=id,piece_id,kind,state&order=id.asc');
  const versions = await queryAll('artifact_versions', `select=id,stage_id,created_at&created_at=gte.${since}&order=id.asc`);
  const vids = versions.map((v) => v.id);
  const approvals = [];
  for (let i = 0; i < vids.length; i += 200) approvals.push(...(await queryRows('approvals', `select=artifact_version_id,decision,decided_at&artifact_version_id=in.(${vids.slice(i, i + 200).map(encodeURIComponent).join(',')})&limit=1000`)));
  return { records, stages, versions, approvals };
}

module.exports = { ops, load, MIN_N };
