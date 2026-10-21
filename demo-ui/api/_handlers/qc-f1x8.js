const { requireSession } = require('../_auth.js');
const f1x8 = require('../_adapters/f1x8.js');
// Quality Check — real F1X8 proxy (legacy direct path; the job service in
// api/_jobs.js is the M3 path and shares the adapter, SSRF guard included).
// POST {kind:'image'|'video', assetUrl, title, description} → {job_id}
// GET ?job=<job_id> → {status: fetching|analyzing|done|error|not_found, result?}
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireSession(req, res)) return;
  try {
    if (req.method === 'GET') {
      const id = (req.query && req.query.job) || '';
      if (!/^[\w-]{4,80}$/.test(id)) return res.status(400).json({ error: 'invalid job id' });
      return res.status(200).json(await f1x8.status(id));
    }
    if (req.method === 'POST') {
      const b = req.body || {};
      const sub = await f1x8.submit({ kind: b.kind, assetUrl: String(b.assetUrl || ''), title: b.title, description: b.description });
      return res.status(200).json({ job_id: sub.ref });
    }
    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    return res.status(status).json({ error: e.message || 'F1X8 proxy failed' });
  }
};

module.exports.assetHostAllowed = f1x8.assetHostAllowed; // exposed for tests
