const { requireSession } = require('../_auth.js');
const hf = require('../_adapters/higgsfield.js');
// Studio Create — Higgsfield generation proxy (legacy direct path; the job
// service in api/_jobs.js is the M3 path and shares the adapter).
// POST {kind:'video'|'image', prompt, ...} → {request_id, status, v?}
// GET ?id=<request_id>[&v=1] → {status, video, images, raw_status}
module.exports = async (req, res) => {
  // Phase 11 (F-E): no open CORS on a cookie-gated route — the page is same-origin
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireSession(req, res)) return;
  const creds = process.env.HF_CREDENTIALS;
  if (!creds || !creds.includes(':')) return res.status(503).json({ error: 'HF_CREDENTIALS is not configured' });
  try {
    if (req.method === 'GET') {
      const id = (req.query && req.query.id) || '';
      if (!/^[\w-]{8,64}$/.test(id)) return res.status(400).json({ error: 'invalid id' });
      const st = await hf.status(id, (req.query && req.query.v) === '1' ? 1 : 0);
      return res.status(200).json(st);
    }
    if (req.method === 'POST') {
      const key = String((req.headers && req.headers['idempotency-key']) || '').trim() || require('node:crypto').randomUUID();
      const sub = await hf.submit(req.body || {}, { idempotencyKey: key });
      return res.status(200).json({ request_id: sub.ref, status: sub.status, ...(sub.v ? { v: sub.v } : {}) });
    }
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    return res.status(status).json({ error: e.message || 'higgsfield request failed', ...(e && e.detail !== undefined ? { detail: e.detail } : {}) });
  }
};
