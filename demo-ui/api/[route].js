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
  const handler = require(`./_handlers/${file}.js`);
  return handler(req, res);
};

module.exports.ROUTES = ROUTES;
