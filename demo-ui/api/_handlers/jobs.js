// /api/jobs — the job service seen from outside (M3, ADR-004).
//
//   POST { pieceId, stage, kind, payload, piece? }  (session)
//        → 200 { ok, job }   the row is created, the stage set generating
//                            (renders), and one submit attempted inline
//        → 409 { code }      prerequisites | approved_immutable | not_ready…
//   GET  ?id=<job id>        (session) → { job }   — advances the job if due,
//                            so a page that polls also drives it
//   GET  ?piece=<legacy id>  (session) → { count, jobs } — reconcile-on-open
//   GET  ?asset=<assets path> (session) → { url, expiresIn } — a 1-hour signed
//                            URL for a stored render or heatmap (ADR-006)
//   GET  (cron, CRON_SECRET) → the tick: advance every due job
const { requireSession, refreshMember, isCron } = require('../_auth.js');
const { KINDS, createJob, getJob, advance, tick, jobsForPiece, publicJob } = require('../_jobs.js');
const { StoreError } = require('../_store.js');
const storage = require('../_adapters/storage.js');
const ASSET_PATH = /^pieces\/[a-zA-Z0-9_-]{3,64}\/(mood|thumb|board|draft|final)\/[a-z0-9-]+\.(png|jpg|webp|mp4|webm|mov|bin)$/;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(503).json({ error: 'storage is not configured' });
  try {
    if (req.method === 'GET' && isCron(req)) {
      const out = await tick();
      return res.status(200).json({ ok: true, ...out, at: new Date().toISOString() });
    }
    if (!requireSession(req, res)) return;
    const qs = req.query || {};
    if (req.method === 'GET') {
      if (qs.id) {
        const job = await getJob(String(qs.id));
        if (!job) return res.status(404).json({ error: 'job not found' });
        if (['queued', 'running'].includes(job.state)) await advance(job).catch(() => null);
        return res.status(200).json({ job: publicJob((await getJob(job.id)) || job) });
      }
      if (qs.piece) {
        const jobs = await jobsForPiece(String(qs.piece));
        return res.status(200).json({ count: jobs.length, jobs });
      }
      if (qs.asset) {
        const path = String(qs.asset);
        if (!ASSET_PATH.test(path)) return res.status(422).json({ error: 'asset must be a stored piece asset path' });
        return res.status(200).json({ url: await storage.signedUrl(path, 3600), expiresIn: 3600 });
      }
      return res.status(400).json({ error: 'id or piece is required' });
    }
    if (!(await refreshMember(req, res))) return;
    const b = req.body || {};
    if (!KINDS.includes(b.kind)) return res.status(400).json({ error: `kind must be one of ${KINDS.join(', ')}` });
    const job = await createJob({ legacyId: String(b.pieceId || ''), stage: String(b.stage || ''), kind: b.kind, payload: b.payload || {}, piece: b.piece || {}, member: req.member });
    return res.status(200).json({ ok: true, job });
  } catch (e) {
    if (e instanceof StoreError) return res.status(e.status).json({ error: e.message, code: e.code });
    const status = e && e.status ? e.status : 502;
    return res.status(status).json({ error: String((e && e.message) || e) });
  }
};
