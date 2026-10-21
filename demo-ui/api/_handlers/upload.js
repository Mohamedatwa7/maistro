const crypto = require('crypto');
const { fetchT } = require('../_http.js');
const { requireSession } = require('../_auth.js');
// POST /api/upload — two kinds of object:
//   (default) a product reference photo → public bucket "refs", returns its public URL.
//             The client downsizes the image to ≤1600px JPEG before sending.
//   kind "document" → an approval document (line-manager or ADLCP sign-off) →
//             PRIVATE bucket "approvals"; returns {path, sha256, size, contentType,
//             name, at} and never a public URL (AUDIT A-02 interim, ADR-006).
// GET /api/upload?path=<approvals path> — a 10-minute signed URL for a session
//             holder to open a stored document.
// Body: { data: <base64 (no data: prefix)>, contentType, kind?, name? }
const DOC_TYPES = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'message/rfc822': 'eml', 'application/vnd.ms-outlook': 'msg' };
const DOC_MAX = 3 * 1024 * 1024; // Vercel caps request bodies at 4.5 MB; base64 adds a third
const DOC_BUCKET = 'approvals';
const SIGN_TTL_S = 600;
const DOC_PATH = /^documents\/\d{4}\/[a-z0-9]+-[a-z0-9]{6}\.[a-z]{3,4}$/;

const sbHeaders = (key, extra = {}) => ({ apikey: key, Authorization: `Bearer ${key}`, ...extra });

async function ensureBucket(base, key, id, isPublic) {
  // 409 = already there
  await fetchT(`${base}/storage/v1/bucket`, {
    method: 'POST', headers: sbHeaders(key, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ id, name: id, public: isPublic }),
  }, { timeoutMs: 10000 }).catch(() => {});
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST' && req.method !== 'GET') {
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!requireSession(req, res)) return;
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return res.status(503).json({ error: 'storage is not configured' });

  try {
    if (req.method === 'GET') {
      const path = String((req.query || {}).path || '');
      if (!DOC_PATH.test(path)) return res.status(422).json({ error: 'path must be a stored approval document' });
      const r = await fetchT(`${base}/storage/v1/object/sign/${DOC_BUCKET}/${path}`, {
        method: 'POST', headers: sbHeaders(key, { 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn: SIGN_TTL_S }),
      }, { timeoutMs: 10000 });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.signedURL) return res.status(r.status === 404 ? 404 : 502).json({ error: `sign failed (${r.status}) ${String(j.message || j.error || '').slice(0, 160)}` });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ url: `${base}/storage/v1${j.signedURL}`, expiresIn: SIGN_TTL_S });
    }

    const b = req.body || {};
    const data = String(b.data || '');
    if (!data) return res.status(422).json({ error: 'data (base64) is required' });
    const buf = Buffer.from(data, 'base64');

    if (b.kind === 'document') {
      const contentType = String(b.contentType || '');
      const ext = DOC_TYPES[contentType];
      if (!ext) return res.status(422).json({ error: `contentType must be one of ${Object.keys(DOC_TYPES).join(', ')}` });
      if (!buf.length || buf.length > DOC_MAX) return res.status(413).json({ error: 'document must be under 3 MB' });
      const name = String(b.name || '').replace(/[\u0000-\u001f]/g, '').slice(0, 160) || `document.${ext}`;
      const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
      const at = new Date().toISOString();
      const path = `documents/${at.slice(0, 4)}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      await ensureBucket(base, key, DOC_BUCKET, false);
      const up = await fetchT(`${base}/storage/v1/object/${DOC_BUCKET}/${path}`, {
        method: 'POST', headers: sbHeaders(key, { 'Content-Type': contentType, 'x-upsert': 'false' }), body: buf,
      }, { timeoutMs: 30000 });
      if (!up.ok) {
        const t = await up.text().catch(() => '');
        return res.status(502).json({ error: `upload failed (${up.status}) ${t.slice(0, 160)}` });
      }
      return res.status(200).json({ path, sha256, size: buf.length, contentType, name, at });
    }

    if (!buf.length || buf.length > 4 * 1024 * 1024) {
      return res.status(413).json({ error: 'image must be under 4MB — it is resized client-side, try a smaller photo' });
    }
    const contentType = /^image\/(jpeg|png|webp)$/.test(b.contentType) ? b.contentType : 'image/jpeg';
    const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
    const path = `products/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    await ensureBucket(base, key, 'refs', true);
    const up = await fetchT(`${base}/storage/v1/object/refs/${path}`, {
      method: 'POST', headers: sbHeaders(key, { 'Content-Type': contentType, 'x-upsert': 'true' }), body: buf,
    }, { timeoutMs: 30000 });
    if (!up.ok) {
      const t = await up.text().catch(() => '');
      return res.status(502).json({ error: `upload failed (${up.status}) ${t.slice(0, 160)}` });
    }
    return res.status(200).json({ url: `${base}/storage/v1/object/public/refs/${path}` });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'upload failed' });
  }
};
