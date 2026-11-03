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
// first answer per Idempotency-Key, `agent.asset` rows are the campaign's asset registry (assetId → stored copy),
// `agent.upload` rows the signed uploads Hermes asked for (declared sha256 and size, checked on the asset push).
//
// Owner request 2026-11-03 (MAISTRO_OWNER_REQUEST.md): GET /me, the product lock with supporting products,
// carousel slides, video variants, audio tracks, compliance metadata (guidelines 2026-11-02: no realistic AI humans,
// no AI-generated Samsung device), signed uploads, reviewer comments, campaign listing, external_ref and test mode.
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
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const MAX_META_BYTES = 64 * 1024;
const UPLOAD_TTL_S = 2 * 3600; // Supabase signed upload URLs live two hours
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/mp4': 'm4a' };
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const AUDIO_TYPES = ['audio/mpeg', 'audio/wav', 'audio/mp4'];
const KIND_STAGE = { moodboard: 'mood', thumbnail: 'thumb', keyframe: 'board', video: 'draft', carousel_slide: 'draft', audio: 'draft' };
const SCOPES = ['campaigns:create', 'campaigns:list', 'campaigns:read', 'campaigns:write_drafts', 'uploads:create', 'campaigns:delete_test'];
const MADE_BY = { provider: 'hermes', via: 'agent-ingest' };
const ID_RE = /^gen-[a-zA-Z0-9]{3,60}$/;
const q = (v) => encodeURIComponent(String(v));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const nowIso = () => new Date().toISOString();

// ---- request schemas (zod) ----
const str = (max) => z.string().trim().min(1).max(max);
const ProductRef = z.object({ family: str(120), colour: z.string().trim().max(60).optional(), model_code: z.string().trim().max(40).optional() });
const CampaignBody = z.object({
  title: str(200),
  trend: z.object({ id: z.string().trim().max(200).optional(), name: str(200) }),
  product: ProductRef,
  supporting_products: z.array(ProductRef).max(4).optional(),
  markets: z.array(str(40)).min(1).max(12),
  platforms: z.array(str(40)).min(1).max(4),
  source: z.literal('hermes'),
  external_ref: z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:/-]+$/, 'letters, digits and . _ : / - only').optional(),
  test: z.boolean().optional(),
});
const BriefBody = z.object({ brief: z.record(z.string(), z.any()) });
const AssetBody = z.object({
  kind: z.enum(['moodboard', 'thumbnail', 'keyframe', 'video', 'carousel_slide', 'audio']),
  url: z.string().url().startsWith('https://'),
  direction: z.number().int().min(1).max(3).optional(),
  shot_index: z.number().int().min(1).max(12).optional(),
  shot_count: z.number().int().min(1).max(12).optional(),
  slide_index: z.number().int().min(1).max(20).optional(),
  slide_count: z.number().int().min(1).max(20).optional(),
  variant: z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/, '1-40 letters, digits, _ or -').optional(),
  meta: z.record(z.string(), z.any()).optional().default({}),
}).superRefine((b, ctx) => {
  if (b.kind === 'moodboard' && b.direction == null) ctx.addIssue({ code: 'custom', path: ['direction'], message: 'Required' });
  if (b.kind === 'keyframe' && b.shot_index == null) ctx.addIssue({ code: 'custom', path: ['shot_index'], message: 'Required' });
  if (b.kind === 'carousel_slide' && b.slide_index == null) ctx.addIssue({ code: 'custom', path: ['slide_index'], message: 'Required' });
  if (b.shot_index != null && b.shot_count != null && b.shot_index > b.shot_count) ctx.addIssue({ code: 'custom', path: ['shot_index'], message: 'must be ≤ shot_count' });
  if (b.slide_index != null && b.slide_count != null && b.slide_index > b.slide_count) ctx.addIssue({ code: 'custom', path: ['slide_index'], message: 'must be ≤ slide_count' });
  if (b.kind !== 'carousel_slide' && (b.slide_index != null || b.slide_count != null)) ctx.addIssue({ code: 'custom', path: ['slide_index'], message: 'only for kind carousel_slide' });
  if (b.variant != null && !(b.kind === 'video' && b.shot_index == null)) ctx.addIssue({ code: 'custom', path: ['variant'], message: 'only for a whole video (kind video without shot_index)' });
});
// guidelines 2026-11-02: no realistic AI humans, no AI-generated Samsung device (sealed boxes may be AI-rendered
// from official box references; real products only from official 3D/CAD files or official product images)
const Compliance = z.object({
  guidelines_version: z.string().trim().max(40).optional(),
  characters: z.enum(['stylised_3d', 'stylized_3d', '2d_illustrated', 'none']).optional(),
  realistic_humans: z.boolean().optional(),
  ai_generated_samsung_device: z.boolean().optional(),
  product_sources: z.array(z.object({ product: str(200), source: z.enum(['official_product_image', 'official_3d_cad', 'ai_render_from_official_box_refs', 'real_footage']) })).max(12).optional(),
  third_party_logos: z.boolean().optional(),
  alcohol: z.boolean().optional(),
});
const Audio = z.object({
  source: z.enum(['original_ai_generated', 'licensed', 'none']),
  model: z.string().trim().max(120).optional(),
  licensing: z.enum(['cleared', 'none', 'unknown']),
});
const UploadBody = z.object({
  filename: str(200),
  contentType: z.enum(Object.keys(TYPES)),
  size: z.number().int().min(1).max(MAX_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, '64 lower-case hex characters'),
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

/** zod result → 422 body: the fields absent from the body, then every other problem as "path: message" */
function invalid(err, body, prefix = '') {
  const missing = [], problems = [];
  const at = (path) => path.reduce((v, k) => (v != null && typeof v === 'object' ? v[k] : undefined), body);
  for (const i of err.issues) {
    const path = [prefix, i.path.join('.')].filter(Boolean).join('.') || '$';
    if (i.path.length && at(i.path) === undefined) { if (!missing.includes(path)) missing.push(path); } else problems.push(`${path}: ${i.message}`);
  }
  return new HttpError(422, { error: 'validation failed', code: 'invalid', missing, problems });
}
function parse(schema, body, prefix) {
  const r = schema.safeParse(body);
  if (!r.success) throw invalid(r.error, body, prefix);
  return r.data;
}

// ---- product lock ----
// the render specs (official images) plus the codes known only for this lock
const SPECS = { ...C.PRODUCT_SPECS, ...C.AGENT_PRODUCT_CODES };
const norm = (s) => String(s || '').trim().toLowerCase();
/** Every product family a campaign may name: the specs with colourways, the brand catalog and the KB catalog. */
async function knownFamilies() {
  const names = new Set([...Object.keys(SPECS), ...require('../_brand.js').PRODUCT_CATALOG.map((p) => p.name)]);
  try {
    const docs = await require('../_kb/index.js').activeDocuments();
    for (const d of docs) if (d.kind === 'product_catalog' && !String(d.key).startsWith('_') && d.content && d.content.name) names.add(String(d.content.name));
  } catch (e) { /* the KB is optional here: the shipped lists still apply */ }
  return [...names].sort();
}
function allowedList(families) {
  const colours = {};
  for (const f of families) { const s = SPECS[f]; if (s && Object.keys(s.codes).length) colours[f] = Object.entries(s.codes).map(([colour, code]) => ({ colour, model_code: code || null })); }
  return { products: families, colours };
}
/** {family, colour, model_code} → the locked spec, or problems. A model code alone names its family and colour. */
function lockOne(p, path, families) {
  const problems = [];
  let fam = families.find((f) => norm(f) === norm(p.family)) || Object.keys(SPECS).find((f) => (SPECS[f].aliases || []).some((a) => norm(a) === norm(p.family)));
  const byCode = p.model_code ? Object.entries(SPECS).flatMap(([f, s]) => Object.entries(s.codes).filter(([, c]) => c && norm(c) === norm(p.model_code)).map(([colour]) => ({ f, colour }))) : [];
  if (!fam && byCode.length) fam = byCode[0].f;
  if (!fam) return { problems: [`${path}.family: unknown_product "${p.family}"`] };
  const spec = SPECS[fam];
  const known = spec ? Object.keys(spec.codes) : [];
  let colour = p.colour ? known.find((c) => norm(c) === norm(p.colour)) : null;
  if (!colour && !p.colour && byCode.length && byCode[0].f === fam) colour = byCode[0].colour;
  if (p.colour && known.length && !colour) problems.push(`${path}.colour: unknown colour "${p.colour}" for ${fam} (known: ${known.join(', ')})`);
  colour = colour || p.colour || (spec && spec.defaultColour) || null;
  const code = spec && colour && spec.codes[colour] ? spec.codes[colour] : null;
  if (p.model_code && code && norm(p.model_code) !== norm(code)) problems.push(`${path}.model_code: ${p.model_code} is not ${fam} ${colour} (${code})`);
  return { problems, spec: { family: fam, colour, model_code: code || p.model_code || null } };
}
async function lockProducts(hero, supporting) {
  const families = await knownFamilies();
  const all = [lockOne(hero, 'product', families), ...(supporting || []).map((p, i) => lockOne(p, `supporting_products.${i}`, families))];
  const problems = all.flatMap((x) => x.problems);
  if (problems.length) throw new HttpError(422, { error: 'unknown product', code: 'unknown_product', missing: [], problems: ['unknown_product', ...problems], allowed: allowedList(families) });
  return all.map((x) => x.spec);
}
const campaignFamilies = (plan) => [plan.product, ...((plan.supportingProducts || []).map((s) => s.family))].filter(Boolean);

/** meta.compliance and meta.audio: validated, the hard rules enforced, product sources held to the campaign's products. */
function checkMeta(meta, plan) {
  const out = {};
  if (meta.compliance !== undefined) out.compliance = parse(Compliance, meta.compliance, 'meta.compliance');
  if (meta.audio !== undefined) out.audio = parse(Audio, meta.audio, 'meta.audio');
  const c = out.compliance;
  if (c) {
    const bad = [];
    if (c.realistic_humans === true) bad.push('meta.compliance.realistic_humans: realistic AI humans are not allowed (guidelines 2026-11-02)');
    if (c.ai_generated_samsung_device === true) bad.push('meta.compliance.ai_generated_samsung_device: AI-generated Samsung devices are not allowed (guidelines 2026-11-02)');
    if (bad.length) throw new HttpError(422, { error: 'compliance violation', code: 'compliance_violation', missing: [], problems: bad });
    const fams = campaignFamilies(plan);
    const stray = (c.product_sources || []).filter((s) => !fams.some((f) => norm(s.product).includes(norm(f))));
    if (stray.length) throw new HttpError(422, { error: 'product not in this campaign', code: 'product_not_in_campaign', missing: [], problems: stray.map((s) => `meta.compliance.product_sources: "${s.product}" is not the campaign product or a listed supporting product (${fams.join(', ')})`) });
  }
  return out;
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
async function uploadOf(pieceUuid, path) {
  const [row] = await queryRows('audit_log', `select=after&action=eq.agent.upload&entity_id=eq.${q(pieceUuid)}&after->>path=eq.${q(path)}&order=at.desc&limit=1`);
  return row ? row.after : null;
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
  if (plan.payload.deletedAt) throw new HttpError(404, { error: 'campaign not found (deleted test campaign)', code: 'not_found' });
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
  const [spec, ...supporting] = await lockProducts(b.product, b.supporting_products);
  const test = b.test === true || String((req.headers || {})['x-maistro-test'] || '') === '1';
  const idem = String((req.headers || {})['idempotency-key'] || '').trim();
  // same Idempotency-Key → same id, so even two racing first requests converge on one campaign
  const legacyId = `gen-h${idem ? sha(`campaign|${idem}`).slice(0, 12) : crypto.randomBytes(6).toString('hex')}`;
  const meta = { title: b.title, product: spec.family, markets: b.markets, platforms: b.platforms, trendId: b.trend.id || null, trendName: b.trend.name, origin: 'studio' };
  const { piece } = await ensurePiece(legacyId, meta);
  const plan = { title: b.title, product: spec.family, productColour: spec.colour || '', modelCode: spec.model_code, supportingProducts: supporting, externalRef: b.external_ref || null, test, msg: '', angle: '', markets: b.markets, platforms: b.platforms, trend: b.trend.name, trendId: b.trend.id || null, th: ['#0a0a0b', '#1f2937'], source: 'hermes', madeBy: MADE_BY };
  const v = await recordVersion(legacyId, 'plan', plan, { piece: meta, producedBy: 'external_hermes', kind: 'text' });
  return { status: 201, pieceUuid: piece.id, body: { campaignId: legacyId, source: 'hermes', state: 'draft', planVersion: v.version, product: spec, supportingProducts: supporting, externalRef: plan.externalRef, test } };
}

/** Signed upload into Maistro's own storage, for finals that exist only on the Hermes machine. The returned url is
 *  then pushed as a normal asset; Maistro reads it from storage and checks it against the declared sha256 and size. */
async function createUpload(req, id) {
  const { piece } = await agentCampaign(id);
  const b = parse(UploadBody, req.body);
  if (AUDIO_TYPES.includes(b.contentType) && b.size > MAX_AUDIO_BYTES) throw new HttpError(413, { error: 'an audio track is 20 MB at most', code: 'too_large' });
  const path = `agent-uploads/${id}/${Date.now().toString(36)}-${b.sha256.slice(0, 12)}.${TYPES[b.contentType]}`;
  const { uploadUrl } = await storage.signedUploadUrl(path);
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const url = `${base}/storage/v1/object/authenticated/${storage.ASSETS_BUCKET}/${path}`;
  await insertRows('audit_log', [{ action: 'agent.upload', entity: 'agent_upload', entity_id: piece.id, after: { path, filename: b.filename, contentType: b.contentType, size: b.size, sha256: b.sha256, at: nowIso() } }]);
  return { status: 201, pieceUuid: piece.id, body: { campaignId: id, uploadId: `up_${sha(path).slice(0, 16)}`, uploadUrl, method: 'PUT', headers: { 'Content-Type': b.contentType }, expiresAt: new Date(Date.now() + UPLOAD_TTL_S * 1000).toISOString(), url, path } };
}
/** The storage path of one of this campaign's signed uploads, when the url points at it. */
function uploadPath(url, id) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const prefix = `${base}/storage/v1/object/authenticated/${storage.ASSETS_BUCKET}/`;
  if (!base || !url.startsWith(prefix)) return null;
  const path = decodeURIComponent(url.slice(prefix.length).split('?')[0]);
  return path.startsWith(`agent-uploads/${id}/`) && !path.includes('..') ? path : null;
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
  ['audio/wav', (b) => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WAVE'],
  ['audio/mp4', (b) => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp' && /^M4[AB] /.test(b.toString('latin1', 8, 12))],
  ['video/mp4', (b) => b.length > 12 && b.toString('latin1', 4, 8) === 'ftyp'],
  ['audio/mpeg', (b) => b.length > 3 && (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0))],
];
/** The file's real type from its first bytes (a server's Content-Type is not trusted). */
const sniff = (buf) => (MAGIC.find(([, ok]) => ok(buf)) || [null])[0];
const FITS = {
  video: { types: ['video/mp4'], says: 'an mp4' },
  audio: { types: AUDIO_TYPES, says: 'an m4a, mp3 or wav' },
};

async function download(url, kind, campaign) {
  let buf;
  const own = uploadPath(url, campaign.id);
  const base = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
  if (!own && base && url.startsWith(`${base}/storage/v1/object/authenticated/`)) throw new HttpError(422, { error: 'that stored file is not one of this campaign\'s signed uploads', code: 'invalid', missing: [], problems: ['url: not an upload of this campaign'] });
  if (own) {
    // a signed upload into Maistro's own storage: read it there and hold it to what Hermes declared
    const declared = await uploadOf(campaign.pieceUuid, own);
    if (!declared) throw new HttpError(422, { error: 'no signed upload with that url on this campaign', code: 'invalid', missing: [], problems: ['url: unknown upload'] });
    try { buf = await storage.readObject(own, MAX_BYTES); }
    catch (e) { throw new HttpError(e.status === 404 ? 422 : 502, { error: e.status === 404 ? 'the upload has not arrived (PUT the bytes to uploadUrl first)' : 'could not read the upload', code: e.status === 404 ? 'upload_missing' : 'download_failed', missing: [], problems: [] }); }
    const digest = crypto.createHash('sha256').update(buf).digest('hex');
    if (digest !== declared.sha256 || buf.length !== declared.size) throw new HttpError(422, { error: 'the uploaded bytes do not match the declared sha256 and size', code: 'upload_mismatch', missing: [], problems: [`url: got ${buf.length} bytes sha256 ${digest}`] });
  } else {
    let got;
    try { got = await fetchAsset(url, MAX_BYTES); }
    catch (e) {
      if (e.status === 413) throw new HttpError(413, { error: 'asset is larger than 200 MB', code: 'too_large' });
      if (e.status === 422) throw new HttpError(422, { error: 'url host is not an allowed media host (QC_ASSET_HOSTS)', code: 'host_not_allowed', missing: [], problems: ['url: host not allowed'] });
      throw new HttpError(502, { error: `could not download the asset: ${String(e.message).slice(0, 160)}`, code: 'download_failed' });
    }
    buf = Buffer.from(got.buf);
  }
  const type = sniff(buf);
  if (!type) throw new HttpError(415, { error: 'only png, jpg, webp, mp4, m4a, mp3 and wav are accepted', code: 'unsupported_type' });
  const fit = FITS[kind] || { types: IMAGE_TYPES, says: 'a png, jpg or webp' };
  if (!fit.types.includes(type)) throw new HttpError(422, { error: `a ${kind} must be ${fit.says}, got ${type}`, code: 'invalid', missing: [], problems: [`url: ${type} does not fit kind ${kind}`] });
  if (kind === 'audio' && buf.length > MAX_AUDIO_BYTES) throw new HttpError(413, { error: 'an audio track is 20 MB at most', code: 'too_large' });
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
  const { piece, stages, plan } = await agentCampaign(id);
  const b = parse(AssetBody, req.body);
  if (Buffer.byteLength(JSON.stringify(b.meta)) > MAX_META_BYTES) throw new HttpError(422, { error: 'validation failed', code: 'invalid', missing: [], problems: ['meta: larger than 64 KB'] });
  const { compliance, audio } = checkMeta(b.meta || {}, plan.payload);
  const stageKind = KIND_STAGE[b.kind];
  const stage = stageOf(stages, stageKind);
  writable(stage, stageKind);
  const { buf, type } = await download(b.url, b.kind, { id, pieceUuid: piece.id });
  const digest = crypto.createHash('sha256').update(buf).digest('hex');
  const path = `pieces/${id}/${stageKind}/${Date.now().toString(36)}-${digest.slice(0, 12)}.${TYPES[type]}`;
  const stored = await storage.putBlob(path, buf, type);
  const meta = b.meta || {};
  const qa = C.normQa(meta.qa);
  const note = typeof meta.note === 'string' ? meta.note.slice(0, 600) : '';
  const asset = { assetId: `as_${digest.slice(0, 24)}`, kind: b.kind, url: b.url, assetPath: stored.path, sha256: stored.sha256, size: stored.size, contentType: type, direction: b.direction ?? null, shotIndex: b.shot_index ?? null, shotCount: b.shot_count ?? null, slideIndex: b.slide_index ?? null, slideCount: b.slide_count ?? null, variant: b.variant ?? null, meta, at: nowIso() };
  const media = { url: b.url, assetPath: stored.path, sha256: stored.sha256, size: stored.size, qa, botNote: note || null, source: 'hermes', agentAssetId: asset.assetId, at: asset.at, ...(compliance ? { compliance } : {}), ...(audio ? { audio } : {}) };
  let attached;
  /** The current Hermes draft, or a new one with no clips (a carousel or a sound track can come before any video). */
  const hermesDraft = async () => {
    const cur = await versionOf(stage);
    if (cur && cur.payload && cur.payload.source === 'hermes' && Array.isArray(cur.payload.shots)) return;
    const v = await recordVersion(id, 'draft', { shots: [], fromStoryboard: false, note: note || 'From Hermes (agent ingest).', prompt: '', source: 'hermes', madeBy: MADE_BY, rev: 0 }, { producedBy: 'external_hermes', kind: b.kind === 'carousel_slide' ? 'image' : 'video' });
    stage.current_version_id = v.versionId;
  };

  if (b.kind === 'thumbnail') {
    const artifact = { imageUrl: b.url, assetPath: stored.path, sha256: stored.sha256, size: stored.size, prompt: '', note, qa, source: 'hermes', madeBy: MADE_BY, agentAssetId: asset.assetId, meta, ...(compliance ? { compliance } : {}) };
    const v = await recordVersion(id, 'thumb', artifact, { producedBy: 'external_hermes', kind: 'image' });
    attached = { stage: 'thumb', versionId: v.versionId, version: v.version };
  } else if (b.kind === 'video' && b.shot_index == null) {
    // the whole cut: the current draft's assembled video when Hermes sent its clips first, else a one-part draft.
    // A `variant` (music_a, no_audio, …) is one sound version of the cut: variants sit side by side; the first one
    // pushed is also the assembled video the review and QC read. A re-push of a variant replaces it, keeping history.
    const info = mp4Info(buf);
    const assembled = { url: b.url, assetPath: stored.path, sha256: stored.sha256, size: stored.size, durationS: info.durationS || Number(meta.duration_s) || null, width: info.width, height: info.height, version: 'hermes', qa, source: 'hermes', agentAssetId: asset.assetId, at: asset.at, ...(b.variant ? { variant: b.variant } : {}), ...(compliance ? { compliance } : {}), ...(audio ? { audio } : {}) };
    const withCut = (payload) => {
      if (!b.variant) return { assembled };
      const cuts = { ...(payload.cuts || {}) }; const prev = cuts[b.variant];
      cuts[b.variant] = { ...assembled, history: [...((prev && prev.history) || []), ...(prev ? [{ ...prev, history: undefined }] : [])].slice(-10) };
      const keep = payload.assembled && payload.assembled.variant && payload.assembled.variant !== b.variant;
      return { cuts, assembled: keep ? payload.assembled : assembled };
    };
    const cur = await versionOf(stage);
    if (cur && Array.isArray(cur.payload && cur.payload.shots) && cur.payload.source === 'hermes') {
      const r = await patchCurrent(stage, (payload) => ({ ...payload, ...withCut(payload), qa: qa || payload.qa || null }));
      attached = { stage: 'draft', versionId: stage.current_version_id, assembled: true, ...(b.variant ? { variant: b.variant } : {}), rev: r.rev };
    } else {
      const shots = [{ ...blankShot(1), boardShot: null, durationS: assembled.durationS || 0, clipDurationS: assembled.durationS, clip: { state: 'rendered', ...media, durationS: assembled.durationS } }];
      const v = await recordVersion(id, 'draft', { shots, ...withCut({}), totalS: assembled.durationS, fromStoryboard: false, note: note || 'Video from Hermes (agent ingest).', prompt: 'one video', qa, source: 'hermes', madeBy: MADE_BY, agentAssetId: asset.assetId, rev: 0 }, { producedBy: 'external_hermes', kind: 'video' });
      attached = { stage: 'draft', versionId: v.versionId, version: v.version, assembled: true, ...(b.variant ? { variant: b.variant } : {}) };
    }
  } else if (b.kind === 'carousel_slide') {
    // a photo-mode / carousel slide: slides sit in order on the draft; a re-push of an index replaces it, keeping history
    await hermesDraft();
    const n = b.slide_index;
    const r = await patchCurrent(stage, (payload) => {
      const c = payload.carousel || { slideCount: null, slides: [] };
      const slides = (c.slides || []).filter((s) => s.n !== n);
      const prev = (c.slides || []).find((s) => s.n === n);
      slides.push({ n, state: 'rendered', ...media, history: [...((prev && prev.history) || []), ...(prev ? [{ ...prev, history: undefined }] : [])].slice(-10) });
      slides.sort((x, y) => x.n - y.n);
      return { ...payload, carousel: { slideCount: b.slide_count || c.slideCount || null, slides, aspect: '9:16' } };
    });
    attached = { stage: 'draft', versionId: stage.current_version_id, slide: n, rev: r.rev };
  } else if (b.kind === 'audio') {
    await hermesDraft();
    const r = await patchCurrent(stage, (payload) => ({ ...payload, audioTracks: [...(payload.audioTracks || []), { ...media, contentType: type, ...(typeof meta.title === 'string' ? { title: meta.title.slice(0, 120) } : {}) }].slice(-8) }));
    attached = { stage: 'draft', versionId: stage.current_version_id, audioTrack: true, rev: r.rev };
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
      moods[n - 1] = { ...m, state: 'rendered', error: null, botNote: note || m.botNote || null, madeBy: MADE_BY, source: 'hermes', qa: qa || m.qa || null, ...(compliance ? { compliance } : {}), ...(Array.isArray(meta.variation_plan) ? { variationPlan: meta.variation_plan.slice(0, 8) } : {}), ...(Array.isArray(meta.swap_proposals) ? { swapProposals: meta.swap_proposals.slice(0, 8) } : {}) };
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
    const keyframe = a ? { state: 'rendered', url: a.url, assetPath: a.assetPath, sha256: a.sha256, size: a.size, qa: C.normQa(a.meta && a.meta.qa), botNote: a.meta && typeof a.meta.note === 'string' ? a.meta.note.slice(0, 600) : null, ...(a.meta && a.meta.compliance ? { compliance: a.meta.compliance } : {}), source: 'hermes', agentAssetId: a.assetId, at: a.at } : (old[s.index - 1] && old[s.index - 1].keyframe) || null;
    return { ...blankShot(s.index), beat: s.beat, act: s.act, durationS: s.duration_s, type: s.shot_size, angle: s.angle, lens: s.lens, move: s.move, camera: [s.angle, s.move].filter(Boolean).join(', '), action: s.action, devicePose: s.device_pose, keyframe };
  });
  const v = await recordVersion(id, 'board', boardArtifact(shots, { ...b.story, acts: [] }, 'Storyboard from Hermes (agent ingest).'), { producedBy: 'external_hermes', kind: 'image' });
  return { status: 201, pieceUuid: piece.id, body: { campaignId: id, stage: 'board', versionId: v.versionId, version: v.version, shots: shots.length, keyframes: shots.filter((s) => s.keyframe).length, state: v.state, needsReview: true } };
}

/** Reviewer feedback on what Hermes pushed: each stage decision (with the written reason) and each shot review,
 *  tied to the asset it was about. Maistro has approve and reject only; a reject always asks for a new version. */
function commentsOf(kind, v, approvals) {
  const out = approvals.filter((a) => v && a.artifact_version_id === v.id).map((a) => ({ stage: kind, assetId: null, author: a.name_as_signed || null, role: a.role_as_signed || null, text: a.reason || '', reasonCode: a.reason_code || null, createdAt: a.decided_at, decision: a.decision }));
  const shots = v && v.payload && Array.isArray(v.payload.shots) ? v.payload.shots : [];
  for (const s of shots) {
    const r = s.review, m = s.keyframe || s.clip;
    if (r && r.decision) out.push({ stage: kind, shot: s.n, assetId: (m && m.agentAssetId) || null, author: r.by || null, role: null, text: r.reason || '', reasonCode: r.reasonCode || null, createdAt: r.at || null, decision: r.decision });
  }
  return out;
}

async function getCampaign(id) {
  const { piece, stages } = await agentCampaign(id);
  const vids = stages.map((s) => s.current_version_id).filter(Boolean);
  const versions = vids.length ? await queryRows('artifact_versions', `select=id,version,kind,payload,produced_by,created_at&id=in.(${vids.map(q).join(',')})`) : [];
  const approvals = vids.length ? await queryRows('approvals', `select=artifact_version_id,decision,decided_at,reason,reason_code,name_as_signed,role_as_signed&artifact_version_id=in.(${vids.map(q).join(',')})&order=decided_at.desc`) : [];
  const out = {};
  for (const s of [...stages].sort((a, b) => a.position - b.position)) {
    const v = versions.find((x) => x.id === s.current_version_id);
    const a = v && approvals.find((x) => x.artifact_version_id === v.id);
    out[s.kind] = { state: s.state, version: v ? { id: v.id, n: v.version, kind: v.kind, producedBy: v.produced_by, at: v.created_at, payload: v.payload } : null, decision: a ? { decision: a.decision, at: a.decided_at, author: a.name_as_signed || null, reason: a.reason || null } : null, comments: commentsOf(s.kind, v, approvals) };
  }
  const plan = out.plan && out.plan.version ? out.plan.version.payload : {};
  return {
    status: 200,
    body: {
      campaignId: id, title: piece.title, source: 'hermes', status: pieceStatus(stages.map((s) => ({ kind: s.kind, state: s.state }))),
      product: { family: piece.product, colour: plan.productColour || null, model_code: plan.modelCode || null },
      supportingProducts: plan.supportingProducts || [], externalRef: plan.externalRef || null, test: Boolean(plan.test),
      trend: { id: piece.trend_id, name: piece.trend_name }, markets: piece.markets, platforms: piece.platforms, createdAt: piece.created_at,
      stages: out, comments: Object.values(out).flatMap((s) => s.comments), assets: (await assetsOf(piece.id)).map(({ url, ...a }) => ({ ...a, sourceUrl: url })),
    },
  };
}

/** GET /campaigns?source=hermes&limit=50[&external_ref=…]: the campaigns Hermes made, newest first. */
async function listCampaigns(req) {
  const qs = req.query || {};
  if (qs.source != null && qs.source !== 'hermes') throw new HttpError(422, { error: 'validation failed', code: 'invalid', missing: [], problems: ['source: only "hermes"'] });
  const limit = Math.max(1, Math.min(100, Number(qs.limit) || 50));
  const ref = qs.external_ref != null ? String(qs.external_ref) : null;
  // every API campaign id starts gen-h; a Studio id can too, so the plan's source decides
  const pieces = await queryRows('content_pieces', `select=id,legacy_id,title,product,created_at&legacy_id=like.gen-h*&order=created_at.desc&limit=${Math.min(200, limit * 2)}`);
  if (!pieces.length) return { status: 200, body: { campaigns: [] } };
  const stages = await queryRows('stages', `select=piece_id,kind,state,current_version_id&piece_id=in.(${pieces.map((p) => q(p.id)).join(',')})`);
  const planIds = stages.filter((s) => s.kind === 'plan' && s.current_version_id).map((s) => s.current_version_id);
  const plans = planIds.length ? await queryRows('artifact_versions', `select=id,payload&id=in.(${planIds.map(q).join(',')})`) : [];
  const campaigns = [];
  for (const p of pieces) {
    const mine = stages.filter((s) => s.piece_id === p.id);
    const ps = mine.find((s) => s.kind === 'plan');
    const plan = ((ps && plans.find((v) => v.id === ps.current_version_id)) || {}).payload || {};
    if (plan.source !== 'hermes' || plan.deletedAt || (ref != null && plan.externalRef !== ref)) continue;
    campaigns.push({ campaignId: p.legacy_id, title: p.title, status: pieceStatus(mine.map((s) => ({ kind: s.kind, state: s.state }))), product: { family: p.product, colour: plan.productColour || null, model_code: plan.modelCode || null }, externalRef: plan.externalRef || null, test: Boolean(plan.test), createdAt: p.created_at });
    if (campaigns.length >= limit) break;
  }
  return { status: 200, body: { campaigns } };
}

/** DELETE /campaigns/{id}: test campaigns only. Hidden, not erased: the campaign tables keep every version
 *  (restrict foreign keys, audit trail), so the plan is marked deleted and the API and the Studio stop showing it. */
async function deleteCampaign(id) {
  const { plan } = await agentCampaign(id);
  if (!plan.payload.test) throw new HttpError(403, { error: 'only test campaigns can be deleted through the API', code: 'not_test_campaign' });
  const { updateShots } = require('../_jobs.js');
  await updateShots(plan.id, (payload) => ({ ...payload, deletedAt: nowIso() }));
  return { status: 200, body: { campaignId: id, deleted: true } };
}

async function me(req) {
  const key = String(process.env.AGENT_INGEST_KEY || '').trim();
  return {
    status: 200,
    body: {
      source: 'hermes', keyId: `ak_${sha(key).slice(0, 12)}`, scopes: SCOPES, expiresAt: null,
      rotation: 'no fixed expiry; the Maistro owner rotates the key (new AGENT_INGEST_KEY + redeploy) and the old one stops working at once',
      limits: { requestsPerMinute: RATE_PER_MIN, maxAssetBytes: MAX_BYTES, maxAudioBytes: MAX_AUDIO_BYTES, maxMetaBytes: MAX_META_BYTES },
      products: allowedList(await knownFamilies()),
    },
  };
}

function route(req) {
  let segs = req.query && req.query.path != null ? [].concat(req.query.path).join('/').split('/') : String(req.url || '').split('?')[0].replace(/^\/api\/agent\/?/, '').split('/');
  segs = segs.filter(Boolean);
  const method = req.method;
  if (segs.length === 1 && (segs[0] === 'me' || segs[0] === 'ping') && method === 'GET') return { name: 'me', run: () => me(req) };
  if (segs[0] !== 'campaigns') return null;
  if (segs.length === 1 && method === 'POST') return { name: 'create', run: () => createCampaign(req) };
  if (segs.length === 1 && method === 'GET') return { name: 'list', run: () => listCampaigns(req) };
  if (segs.length === 2 && method === 'GET') return { name: 'get', run: () => getCampaign(segs[1]) };
  if (segs.length === 2 && method === 'DELETE') return { name: 'delete', run: () => deleteCampaign(segs[1]) };
  const sub = { brief: postBrief, assets: postAsset, storyboard: postStoryboard, uploads: createUpload }[segs[2]];
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
