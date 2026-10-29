// Product 3D models (owner 2026-10-29): a person uploads the product's model once, as a .glb exported from Blender.
// The page renders it (<model-viewer>) and photographs it from fixed angles; those views are the product reference
// for every render of that product's campaigns — the image bots and the video bot get them as product_image_urls —
// so the device on screen is the modelled one. The model goes straight to the private bucket (signed upload); the
// views are public refs (the bots download them); the index is one JSON object in storage, so no table is needed.
const storage = require('../_adapters/storage.js');
const { fetchT } = require('../_http.js');

const INDEX = 'products/index.json';
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_VIEWS = 12;
const REFS_PER_RENDER = 4;
const TTL_MS = 60e3;
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
const fail = (status, error, code) => Object.assign(new Error(error), { status, code });

let cache = null;
async function readIndex({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let value;
  try { value = JSON.parse((await storage.readObject(INDEX, 2 * 1024 * 1024)).toString('utf8')); }
  catch (e) { if (e.status === 404) value = { models: {} }; else throw e; }
  if (!value || typeof value.models !== 'object') value = { models: {} };
  cache = { at: Date.now(), value };
  return value;
}
async function writeIndex(value) {
  await storage.putBlob(INDEX, Buffer.from(JSON.stringify(value)), 'application/json');
  cache = { at: Date.now(), value };
}

/** the model for a campaign's product: the same name, else the longest model name inside the product's name */
function match(models, product) {
  const s = slug(product);
  if (!s) return null;
  if (models[s]) return models[s];
  const hit = Object.keys(models).filter((k) => s.includes(k)).sort((a, b) => b.length - a.length)[0];
  return hit ? models[hit] : null;
}

/** → { refs: [https…] (hero view first), model: slug } or { refs: [] } — never throws (a render goes on without) */
async function refsFor(product) {
  try {
    const m = match((await readIndex()).models, product);
    if (!m) return { refs: [] };
    const views = [...m.views].sort((a, b) => (b.hero ? 1 : 0) - (a.hero ? 1 : 0));
    return { refs: views.map((v) => v.url).slice(0, REFS_PER_RENDER), model: m.slug };
  } catch (e) { return { refs: [] }; }
}

/** the 3D views first, then the campaign's own photo (b.refImage), at most REFS_PER_RENDER */
async function renderRefs(product, pagePhoto) {
  const { refs, model } = await refsFor(product);
  const all = [...new Set([...refs, ...(typeof pagePhoto === 'string' && /^https:\/\//.test(pagePhoto) ? [pagePhoto] : [])])].slice(0, REFS_PER_RENDER);
  return { ref: all[0] || null, refs: all, model: model || null };
}

async function list() {
  const { models } = await readIndex({ fresh: true });
  const out = [];
  for (const m of Object.values(models)) {
    let modelUrl = null;
    try { modelUrl = await storage.signedUrl(m.modelPath, 3600); } catch (e) { /* listed without the viewer */ }
    out.push({ ...m, modelUrl });
  }
  return out.sort((a, b) => String(a.product).localeCompare(String(b.product)));
}

function sign({ product }) {
  const s = slug(product);
  if (!s) throw fail(422, 'name the product the model is of', 'no_product');
  return storage.signedUploadUrl(`products/${s}/model-${Date.now().toString(36)}.glb`).then((u) => ({ ...u, maxBytes: MAX_BYTES }));
}

/** the first bytes of the stored upload must be a binary glTF ("glTF", version 2) */
async function isGlb(path) {
  const url = await storage.signedUrl(path, 300);
  const r = await fetchT(url, { headers: { Range: 'bytes=0-11' } }, { timeoutMs: 20000 });
  if (!r.ok) throw fail(r.status === 404 ? 404 : 502, `the uploaded model could not be read (${r.status})`);
  const b = Buffer.from(await r.arrayBuffer());
  return b.length >= 8 && b.toString('latin1', 0, 4) === 'glTF' && b.readUInt32LE(4) === 2;
}

async function save({ product, path, views, member }) {
  const s = slug(product);
  if (!s) throw fail(422, 'name the product the model is of', 'no_product');
  if (!new RegExp(`^products/${s}/model-[a-z0-9]+\\.glb$`).test(String(path || ''))) throw fail(422, 'path must be this product\'s model upload', 'bad_path');
  const refsBase = `${process.env.SUPABASE_URL}/storage/v1/object/public/refs/`;
  const vs = (Array.isArray(views) ? views : []).filter((v) => v && typeof v.url === 'string' && v.url.startsWith(refsBase)).slice(0, MAX_VIEWS)
    .map((v) => ({ angle: String(v.angle || 'view').slice(0, 40), url: v.url, ...(v.hero ? { hero: true } : {}) }));
  if (!vs.length) throw fail(422, 'the model needs at least one captured view', 'no_views');
  if (!vs.some((v) => v.hero)) vs[0].hero = true;
  if (!(await isGlb(path))) throw fail(422, 'that file is not a .glb model (export it from Blender as glTF Binary)', 'not_glb');
  const idx = await readIndex({ fresh: true });
  const prev = idx.models[s];
  idx.models[s] = { slug: s, product: String(product).trim().slice(0, 80), modelPath: path, views: vs, updatedAt: new Date().toISOString(), updatedBy: member ? member.name || member.email || member.id : 'unknown', ...(prev ? { replaced: (prev.replaced || 0) + 1 } : {}) };
  await writeIndex(idx);
  return idx.models[s];
}

/** add views to an existing model (an angle captured in the viewer) or replace the list (reorder, new hero, remove) */
async function setViews({ product, views }) {
  const s = slug(product);
  const idx = await readIndex({ fresh: true });
  const m = idx.models[s];
  if (!m) throw fail(404, 'no 3D model for that product', 'no_model');
  const refsBase = `${process.env.SUPABASE_URL}/storage/v1/object/public/refs/`;
  const vs = (Array.isArray(views) ? views : []).filter((v) => v && typeof v.url === 'string' && v.url.startsWith(refsBase)).slice(0, MAX_VIEWS)
    .map((v) => ({ angle: String(v.angle || 'view').slice(0, 40), url: v.url, ...(v.hero ? { hero: true } : {}) }));
  if (!vs.length) throw fail(422, 'keep at least one view', 'no_views');
  if (!vs.some((v) => v.hero)) vs[0].hero = true;
  m.views = vs; m.updatedAt = new Date().toISOString();
  await writeIndex(idx);
  return m;
}

async function remove({ product }) {
  const s = slug(product);
  const idx = await readIndex({ fresh: true });
  if (!idx.models[s]) throw fail(404, 'no 3D model for that product', 'no_model');
  delete idx.models[s];
  await writeIndex(idx);
  return { removed: s };
}

const _reset = () => { cache = null; };
module.exports = { slug, match, refsFor, renderRefs, list, sign, save, setViews, remove, MAX_BYTES, REFS_PER_RENDER, _reset };
