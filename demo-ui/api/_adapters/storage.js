// Supabase Storage adapter (ADR-006): copy a finished provider asset into
// the PRIVATE `assets` bucket with its sha-256, and sign read URLs. The
// buckets exist from migration 006; the create call is a no-op (409).
const crypto = require('node:crypto');
const { fetchT } = require('../_http.js');
const { fetchAsset } = require('./f1x8.js');

const ASSETS_BUCKET = 'assets';
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };

function cfg() {
  const url = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw Object.assign(new Error('storage is not configured'), { status: 503 });
  return { url, key, headers: { apikey: key, Authorization: `Bearer ${key}` } };
}

/** Download `sourceUrl` (allow-listed media hosts only) and store it at
 *  assets/<prefix>/<id>.<ext>. Returns { path, sha256, size, contentType }. */
async function copyIn(sourceUrl, prefix, fallbackType) {
  const c = cfg();
  const { buf, contentType } = await fetchAsset(sourceUrl, 200 * 1024 * 1024);
  const type = EXT[contentType] ? contentType : (fallbackType || 'application/octet-stream');
  const ext = EXT[type] || 'bin';
  const bytes = Buffer.from(buf);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const path = `${String(prefix).replace(/[^a-zA-Z0-9_\/-]/g, '_')}/${Date.now().toString(36)}-${sha256.slice(0, 12)}.${ext}`;
  const up = await fetchT(`${c.url}/storage/v1/object/${ASSETS_BUCKET}/${path}`, {
    method: 'POST', headers: { ...c.headers, 'Content-Type': type, 'x-upsert': 'true' }, body: bytes,
  }, { timeoutMs: 60000 });
  if (!up.ok) throw Object.assign(new Error(`asset copy failed (${up.status}) ${(await up.text().catch(() => '')).slice(0, 160)}`), { status: 502 });
  return { path, sha256, size: bytes.length, contentType: type };
}

/** A signed read URL for a stored asset (default 1 hour, ADR-006). */
async function signedUrl(path, expiresIn = 3600) {
  const c = cfg();
  const r = await fetchT(`${c.url}/storage/v1/object/sign/${ASSETS_BUCKET}/${path}`, {
    method: 'POST', headers: { ...c.headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn }),
  }, { timeoutMs: 10000 });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.signedURL) throw Object.assign(new Error(`sign failed (${r.status})`), { status: r.status === 404 ? 404 : 502 });
  return `${c.url}/storage/v1${j.signedURL}`;
}

/** Store a small blob (e.g. an F1X8 heatmap PNG as base64) → { path, sha256, size }. */
async function putBlob(path, bytes, contentType) {
  const c = cfg();
  const up = await fetchT(`${c.url}/storage/v1/object/${ASSETS_BUCKET}/${path}`, {
    method: 'POST', headers: { ...c.headers, 'Content-Type': contentType, 'x-upsert': 'true' }, body: bytes,
  }, { timeoutMs: 30000 });
  if (!up.ok) throw Object.assign(new Error(`blob store failed (${up.status})`), { status: 502 });
  return { path, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}

module.exports = { copyIn, signedUrl, putBlob, ASSETS_BUCKET };
