// /api/kb — the knowledge base (Phase 6.1): brand knowledge, product
// catalog, market context, platform specs, rejection taxonomy. Versioned,
// editable by the owner, read by every prompt.
//
//   GET  ?kind=&key=      (session)  → { count, documents } (active versions; filters optional)
//   PUT  { kind, key, content, note? } (admin) → { ok, document } (new version)
//   POST { action: 'seed' }          (admin) → { ok, inserted, existing }
const { requireSession, requireRole } = require('../_auth.js');
const { activeDocuments, putDocument, seedMissing } = require('../_kb/index.js');

const KINDS = ['brand_kb', 'product_catalog', 'market_context', 'platform_specs', 'rejection_taxonomy'];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'PUT', 'POST'].includes(req.method)) { res.setHeader('Allow', 'GET, PUT, POST'); return res.status(405).json({ error: 'method not allowed' }); }
  try {
    if (req.method === 'GET') {
      if (!requireSession(req, res)) return;
      const q = req.query || {};
      let docs = await activeDocuments({ force: q.fresh === '1' });
      if (q.kind) docs = docs.filter((d) => d.kind === q.kind);
      if (q.key) docs = docs.filter((d) => d.key === q.key);
      return res.status(200).json({ count: docs.length, seeded: docs.some((d) => d.seeded), documents: docs });
    }
    if (!(await requireRole(req, res, ['admin']))) return;
    const b = req.body || {};
    if (req.method === 'POST') {
      if (b.action !== 'seed') return res.status(400).json({ error: 'action must be "seed"' });
      return res.status(200).json({ ok: true, ...(await seedMissing()) });
    }
    if (!KINDS.includes(b.kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
    if (!/^[A-Za-z0-9 _.+-]{1,80}$/.test(String(b.key || ''))) return res.status(400).json({ error: 'key is required' });
    if (!b.content || typeof b.content !== 'object' || Array.isArray(b.content)) return res.status(422).json({ error: 'content must be an object' });
    if (Buffer.byteLength(JSON.stringify(b.content), 'utf8') > 256 * 1024) return res.status(413).json({ error: 'content larger than 256 KB' });
    const document = await putDocument({ kind: b.kind, key: String(b.key), content: b.content, note: b.note, source: b.source || `edit by ${req.member.email}`, memberId: req.member.id });
    return res.status(200).json({ ok: true, document });
  } catch (e) {
    return res.status(e && e.status ? e.status : 502).json({ error: String((e && e.message) || e) });
  }
};
