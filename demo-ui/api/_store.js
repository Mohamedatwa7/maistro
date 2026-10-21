// The campaign store (M2 part 2, ADR-002): content_pieces / stages /
// artifact_versions / approvals / adlcp_documents through PostgREST with the
// service role. Every rule about what may happen to a stage comes from
// src/domain/stages.js; this module only loads state, asks the domain, and
// persists the answer. Errors carry `status` so handlers can answer 404/409.
const { queryRows, insertRows, patchRows } = require('./_supabase.js');
const { STAGE_KINDS, ORIGINS, ROLES, transition, pieceStatus } = require('../src/domain/stages.js');

const LEGACY_ID = /^[a-zA-Z0-9_-]{3,64}$/;
const q = (v) => encodeURIComponent(String(v));

class StoreError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

// ---- pieces ----
async function getPiece(legacyId) {
  const rows = await queryRows('content_pieces', `select=*&legacy_id=eq.${q(legacyId)}&limit=1`);
  return rows[0] || null;
}

/** Find or create the piece for a legacy id and make sure all eight stage
 *  rows exist. `meta` is the plan-level data the legacy UI holds. */
async function ensurePiece(legacyId, meta = {}) {
  if (!LEGACY_ID.test(legacyId || '')) throw new StoreError(400, 'bad_id', 'pieceId must be 3-64 chars of [a-zA-Z0-9_-]');
  const origin = ORIGINS.includes(meta.origin) ? meta.origin : legacyId.startsWith('ext-') ? 'external_hermes' : 'studio';
  let piece = await getPiece(legacyId);
  if (!piece) {
    const [created] = await insertRows('content_pieces', [{
      legacy_id: legacyId,
      title: String(meta.title || legacyId).slice(0, 200),
      product: meta.product ? String(meta.product).slice(0, 200) : null,
      key_message: meta.msg ? String(meta.msg).slice(0, 300) : null,
      angle: meta.angle ? String(meta.angle).slice(0, 600) : null,
      markets: Array.isArray(meta.markets) ? meta.markets.map(String).slice(0, 12) : [],
      platforms: Array.isArray(meta.platforms) ? meta.platforms.map(String).slice(0, 4) : [],
      trend_id: meta.trendId ? String(meta.trendId).slice(0, 200) : null,
      trend_name: meta.trendName ? String(meta.trendName).slice(0, 200) : null,
      origin,
      created_by: meta.createdBy || null,
    }], { returning: true, onConflict: 'legacy_id', ignoreDuplicates: true });
    piece = created || (await getPiece(legacyId));
  }
  const existing = await queryRows('stages', `select=id,kind,state,position,current_version_id&piece_id=eq.${q(piece.id)}`);
  const have = new Set(existing.map((s) => s.kind));
  const missing = STAGE_KINDS.filter((k) => !have.has(k)).map((kind) => ({ piece_id: piece.id, kind, position: STAGE_KINDS.indexOf(kind), state: kind === 'plan' ? 'ready' : 'locked' }));
  if (missing.length) await insertRows('stages', missing, { onConflict: 'piece_id,kind', ignoreDuplicates: true });
  const stages = missing.length ? await queryRows('stages', `select=id,kind,state,position,current_version_id&piece_id=eq.${q(piece.id)}`) : existing;
  return { piece, stages };
}

const findStage = (stages, kind) => {
  if (!STAGE_KINDS.includes(kind)) throw new StoreError(400, 'bad_stage', `unknown stage "${kind}"`);
  const s = stages.find((x) => x.kind === kind);
  if (!s) throw new StoreError(404, 'no_stage', `stage ${kind} not found`);
  return s;
};

const VERSION_KINDS = ['text', 'image', 'video', 'qc_report'];
const PRODUCERS = ['claude', 'higgsfield_soul', 'higgsfield_seedance', 'f1x8', 'external_hermes', 'manual'];

function artifactKind(stage, payload) {
  if (stage === 'qc') return 'qc_report';
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    if (payload.videoUrl) return 'video';
    if (payload.imageUrl) return 'image';
  }
  return 'text';
}

/** Append a version to a stage and make it the current one. An approved
 *  stage is immutable (409 — an admin must reopen it first). */
async function recordVersion(legacyId, stage, payload, opts = {}) {
  const { piece, stages } = await ensurePiece(legacyId, opts.piece || {});
  const s = findStage(stages, stage);
  if (s.state === 'approved') throw new StoreError(409, 'approved_immutable', `${stage} is approved; reopen it before adding a version`);
  const producedBy = PRODUCERS.includes(opts.producedBy) ? opts.producedBy : piece.origin === 'external_hermes' ? 'external_hermes' : 'claude';
  const kind = VERSION_KINDS.includes(opts.kind) ? opts.kind : artifactKind(stage, payload);
  const last = await queryRows('artifact_versions', `select=version&stage_id=eq.${q(s.id)}&order=version.desc&limit=1`);
  const version = (last[0] ? last[0].version : 0) + 1;
  const [v] = await insertRows('artifact_versions', [{ stage_id: s.id, version, kind, payload, produced_by: producedBy, job_id: opts.jobId || null, generated_by: opts.generatedBy || null }], { returning: true });
  await patchRows('stages', `id=eq.${q(s.id)}`, { current_version_id: v.id, state: 'generated' });
  return { pieceId: piece.id, legacyId, stage, versionId: v.id, version, state: 'generated' };
}

/** Record an approval or rejection on the stage's current version, under the
 *  domain rules (A-05). `documents` is {line_manager, adlcp} with the stored
 *  object descriptors from /api/upload kind=document (final only). */
async function decide(legacyId, stage, d = {}) {
  const decision = d.decision === 'approved' || d.decision === 'rejected' ? d.decision : null;
  if (!decision) throw new StoreError(400, 'bad_decision', 'decision must be approved or rejected');
  const role = ROLES.includes(d.role) ? d.role : null;
  if (!role) throw new StoreError(400, 'bad_role', `role must be one of ${ROLES.join(', ')}`);
  const name = String(d.name || '').trim().slice(0, 120);
  if (!name) throw new StoreError(400, 'name_required', 'the signer name is required');
  const piece = await getPiece(legacyId);
  if (!piece) throw new StoreError(404, 'no_piece', `piece ${legacyId} not found`);
  const stages = await queryRows('stages', `select=id,kind,state,position,current_version_id&piece_id=eq.${q(piece.id)}`);
  const s = findStage(stages, stage);
  if (!s.current_version_id) throw new StoreError(409, 'no_version', `${stage} has no version to decide on`);
  const [version] = await queryRows('artifact_versions', `select=id,version,generated_by&id=eq.${q(s.current_version_id)}&limit=1`);
  if (!version) throw new StoreError(409, 'no_version', `${stage} version is missing`);

  const docs = d.documents || {};
  const docOk = (x) => x && typeof x === 'object' && /^documents\/\d{4}\/[a-z0-9]+-[a-z0-9]{6}\.[a-z]{3,4}$/.test(String(x.path || '')) && /^[0-9a-f]{64}$/.test(String(x.sha256 || '')) && Number(x.size) > 0;
  const t = decision === 'approved'
    ? { type: 'approve', role, approverId: d.actorId || null, generatedBy: version.generated_by || null, documents: { line_manager: docOk(docs.line_manager), adlcp: docOk(docs.adlcp) } }
    : { type: 'reject', reason: String(d.reason || '') };
  const r = transition(stage, s.state, t);
  if (!r.ok) throw new StoreError(409, r.code, r.message);

  if (decision === 'approved' && stage === 'final') {
    await insertRows('adlcp_documents', ['line_manager', 'adlcp'].map((kind) => ({
      artifact_version_id: version.id, kind, storage_path: docs[kind].path, sha256: docs[kind].sha256,
      size_bytes: Number(docs[kind].size), content_type: String(docs[kind].contentType || 'application/pdf'), uploaded_by: d.actorId || null,
    })), { onConflict: 'artifact_version_id,kind', ignoreDuplicates: true });
  }
  const [approval] = await insertRows('approvals', [{
    artifact_version_id: version.id, decision, reason: decision === 'rejected' ? String(d.reason).trim().slice(0, 2000) : (d.reason ? String(d.reason).slice(0, 2000) : null),
    decided_by: d.actorId || null, name_as_signed: name, role_as_signed: role + (d.info ? ` · ${String(d.info).slice(0, 200)}` : ''),
  }], { returning: true });
  await patchRows('stages', `id=eq.${q(s.id)}`, { state: r.next });
  return { pieceId: piece.id, legacyId, stage, versionId: version.id, version: version.version, state: r.next, approvalId: approval.id, decidedAt: approval.decided_at };
}

/** Admin-only: reopen an approved stage (audited through the trigger). */
async function reopen(legacyId, stage, role) {
  const piece = await getPiece(legacyId);
  if (!piece) throw new StoreError(404, 'no_piece', `piece ${legacyId} not found`);
  const stages = await queryRows('stages', `select=id,kind,state&piece_id=eq.${q(piece.id)}`);
  const s = findStage(stages, stage);
  const r = transition(stage, s.state, { type: 'reopen', role });
  if (!r.ok) throw new StoreError(409, r.code, r.message);
  await patchRows('stages', `id=eq.${q(s.id)}`, { state: r.next });
  return { legacyId, stage, state: r.next };
}

// `id=in.(…)` reads are chunked: 40 uuids is ~1.6 KB of URL, far under any
// proxy header limit, while a 200-piece list would otherwise build 60 KB URLs.
const IN_CHUNK = 40;
async function queryIn(table, select, col, ids, extra = '') {
  const out = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const slice = ids.slice(i, i + IN_CHUNK);
    out.push(...(await queryRows(table, `select=${select}&${col}=in.(${slice.map(q).join(',')})${extra}`)));
  }
  return out;
}

/** Everything the website needs to render pieces: stages with their current
 *  version payload and latest decision. */
async function listPieces(limit = 100) {
  const pieces = await queryRows('content_pieces', `select=*&order=created_at.desc&limit=${Math.min(Number(limit) || 100, 200)}`);
  if (!pieces.length) return [];
  const ids = pieces.map((p) => p.id);
  const stages = await queryIn('stages', 'id,piece_id,kind,state,position,current_version_id,updated_at', 'piece_id', ids);
  const vids = stages.map((s) => s.current_version_id).filter(Boolean);
  const versions = await queryIn('artifact_versions', 'id,version,kind,payload,produced_by,generated_by,created_at', 'id', vids);
  const approvals = await queryIn('approvals', 'artifact_version_id,decision,reason,name_as_signed,role_as_signed,decided_at', 'artifact_version_id', vids, '&order=decided_at.desc');
  const docs = await queryIn('adlcp_documents', 'artifact_version_id,kind,storage_path,sha256,size_bytes,content_type,uploaded_at', 'artifact_version_id', vids);
  const vById = new Map(versions.map((v) => [v.id, v]));
  const latestDecision = new Map();
  for (const a of approvals) if (!latestDecision.has(a.artifact_version_id)) latestDecision.set(a.artifact_version_id, a);
  const docsByVersion = new Map();
  for (const d of docs) { if (!docsByVersion.has(d.artifact_version_id)) docsByVersion.set(d.artifact_version_id, {}); docsByVersion.get(d.artifact_version_id)[d.kind] = { path: d.storage_path, sha256: d.sha256, size: d.size_bytes, contentType: d.content_type, at: d.uploaded_at }; }
  return pieces.map((p) => {
    const mine = stages.filter((s) => s.piece_id === p.id).sort((a, b) => a.position - b.position);
    const out = {};
    for (const s of mine) {
      const v = s.current_version_id ? vById.get(s.current_version_id) : null;
      const a = v ? latestDecision.get(v.id) : null;
      out[s.kind] = {
        state: s.state, updatedAt: s.updated_at,
        version: v ? { id: v.id, n: v.version, kind: v.kind, payload: v.payload, producedBy: v.produced_by, at: v.created_at } : null,
        decision: a ? { decision: a.decision, reason: a.reason, name: a.name_as_signed, role: a.role_as_signed, at: a.decided_at } : null,
        documents: v ? docsByVersion.get(v.id) || null : null,
      };
    }
    return {
      id: p.legacy_id || p.id, pieceId: p.id, title: p.title, product: p.product, msg: p.key_message, angle: p.angle,
      markets: p.markets, platforms: p.platforms, trendId: p.trend_id, trend: p.trend_name, origin: p.origin,
      status: pieceStatus(mine.map((s) => ({ kind: s.kind, state: s.state }))), createdAt: p.created_at, updatedAt: p.updated_at, stages: out,
    };
  });
}

module.exports = { StoreError, ensurePiece, recordVersion, decide, reopen, listPieces, getPiece, artifactKind };
