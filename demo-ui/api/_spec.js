// The Creative Spec (Phase 6.1 item 5): one versioned source of truth per
// piece that every stage reads from and writes to. It is DERIVED from the
// store — the piece, its linked trend, and the current and approved
// version of every stage — and a new version is written only when the
// derived content changes. Every stage keeps consuming only approved
// outputs of earlier stages (CONTENT_STUDIO.md).
const { queryRows, insertRows } = require('./_supabase.js');
const { STAGE_KINDS } = require('../src/domain/stages.js');

const q = (v) => encodeURIComponent(String(v));

/** Build the spec for a piece from the store. Returns null when the piece does not exist. */
async function buildSpec(legacyId) {
  const [piece] = await queryRows('content_pieces', `select=*&legacy_id=eq.${q(legacyId)}&limit=1`);
  if (!piece) return null;
  const stages = await queryRows('stages', `select=id,kind,state,current_version_id&piece_id=eq.${q(piece.id)}`);
  const vids = stages.map((s) => s.current_version_id).filter(Boolean);
  const versions = vids.length ? await queryRows('artifact_versions', `select=id,stage_id,version,kind,payload,produced_by,created_at&id=in.(${vids.map(q).join(',')})`) : [];
  const approvals = vids.length ? await queryRows('approvals', `select=artifact_version_id,decision,reason,reason_code,name_as_signed,decided_at&artifact_version_id=in.(${vids.map(q).join(',')})&order=decided_at.desc`) : [];
  const vById = new Map(versions.map((v) => [v.id, v]));
  const latestDecision = new Map();
  for (const a of approvals) if (!latestDecision.has(a.artifact_version_id)) latestDecision.set(a.artifact_version_id, a);
  const stageSpec = {};
  for (const kind of STAGE_KINDS) {
    const s = stages.find((x) => x.kind === kind);
    const v = s && s.current_version_id ? vById.get(s.current_version_id) : null;
    const d = v ? latestDecision.get(v.id) : null;
    stageSpec[kind] = {
      state: s ? s.state : 'locked',
      current: v ? { versionId: v.id, version: v.version, kind: v.kind, producedBy: v.produced_by, at: v.created_at, summary: summarise(kind, v.payload) } : null,
      approved: s && s.state === 'approved' && v ? { versionId: v.id, version: v.version, by: d ? d.name_as_signed : null, at: d ? d.decided_at : null } : null,
      lastRejection: d && d.decision === 'rejected' ? { reasonCode: d.reason_code || null, reason: d.reason || null, by: d.name_as_signed, at: d.decided_at } : null,
    };
  }
  const plan = stageSpec.plan.current && versions.find((v) => v.id === stageSpec.plan.current.versionId);
  const planPayload = plan ? plan.payload : {};
  return {
    pieceId: piece.id, legacyId: piece.legacy_id, origin: piece.origin, title: piece.title,
    trend: { id: piece.trend_id || null, name: piece.trend_name || null },
    angle: piece.angle || planPayload.angle || null,
    objective: null, // set by the brief stage once rebuilt (6.4)
    platforms: piece.platforms || planPayload.platforms || [], markets: piece.markets || planPayload.markets || [],
    languages: inferLanguages(piece.markets || planPayload.markets || []),
    products: [piece.product || planPayload.product].filter(Boolean),
    keyMessage: piece.key_message || planPayload.msg || null,
    stages: stageSpec,
  };
}

function summarise(kind, payload) {
  if (!payload || typeof payload !== 'object') return null;
  const s = {};
  for (const k of ['title', 'product', 'msg', 'angle', 'objective', 'deadline', 'version', 'dur', 'avg']) if (payload[k] != null) s[k] = payload[k];
  if (payload.imageUrl) s.image = true; if (payload.videoUrl) s.video = true; if (payload.assetPath) s.assetPath = payload.assetPath;
  if (Array.isArray(payload)) s.frames = payload.length;
  if (payload.prompt) s.prompt = String(payload.prompt).slice(0, 300);
  if (kind === 'qc' && payload.runs) s.runs = Object.keys(payload.runs);
  return s;
}

function inferLanguages(markets) {
  const m = (markets || []).map((x) => String(x).toUpperCase());
  const ar = m.some((x) => /KSA|SAUDI|UAE|QATAR|KUWAIT|OMAN|BAHRAIN|EGYPT|GCC|MENA/.test(x));
  return ar ? ['en', 'ar'] : ['en'];
}

/** Write a new version when the derived spec differs from the latest stored one. */
async function syncSpec(legacyId, opts = {}) {
  const spec = await buildSpec(legacyId);
  if (!spec) return null;
  const last = await queryRows('creative_specs', `select=id,version,spec&piece_id=eq.${q(spec.pieceId)}&order=version.desc&limit=1`);
  const prev = last[0] || null;
  const { stages: _s, ...head } = spec;
  const same = prev && JSON.stringify(prev.spec) === JSON.stringify(spec);
  if (same) return { pieceId: spec.pieceId, version: prev.version, changed: false };
  const version = (prev ? prev.version : 0) + 1;
  await insertRows('creative_specs', [{ piece_id: spec.pieceId, version, spec, changed_by: opts.memberId || null, change_note: opts.note || null }]);
  return { pieceId: spec.pieceId, version, changed: true, head };
}

async function latestSpec(legacyId) {
  const [piece] = await queryRows('content_pieces', `select=id&legacy_id=eq.${q(legacyId)}&limit=1`);
  if (!piece) return null;
  const rows = await queryRows('creative_specs', `select=id,version,spec,change_note,created_at&piece_id=eq.${q(piece.id)}&order=version.desc&limit=1`);
  return rows[0] || null;
}

module.exports = { buildSpec, syncSpec, latestSpec, summarise };
