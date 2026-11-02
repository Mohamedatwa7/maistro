// /api/agent/* — the scoped write door for the Hermes production agent (docs/agent-ingest.md).
//
// Hermes creates campaigns and pushes what it made: a brief, moodboard / thumbnail / keyframe / video assets and a
// storyboard. Everything lands as a DRAFT version (stage state `generated`) for people to review in the Studio; this
// API can never approve, reject, reopen or publish anything. Assets are downloaded from the given https URL
// (allow-listed media hosts) and copied into Maistro's private Storage bucket under the normal
// pieces/<campaign>/<stage>/ path.
//
// Auth: Authorization: Bearer <AGENT_INGEST_KEY> — one key, these endpoints only; rotate or remove the env var to
// revoke it. The key is never logged. 60 requests a minute. Idempotency-Key on a POST replays the first answer.
//
// Bookkeeping lives in audit_log (no migration): `agent.request` rows count the rate, `agent.idem` rows hold the
// first answer per Idempotency-Key, `agent.asset` rows are the campaign's asset registry (assetId → stored copy).
const crypto = require('node:crypto');
const { z } = require('zod');
const { bearerMatches } = require('../_auth.js');
const { queryRows, insertRows } = require('../_supabase.js');
const { ensurePiece, recordVersion, getPiece, StoreError } = require('../_store.js');
const { pieceStatus } = require('../../src/domain/stages.js');
const storage = require('../_adapters/storage.js');
const { fetchAsset } = require('../_adapters/f1x8.js');
const C = require('../_studio/hermes-contract.js');

const RATE_PER_MIN = 60;
const MAX_BYTES = 200 * 1024 * 1024;
const MAX_META_BYTES = 64 * 1024;
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4' };
const KIND_STAGE = { moodboard: 'mood', thumbnail: 'thumb', keyframe: 'board', video: 'draft' };
const MADE_BY = { provider: 'hermes', via: 'agent-ingest' };
const ID_RE = /^gen-[a-zA-Z0-9]{3,60}$/;
const q = (v) => encodeURIComponent(String(v));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowIso = () => new Date().toISOString();

// ---- request schemas (zod) ----
const str = (max) => z.string().trim().min(1).max(max);
const CampaignBody = z.object({
  title: str(200),
  trend: z.object({ id: z.string().trim().max(200).optional(), name: str(200) }),
  product: z.object({ family: str(120), colour: z.string().trim().max(60).optional(), model_code: z.string().trim().max(40).optional() }),
  markets: z.array(str(40)).min(1).max(12),
  platforms: z.array(str(40)).min(1).max(4),
  source: z.literal('hermes'),
});
const BriefBody = z.object({ brief: z.record(z.any()) });
const AssetBody = z.object({
  kind: z.enum(['moodboard', 'thumbnail', 'keyframe', 'video']),
  url: z.string().url().startsWith('https://'),
  direction: z.number().int().min(1).max(3).optional(),
  shot_index: z.number().int().min(1).max(12).optional(),
  shot_count: z.number().int().min(1).max(12).optional(),
  meta: z.record(z.any()).optional().default({}),
}).superRefine((b, ctx) => {
  if (b.kind === 'moodboard' && b.direction == null) ctx.addIssue({ code: 'custom', path: ['direction'], message: 'Required' });
  if (b.kind === 'keyframe' && b.shot_index == null) ctx.addIssue({ code: 'custom', path: ['shot_index'], message: 'Required' });
  if (b.shot_index != null && b.shot_count != null && b.shot_index > b.shot_count) ctx.addIssue({ code: 'custom', path: ['shot_index'], message: 'must be ≤ shot_count' });
});
const StoryboardBody = z.object({
  story: z.object({ logline: str(400), product_truth: str(400), emotional_arc: str(300) }),
  shots: z.array(z.object({
    index: z.number().int().min(1).max(12), act: str(120), beat: str(200), duration_s: z.number().positive().max(60),
    shot_size: str(60), angle: str(120), lens: z.string().trim().max(60), move: str(160), action: str(1000), device_pose: str(400),
    keyframe_asset_id: z.string().trim().max(80).optional(),
  })).min(1).max(12),
}).superRefine((b, ctx) => {
  const idx = b.shots.map((s) => s.index).sort((x, y) => x - y);
  if (idx.some((v, i) => v !== i + 1)) ctx.addIssue({ code: 'custom', path: ['shots'], message: 'index must run 1..N without gaps or repeats' });
});

class HttpError extends Error { constructor(status, body) { super(body.error); this.status = status; this.body = body; } }

/** zod result → 422 body: the missing fields, then every other problem as "path: message" */
function invalid(err) {
  const missing = [], problems = [];
  for (const i of err.issues) {
    const path = i.path.join('.') || '$';
    if (i.message === 'Required') missing.push(path); else problems.push(`${path}: ${i.message}`);
  }
  return new HttpError(422, { error: 'validation failed', code: 'invalid', missing, problems });
}
function parse(schema, body) {
  const r = schema.safeParse(body);
  if (!r.success) throw invalid(r.error);
  return r.data;
}

// ---- rate limit, idempotency, asset registry (audit_log) ----
async function rateLimited(path, method) {
  try {
    const since = new Date(Date.now() - 60000).toISOString();
    const rows = await queryRows('audit_log', `select=id&action=eq.agent.request&at=gte.${q(since)}&limit=${RATE_PER_MIN + 1}`);
    if (rows.length >= RATE_PER_MIN) return true;
    await insertRows('audit_log', [{ action: 'agent.request', entity: 'agent_ingest', after: { method, path } }]);
  } catch (e) { console.error('[agent] rate check failed (allowing):', e.message); }
  return false;
}
const idemOf = (req, method, path) => { const k = String((req.headers || {})['idempotency-key'] || '').trim(); return method === 'POST' && k ? sha(`${k}|${method}|${path}`) : null; };
async function replay(k) {
  const [row] = await queryRows('audit_log', `select=after&action=eq.agent.idem&after->>k=eq.${k}&order=at.asc&limit=1`);
  return row && row.after ? row.after : null;
}
async function remember(k, status, body, pieceUuid) {
  try { await insertRows('audit_log', [{ action: 'agent.idem', entity: 'agent_ingest', entity_id: pieceUuid || null, after: { k, status, body } }]); }
  catch (e) { console.error('[agent] idempotency record failed:', e.message); }
}
async function assetsOf(pieceUuid) {
  const rows = await queryRows('audit_log', `select=after,at&action=eq.agent.asset&entity=eq.agent_asset&entity_id=eq.${q(pieceUuid)}&order=at.asc&limit=500`);
  return rows.map((r) => r.after).filter(Boolean);
}

// ---- campaign helpers ----
async function stagesOf(piece) {
  return queryRows('stages', `select=id,kind,state,position,current_version_id&piece_id=eq.${q(piece.id)}`);
}
async function versionOf(stage) {
  if (!stage || !stage.current_version_id) return null;
  const [v] = await queryRows('artifact_versions', `select=id,version,kind,payload,produced_by,created_at&id=eq.${q(stage.current_version_id)}&limit=1`);
  return v || null;
}
/** The campaign, only when Hermes created it through this API (its plan says source: hermes). */
async function agentCampaign(id) {
  if (!ID_RE.test(String(id || ''))) throw new HttpError(404, { error: 'campaign not found', code: 'not_found' });
  const piece = await getPiece(id);
  if (!piece) throw new HttpError(404, { error: 'campaign not found', code: 'not_found' });
  const stages = await stagesOf(piece);
  const plan = await versionOf(stages.find((s) => s.kind === 'plan'));
  if (!plan || !plan.payload || plan.payload.source !== 'hermes') throw new HttpError(403, { error: 'this key can only touch campaigns Hermes created through the agent API', code: 'not_agent_campaign' });
  return { piece, stages, plan };
}
const stageOf = (stages, kind) => stages.find((s) => s.kind === kind);
function writable(stage, kind) {
  if (stage && stage.state === 'approved') throw new HttpError(409, { error: `${kind} is approved; a person must reopen it before Hermes can add to it`, code: 'approved_immutable' });
}

/** Write a payload change onto the stage's current version (optimistic, like the job service). */
async function patchCurrent(stage, mutate) {
  const { updateShots } = require('../_jobs.js');
  const r = await updateShots(stage.current_version_id, mutate);
  if (r.unchanged) throw new HttpError(409, { error: 'the current version does not take this asset', code: 'not_applicable' });
  return r;
}

// ---- handlers ----
async function createCampaign(req) {
  const b = parse(CampaignBody, req.body);
  const spec = C.productSpec({ family: b.product.family, colour: b.product.colour || '' });
  const idem = String((req.headers || {})['idempotency-key'] || '').trim();
  // same Idempotency-Key → same id, so even two racing first requests converge on one campaign
  const legacyId = `gen-h${idem ? sha(`campaign|${idem}`).slice(0, 12) : crypto.randomBytes(6).toString('hex')}`;
  const meta = { title: b.title, product: spec.family, markets: b.markets, platforms: b.platforms, trendId: b.trend.id || null, trendName: b.trend.name, origin: 'studio' };
  const { piece } = await ensurePiece(legacyId, meta);
  const plan = { title: b.title, product: spec.family, productColour: spec.colour || b.product.colour || '', modelCode: b.product.model_code || spec.model_code || null, msg: '', angle: '', markets: b.markets, platforms: b.platforms, trend: b.trend.name, trendId: b.trend.id || null, th: ['#0a0a0b', '#1f2937'], source: 'hermes', madeBy: MADE_BY };
  const v = await recordVersion(legacyId, 'plan', plan, { piece: meta, producedBy: 'external_hermes', kind: 'text' });
  return { status: 201, pieceUuid: piece.id, body: { campaignId: legacyId, source: 'hermes', state: 'draft', planVersion: v.version } };
}

async function postBrief(req, id) {
  const { piece } = await agentCampaign(id);
  const b = parse(BriefBody, req.body);
  const briefMod = require('../_studio/brief.js');
  const problems = briefMod.validateShape(b.brief);
  if (problems.length) {
    const missing = problems.filter((p) => /: required$/.test(p)).map((p) => `brief.${p.replace(/: required$/, '')}`);
    throw new HttpError(422, { error: 'validation failed', code: 'invalid', missing, problems: problems.filter((p) => !/: required$/.test(p)).map((p) => `brief.${p}`) });
  }
  const artifact = { ...briefMod.artifactFrom(b.brief, piece, { promptVersion: 'hermes/agent-ingest' }), source: 'hermes', madeBy: MADE_BY };
  const v = await recordVersion(id, 'brief', artifact, { producedBy: 'external_hermes', kind: 'text' });
  return { status: 201, pieceUuid: piece.id, body: { campaignId: id, stage: 'brief', versionId: v.versionId, version: v.version, state: v.state, needsReview: true } };
}

const MAGIC = [
  ['image/png', (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['image/jpeg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/webp', (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
  ['video/mp4', (b) => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp'],
];
/** The file's real type from its first bytes (a server's Content-Type is not trusted). */
const sniff = (buf) => (MAGIC.find(([, ok]) => ok(buf)) || [null])[0];

async function download(url, kind) {
  let got;
  try { got = await fetchAsset(url, MAX_BYTES); }
  catch (e) {
    if (e.status === 413) throw new HttpError(413, { error: 'asset is larger than 200 MB', code: 'too_large' });
    if (e.status === 422) throw new HttpError(422, { error: 'url host is not an allowed media host (QC_ASSET_HOSTS)', code: 'host_not_allowed', missing: [], problems: ['url: host not allowed'] });
    throw new HttpError(502, { error: `could not download the asset: ${String(e.message).slice(0, 160)}`, code: 'download_failed' });
  }
  const buf = Buffer.from(got.buf);
  const type = sniff(buf);
  if (!type) throw new HttpError(415, { error: 'only png, jpg, webp and mp4 are accepted', code: 'unsupported_type' });
  if ((kind === 'video') !== (type === 'video/mp4')) throw new HttpError(422, { error: `a ${kind} must be ${kind === 'video' ? 'an mp4' : 'a png, jpg or webp'}, got ${type}`, code: 'invalid', missing: [], problems: [`url: ${type} does not fit kind ${kind}`] });
  return { buf, type };
}

const blankShot = (n) => ({ n, beat: '', act: '', durationS: 3, type: 'medium', camera: '', angle: '', lens: '', move: '', action: '', devicePose: '', product: { visible: true, feature: '' }, onScreenText: null, line: null, audioCue: null, transition: 'cut', keyframe: null, review: null });
function shotsFromList(list, count) {
  const shots = (Array.isArray(list) ? list : []).slice(0, 12).map((s, i) => {
    const x = s && typeof s === 'object' ? s : {};
    return { ...blankShot(Number(x.index || x.n) || i + 1), beat: String(x.beat || '').slice(0, 200), act: String(x.act || '').slice(0, 120), durationS: Number(x.duration_s || x.durationS) || 3, type: String(x.shot_size || x.type || 'medium').slice(0, 60), angle: String(x.angle || '').slice(0, 120), lens: String(x.lens || '').slice(0, 60), move: String(x.move || '').slice(0, 160), camera: [x.angle, x.move].filter(Boolean).join(', ').slice(0, 200), action: String(x.action || '').slice(0, 1000), devicePose: String(x.device_pose || x.devicePose || '').slice(0, 400) };
  });
  while (shots.length < (count || 0)) shots.push(blankShot(shots.length + 1));
  return shots.map((s, i) => ({ ...s, n: i + 1 }));
}
/** An mp4's frame size (the first track header with one) and duration (movie header), read from its boxes. */
function mp4Info(buf) {
  let width = null, height = null, durationS = null;
  for (let i = buf.indexOf('tkhd'); i > 3 && width == null; i = buf.indexOf('tkhd', i + 4)) {
    const size = buf.readUInt32BE(i - 4), end = i - 4 + size;
    if (size < 84 || end > buf.length) continue;
    const w = buf.readUInt32BE(end - 8) >>> 16, h = buf.readUInt32BE(end - 4) >>> 16;
    if (w && h) { width = w; height = h; }
  }
  const m = buf.indexOf('mvhd');
  if (m > 3 && m + 32 <= buf.length) {
    const v1 = buf[m + 4] === 1;
    const scale = buf.readUInt32BE(m + (v1 ? 24 : 16));
    const dur = v1 ? Number(buf.readBigUInt64BE(m + 28)) : buf.readUInt32BE(m + 20);
    if (scale) durationS = Math.round((dur / scale) * 10) / 10;
  }
  return { width, height, durationS };
}
const boardArtifact = (shots, story, note) => ({ shots, hookShot: 1, notes: note, storyline: null, story: story || null, totalS: Math.round(shots.reduce((a, s) => a + (Number(s.durationS) || 0), 0) * 10) / 10, boardVersion: 'hermes/agent-ingest', aspect: '9:16', prompt: `storyboard of ${shots.length} shots`, note, rev: 0, source: 'hermes', madeBy: MADE_BY });

async function postAsset(req, id) {
  const { piece, stages } = await agentCampaign(id);
  const b = parse(AssetBody, req.body);
  if (Buffer.byteLength(JSON.stringify(b.meta)) > MAX_META_BYTES) throw new HttpError(422, { error: 'validation failed', code: 'invalid', missing: [], problems: ['meta: larger than 64 KB'] });
  const stageKind = KIND_STAGE[b.kind];
  const stage = stageOf(stages, stageKind);
  writable(stage, stageKind);
  const { buf, type } = await download(b.url, b.kind);
  const digest = crypto.createHash('sha256').update(buf).digest('hex');
  const path = `pieces/${id}/${stageKind}/${Date.now().toString(36)}-${digest.slice(0, 12)}.${TYPES[type]}`;
  const stored = await storage.putBlob(path, buf, type);
  const meta = b.meta || {};
  const qa = C.normQa(meta.qa);
  const note = typeof meta.note === 'string' ? meta.note.slice(0, 600) : '';
  const asset = { assetId: `as_${digest.slice(0, 24)}`, kind: b.kind, url: b.url, assetPath: stored.path, sha256: stored.sha256, size: stored.size, contentType: type, direction: b.direction ?? null, shotIndex: b.shot_index ?? null, shotCount: b.shot_count ?? null, meta, at: nowIso() };
  const media = { url: b.url, assetPath: stored.path, sha256: stored.sha256, size: stored.size, qa, botNote: note || null, source: 'hermes', agentAssetId: asset.assetId, at: asset.at };
  let attached;

  if (b.kind === 'thumbnail') {
    const artifact = { imageUrl: b.url, assetPath: stored.path, sha256: stored.sha256, size: stored.size, prompt: '', note, qa, source: 'hermes', madeBy: MADE_BY, agentAssetId: asset.assetId, meta };
    const v = await recordVersion(id, 'thumb', artifact, { producedBy: 'external_hermes', kind: 'image' });
    attached = { stage: 'thumb', versionId: v.versionId, version: v.version };
  } else if (b.kind === 'video' && b.shot_index == null) {
    // the whole cut: the current draft's assembled video when Hermes sent its clips first, else a one-part draft
    const info = mp4Info(buf);
    const assembled = { url: b.url, assetPath: stored.path, sha256: stored.sha256, size: stored.size, durationS: info.durationS || Number(meta.duration_s) || null, width: info.width, height: info.height, version: 'hermes', qa, source: 'hermes', agentAssetId: asset.assetId, at: asset.at };
    const cur = await versionOf(stage);
    if (cur && Array.isArray(cur.payload && cur.payload.shots) && cur.payload.source === 'hermes') {
      const r = await patchCurrent(stage, (payload) => ({ ...payload, assembled, qa: qa || payload.qa || null }));
      attached = { stage: 'draft', versionId: stage.current_version_id, assembled: true, rev: r.rev };
    } else {
      const shots = [{ ...blankShot(1), boardShot: null, durationS: assembled.durationS || 0, clipDurationS: assembled.durationS, clip: { state: 'rendered', ...media, durationS: assembled.durationS } }];
      const v = await recordVersion(id, 'draft', { shots, assembled, totalS: assembled.durationS, fromStoryboard: false, note: note || 'Video from Hermes (agent ingest).', prompt: 'one video', qa, source: 'hermes', madeBy: MADE_BY, agentAssetId: asset.assetId, rev: 0 }, { producedBy: 'external_hermes', kind: 'video' });
      attached = { stage: 'draft', versionId: v.versionId, version: v.version, assembled: true };
    }
  } else if (b.kind === 'moodboard') {
    const { slotOf, PER_MOOD, MOODS } = require('../_studio/mood.js');
    let cur = await versionOf(stage);
    if (!cur || !Array.isArray(cur.payload && cur.payload.moods)) {
      const moods = Array.from({ length: MOODS }, (_, i) => ({ n: i + 1, name: `Direction ${i + 1}`, pitch: '', direction: null, prompt: '', state: 'pending', jobId: null, error: null }));
      const images = moods.flatMap((m) => Array.from({ length: PER_MOOD }, (_, k) => ({ mood: m.n, state: 'pending', url: null, assetPath: null, tag: `${m.name} · ${k + 1}` })));
      const v = await recordVersion(id, 'mood', { setMode: 'moods', moods, images, chosen: null, direction: null, prompt: `${MOODS} moods to pick from`, note: 'Moodboard from Hermes (agent ingest) — pick one direction.', source: 'hermes', madeBy: MADE_BY, rev: 0 }, { producedBy: 'external_hermes', kind: 'image' });
      stage.current_version_id = v.versionId;
    }
    const n = b.direction;
    const r = await patchCurrent(stage, (payload) => {
      if (!Array.isArray(payload.moods) || !payload.moods[n - 1]) return null;
      const moods = payload.moods.map((m) => ({ ...m })); const images = (payload.images || []).map((x) => ({ ...x }));
      const at = slotOf(n);
      const filled = images.slice(at, at + PER_MOOD).filter((x) => x && x.state === 'rendered').length;
      const k = at + (filled % PER_MOOD); // each direction holds PER_MOOD images; one more replaces the oldest
      images[k] = { ...images[k], mood: n, state: 'rendered', url: b.url, assetPath: stored.path, sha256: stored.sha256, agentAssetId: asset.assetId, source: 'hermes' };
      const m = moods[n - 1];
      moods[n - 1] = { ...m, state: 'rendered', error: null, botNote: note || m.botNote || null, madeBy: MADE_BY, source: 'hermes', qa: qa || m.qa || null, ...(Array.isArray(meta.variation_plan) ? { variationPlan: meta.variation_plan.slice(0, 8) } : {}), ...(Array.isArray(meta.swap_proposals) ? { swapProposals: meta.swap_proposals.slice(0, 8) } : {}) };
      const first = images.find((x) => x.state === 'rendered');
      return { ...payload, moods, images, imageUrl: first ? first.url : null, assetPath: first ? first.assetPath : null };
    });
    attached = { stage: 'mood', versionId: stage.current_version_id, direction: n, rev: r.rev };
  } else {
    // keyframe → storyboard shot; video with shot_index → draft clip
    const slot = b.kind === 'keyframe' ? 'keyframe' : 'clip';
    const n = b.shot_index;
    let cur = await versionOf(stage);
    if (!cur || !Array.isArray(cur.payload && cur.payload.shots)) {
      if (slot === 'keyframe') {
        const shots = shotsFromList(meta.shot_list, Math.max(b.shot_count || 0, n));
        const v = await recordVersion(id, 'board', boardArtifact(shots, C.normStory(meta.story), 'Storyboard from Hermes (agent ingest).'), { producedBy: 'external_hermes', kind: 'image' });
        stage.current_version_id = v.versionId;
      } else {
        const count = Math.max(b.shot_count || 0, n);
        const shots = Array.from({ length: count }, (_, i) => ({ ...blankShot(i + 1), boardShot: i + 1, clipDurationS: null, clip: null }));
        const v = await recordVersion(id, 'draft', { shots, note: 'Draft clips from Hermes (agent ingest).', prompt: `${count} clips`, source: 'hermes', madeBy: MADE_BY, rev: 0 }, { producedBy: 'external_hermes', kind: 'video' });
        stage.current_version_id = v.versionId;
      }
    }
    const item = { state: 'rendered', ...media, ...(slot === 'clip' ? { durationS: Number(meta.duration_s) || null } : {}) };
    const r = await patchCurrent(stage, (payload) => {
      if (!Array.isArray(payload.shots) || !payload.shots[n - 1]) return null;
      const next = payload.shots.map((s) => ({ ...s }));
      const prev = next[n - 1][slot];
      next[n - 1] = { ...next[n - 1], [slot]: item, [`${slot}History`]: [...(next[n - 1][`${slot}History`] || []), ...(prev && prev.state === 'rendered' ? [prev] : [])], review: null };
      return { ...payload, shots: next, ...(slot === 'keyframe' && !payload.story && meta.story ? { story: C.normStory(meta.story) } : {}) };
    });
    attached = { stage: stageKind, versionId: stage.current_version_id, shot: n, rev: r.rev };
  }
  await insertRows('audit_log', [{ action: 'agent.asset', entity: 'agent_asset', entity_id: piece.id, after: { ...asset, attached } }]);
  return { status: 201, pieceUuid: piece.id, body: { campaignId: id, assetId: asset.assetId, kind: b.kind, assetPath: stored.path, sha256: stored.sha256, size: stored.size, contentType: type, attached, needsReview: true } };
}

async function postStoryboard(req, id) {
  const { piece, stages } = await agentCampaign(id);
  const b = parse(StoryboardBody, req.body);
  const stage = stageOf(stages, 'board');
  writable(stage, 'board');
  const cur = await versionOf(stage);
  const old = cur && Array.isArray(cur.payload && cur.payload.shots) ? cur.payload.shots : [];
  const registry = b.shots.some((s) => s.keyframe_asset_id) ? await assetsOf(piece.id) : [];
  const unknown = b.shots.filter((s) => s.keyframe_asset_id && !registry.some((a) => a.assetId === s.keyframe_asset_id && a.kind !== 'video'));
  if (unknown.length) throw new HttpError(422, { error: 'validation failed', code: 'invalid', missing: [], problems: unknown.map((s) => `shots[index=${s.index}].keyframe_asset_id: no image asset ${s.keyframe_asset_id} on this campaign`) });
  const shots = [...b.shots].sort((x, y) => x.index - y.index).map((s) => {
    const a = s.keyframe_asset_id ? registry.find((x) => x.assetId === s.keyframe_asset_id) : null;
    // a named asset wins; otherwise the keyframe already at that index stays (keyframes may arrive first)
    const keyframe = a ? { state: 'rendered', url: a.url, assetPath: a.assetPath, sha256: a.sha256, size: a.size, qa: C.normQa(a.meta && a.meta.qa), botNote: a.meta && typeof a.meta.note === 'string' ? a.meta.note.slice(0, 600) : null, source: 'hermes', agentAssetId: a.assetId, at: a.at } : (old[s.index - 1] && old[s.index - 1].keyframe) || null;
    return { ...blankShot(s.index), beat: s.beat, act: s.act, durationS: s.duration_s, type: s.shot_size, angle: s.angle, lens: s.lens, move: s.move, camera: [s.angle, s.move].filter(Boolean).join(', '), action: s.action, devicePose: s.device_pose, keyframe };
  });
  const v = await recordVersion(id, 'board', boardArtifact(shots, { ...b.story, acts: [] }, 'Storyboard from Hermes (agent ingest).'), { producedBy: 'external_hermes', kind: 'image' });
  return { status: 201, pieceUuid: piece.id, body: { campaignId: id, stage: 'board', versionId: v.versionId, version: v.version, shots: shots.length, keyframes: shots.filter((s) => s.keyframe).length, state: v.state, needsReview: true } };
}

async function getCampaign(id) {
  const { piece, stages } = await agentCampaign(id);
  const vids = stages.map((s) => s.current_version_id).filter(Boolean);
  const versions = vids.length ? await queryRows('artifact_versions', `select=id,version,kind,payload,produced_by,created_at&id=in.(${vids.map(q).join(',')})`) : [];
  const approvals = vids.length ? await queryRows('approvals', `select=artifact_version_id,decision,decided_at&artifact_version_id=in.(${vids.map(q).join(',')})&order=decided_at.desc`) : [];
  const out = {};
  for (const s of [...stages].sort((a, b) => a.position - b.position)) {
    const v = versions.find((x) => x.id === s.current_version_id);
    const a = v && approvals.find((x) => x.artifact_version_id === v.id);
    out[s.kind] = { state: s.state, version: v ? { id: v.id, n: v.version, kind: v.kind, producedBy: v.produced_by, at: v.created_at, payload: v.payload } : null, decision: a ? { decision: a.decision, at: a.decided_at } : null };
  }
  const plan = out.plan && out.plan.version ? out.plan.version.payload : {};
  return {
    status: 200,
    body: {
      campaignId: id, title: piece.title, source: 'hermes', status: pieceStatus(stages.map((s) => ({ kind: s.kind, state: s.state }))),
      product: { family: piece.product, colour: plan.productColour || null, model_code: plan.modelCode || null },
      trend: { id: piece.trend_id, name: piece.trend_name }, markets: piece.markets, platforms: piece.platforms, createdAt: piece.created_at,
      stages: out, assets: (await assetsOf(piece.id)).map(({ url, ...a }) => ({ ...a, sourceUrl: url })),
    },
  };
}

function route(req) {
  let segs = req.query && req.query.path != null ? [].concat(req.query.path).join('/').split('/') : String(req.url || '').split('?')[0].replace(/^\/api\/agent\/?/, '').split('/');
  segs = segs.filter(Boolean);
  const method = req.method;
  if (segs[0] !== 'campaigns') return null;
  if (segs.length === 1 && method === 'POST') return { name: 'create', run: () => createCampaign(req) };
  if (segs.length === 2 && method === 'GET') return { name: 'get', run: () => getCampaign(segs[1]) };
  const sub = { brief: postBrief, assets: postAsset, storyboard: postStoryboard }[segs[2]];
  if (segs.length === 3 && sub && method === 'POST') return { name: segs[2], run: () => sub(req, segs[1]) };
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const key = String(process.env.AGENT_INGEST_KEY || '').trim(); // a pasted value's trailing newline is not part of the key
  if (!key) return res.status(503).json({ error: 'agent ingest is not configured', code: 'not_configured' });
  if (!bearerMatches((req.headers || {}).authorization, key)) return res.status(401).json({ error: 'unauthorized', code: 'unauthorized' });
  const r = route(req);
  if (!r) return res.status(404).json({ error: 'unknown agent endpoint', code: 'not_found' });
  const path = `/api/agent/${[].concat((req.query && req.query.path) || []).join('/') || String(req.url || '').split('?')[0].replace(/^\/api\/agent\/?/, '')}`;
  if (await rateLimited(path, req.method)) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: `rate limit: ${RATE_PER_MIN} requests a minute`, code: 'rate_limited' }); }
  if (req.method === 'POST' && !/json/i.test(String((req.headers || {})['content-type'] || 'application/json'))) return res.status(415).json({ error: 'send application/json (multipart uploads are not accepted; pass a public https url)', code: 'unsupported_media_type' });
  if (req.method === 'POST' && typeof req.body === 'string') { try { req.body = JSON.parse(req.body); } catch (e) { return res.status(400).json({ error: 'body must be JSON', code: 'bad_json' }); } }
  const k = idemOf(req, req.method, path);
  try {
    if (k) { const prev = await replay(k); if (prev) { res.setHeader('Idempotent-Replayed', 'true'); return res.status(prev.status).json(prev.body); } }
    const out = await r.run();
    if (k) await remember(k, out.status, out.body, out.pieceUuid);
    return res.status(out.status).json(out.body);
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json(e.body);
    if (e instanceof StoreError) return res.status(e.status).json({ error: e.message, code: e.code });
    console.error(`[agent] ${r.name} failed:`, e.message);
    return res.status(e.status && e.status >= 400 && e.status < 600 ? e.status : 500).json({ error: 'agent ingest failed', code: 'internal' });
  }
};
module.exports.sniff = sniff;
module.exports.RATE_PER_MIN = RATE_PER_MIN;
