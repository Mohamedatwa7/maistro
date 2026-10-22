// /api/monitor — Phase 12 O4 (RUNBOOK.md). The hourly cron runs every check and raises / resolves ops_alerts;
// a signed-in GET lists the open alerts. Anything else is 401. Never cached.
const { isCron, requireSession } = require('../_auth.js');
const { queryRows, insertRows, patchRows } = require('../_supabase.js');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  try {
    if (isCron(req)) return res.status(200).json(await require('../_ops/monitor.js').run({ queryRows, insertRows, patchRows }));
    if (!requireSession(req, res)) return;
    const open = await queryRows('ops_alerts', 'select=id,at,kind,severity,message,sent_at&resolved_at=is.null&order=at.desc&limit=200');
    return res.status(200).json({ open });
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
};
