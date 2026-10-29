// GET /api/moments (session): the big occasions to plan around (api/_trends/moments.js).
//   upcoming: the planned calendar, under way or starting within ~5 months
//   breaking: what is spiking now in the Gulf (Google Trends) and on Wikipedia,
//             brand-checked by Claude; `hidden` lists what was screened out
// ?view=upcoming skips the live sources. Signed-in only, because a fresh read runs a
// paid Claude check: a warm instance reuses the last breaking read for 30 minutes
// (2 on a failure), and the browser may keep the answer for 15.
const moments = require('../_trends/moments.js');
const { requireSession } = require('../_auth.js');

const FRESH_MS = 30 * 60e3, FAILED_MS = 2 * 60e3;
let memo = null; // { at, breaking }

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }
  if (!requireSession(req, res)) return;
  const q = req.query || {};
  const now = new Date();
  const upcoming = moments.upcoming(now);
  let breaking = null;
  if (q.view !== 'upcoming') {
    if (memo && Date.now() - memo.at < (memo.breaking.error ? FAILED_MS : FRESH_MS)) breaking = memo.breaking;
    else {
      try { breaking = await moments.fetchBreaking({ now }); }
      catch (e) { breaking = { error: String(e.message || e), items: [], hidden: [], routine: 0, classifiedBy: 'none', errors: [] }; }
      memo = { at: Date.now(), breaking };
    }
  }
  res.setHeader('Cache-Control', breaking && breaking.error ? 'private, max-age=60' : 'private, max-age=900');
  return res.status(200).json({ at: now.toISOString(), upcoming, breaking });
};
