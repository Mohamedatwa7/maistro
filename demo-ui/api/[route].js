// One Vercel function for every legacy endpoint (M2).
//
// Why: the project runs on Vercel's Hobby plan, which caps a deployment at
// 12 serverless functions, and the twelve legacy endpoints used all of them —
// the first new route of the Next.js shell could not deploy. The handlers
// themselves are unchanged in api/_handlers/ (underscored paths are not
// functions); this file maps /api/<route> onto them, so every URL, status
// code and response shape stays exactly as the characterization tests lock
// it. Unknown routes are 404, never a stack trace.
const ROUTES = {
  trends: 'trends',
  hermes: 'hermes',
  director: 'director',
  higgsfield: 'higgsfield',
  'qc-f1x8': 'qc-f1x8',
  ingest: 'ingest',
  projects: 'projects',
  sentiment: 'sentiment',
  track: 'track',
  upload: 'upload',
  translate: 'translate',
  login: 'login',
  health: 'health',
  pieces: 'pieces',
  decisions: 'decisions',
  members: 'members',
  jobs: 'jobs',
  kb: 'kb',
  studio: 'studio',
  monitor: 'monitor',
  thumb: 'thumb',
  moments: 'moments',
  agent: 'agent',
};

module.exports = async (req, res) => {
  const name = String((req.query && req.query.route) || '');
  const file = Object.prototype.hasOwnProperty.call(ROUTES, name) ? ROUTES[name] : null;
  if (!file) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ error: `unknown route /api/${name}` });
  }
  // The handlers read query params by name; `route` is ours, not theirs.
  if (req.query) delete req.query.route;
  if (viewOnlyRefusal(req, name)) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(403).json({ error: 'This account is view-only — it is not permitted to generate or change content.', code: 'not_permitted' });
  }
  const handler = require(`./_handlers/${file}.js`);
  return handler(req, res);
};

// A view-only account (api/_accounts.js, role viewer) may read everything but never write:
// any non-GET call except signing in/out is refused before it reaches a handler.
function viewOnlyRefusal(req, name) {
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || name === 'login') return false;
  const secret = process.env.MAISTRO_SESSION_SECRET;
  if (!secret) return false;
  const { readSession } = require('./_auth.js');
  const s = readSession((req.headers || {}).cookie, secret);
  const { VIEW_ONLY_ROLES } = require('./_accounts.js');
  return Boolean(s && s.member && VIEW_ONLY_ROLES.includes(s.member.role));
}

module.exports.ROUTES = ROUTES;
