#!/usr/bin/env node
// One-command local run on seeded fakes: `npm run local` (README "Run it locally").
//
// Serves index.html and every /api/<route> from this checkout against in-memory doubles, so a new engineer can click
// through the product with no keys and no network:
// - the Maistro database is the test suite's fake PostgREST (tests/fake-postgrest.js), empty at start;
// - the tracker serves the recorded 14-day fixture (tests/fixtures/track-14d.json), dates shifted to end yesterday;
// - Trend Radar serves the recorded agent feed (tests/fixtures/agent-trends.json).
// Anthropic, Higgsfield, F1X8, storage and Sprinklr are NOT faked. Their calls get a 503 that names the host, and
// MAISTRO_NO_RENDER=1 is forced, so nothing paid can run from here. Nothing leaves the machine.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const PASSWORD = 'local';

// Fake hosts only; real keys in the shell are ignored (a local run must never reach production data)
Object.assign(process.env, {
  SUPABASE_URL: 'https://maistro.local', SUPABASE_SERVICE_ROLE_KEY: 'local',
  TRACK_SUPABASE_URL: 'https://tracker.local', TRACK_SUPABASE_KEY: 'local',
  TRENDRADAR_BASE_URL: 'https://trendradar.local', TRENDRADAR_AGENT_KEY: 'local',
  MAISTRO_SESSION_SECRET: 'local-session', MAISTRO_APP_PASSWORD: PASSWORD,
  MAISTRO_INGEST_KEY: 'local-ingest', CRON_SECRET: 'local-cron', MAISTRO_NO_RENDER: '1',
  MAISTRO_REVISION: 'local',
});
for (const k of ['ANTHROPIC_API_KEY', 'HF_CREDENTIALS', 'MAISTRO_DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_ANON_KEY',
  'SPRINKLR_API_KEY', 'SPRINKLR_API_SECRET', 'SPRINKLR_ENV', 'MAISTRO_ALERT_WEBHOOK', 'MAISTRO_F1X8_BASE_URL']) delete process.env[k];

const { fakePostgrest } = require('../tests/fake-postgrest.js');
const db = fakePostgrest(process.env.SUPABASE_URL);

// ---- the tracker, from the recorded fixture ----
const track = require('../tests/fixtures/track-14d.json');
const newest = Math.max(...track.posts.map((p) => Date.parse(p.postedAt)));
const shift = Date.now() - 864e5 - newest;
const at = (s) => (s ? new Date(Date.parse(s) + shift).toISOString() : null);
const SENT = { pos: 'positive', neu: 'neutral', neg: 'negative' };
const posts = track.posts.map((p) => {
  const owner = p.account || 'samsunggulf';
  return {
    external_id: p.postId, platform: p.platform === 'x' ? 'twitter' : p.platform, post_url: p.url, caption: p.caption,
    media_type: p.mediaType, media_url: null, likes_count: p.metrics.likes, comments_count: p.metrics.comments,
    shares_count: p.metrics.shares, views_count: p.metrics.views, published_at: at(p.postedAt),
    owner_ig: owner, owner_tt: owner, owner_x: owner, owner_fb: owner, thumb_url: p.metrics.thumb || null,
  };
});
let cid = 0;
const comments = track.posts.flatMap((p) => p.comments.map((c) => ({
  id: ++cid, external_id: `c${cid}`, external_post_id: p.postId, platform: p.platform === 'x' ? 'twitter' : p.platform,
  author_username: c.author, text: c.text, sentiment: SENT[c.sentiment] || null, likes_count: c.likes, published_at: at(c.at),
})));
function tracker(url) {
  const u = new URL(url);
  const table = u.pathname.replace(/^\/rest\/v1\//, '');
  const q = u.search;
  let rows = [];
  if (table === 'social_posts' && !q.includes('published_at=lt.')) {
    const plat = (q.match(/platform=eq\.([a-z]+)/) || [])[1];
    rows = posts.filter((p) => !plat || p.platform === plat);
    const ids = [...q.matchAll(/external_id\.eq\.([^,)]+)/g)].map((m) => decodeURIComponent(m[1]));
    if (ids.length) rows = rows.filter((p) => ids.includes(p.external_id));
  } else if (table === 'social_comments' && !q.includes('or=(published_at.lt')) {
    const inIds = (decodeURIComponent(q).match(/external_post_id=in\.\(([^)]*)\)/) || [])[1];
    rows = inIds ? comments.filter((c) => inIds.split(',').includes(c.external_post_id)) : comments;
  }
  return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json', 'content-range': `0-${Math.max(0, rows.length - 1)}/${rows.length}` } });
}

const agentFeed = fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'agent-trends.json'), 'utf8');
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input && input.url ? input.url : input);
  if (url.startsWith(db.base + '/rest/v1/')) return db.handler(url, init);
  if (url.startsWith('https://tracker.local/rest/v1/')) return tracker(url);
  if (url.startsWith('https://trendradar.local/api/agent/trends')) return new Response(agentFeed, { status: 200, headers: { 'content-type': 'application/json' } });
  let host = url; try { host = new URL(url).host; } catch (e) { /* keep the raw string */ }
  return new Response(JSON.stringify({ error: `not available in local mode: ${host}`, local: true }), { status: 503, headers: { 'content-type': 'application/json' } });
};
void realFetch; // kept so nobody re-enables the network by accident; see the comment above

// ---- a Vercel-shaped request/response around the dispatcher ----
const dispatch = require('../api/[route].js');
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (!raw.length) return resolve(undefined);
      if (String(req.headers['content-type'] || '').includes('application/json')) { try { return resolve(JSON.parse(raw.toString('utf8'))); } catch (e) { return resolve(raw.toString('utf8')); } }
      resolve(raw.toString('utf8'));
    });
  });
}
function wrap(res) {
  res.status = (s) => { res.statusCode = s; return res; };
  res.json = (b) => { if (!res.getHeader('content-type')) res.setHeader('content-type', 'application/json; charset=utf-8'); res.end(JSON.stringify(b)); return res; };
  res.send = (b) => { res.end(typeof b === 'string' || Buffer.isBuffer(b) ? b : JSON.stringify(b)); return res; };
  return res;
}

const server = http.createServer(async (req, res) => {
  wrap(res);
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const m = u.pathname.match(/^\/api\/([a-z0-9-]+)\/?$/);
  try {
    if (m) {
      const query = Object.fromEntries(u.searchParams); query.route = m[1];
      const body = await readBody(req);
      await dispatch({ method: req.method, url: req.url, headers: req.headers, query, body }, res);
      if (!res.writableEnded) res.end();
    } else if (req.method === 'GET') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(fs.readFileSync(path.join(ROOT, 'index.html')));
    } else res.status(405).json({ error: 'GET only' });
  } catch (e) {
    console.error('[local]', e);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});
server.listen(PORT, () => {
  console.log(`Maistro (local, seeded fakes) on http://localhost:${server.address().port}  password: ${PASSWORD}`);
  console.log('Fakes: Maistro DB (in memory, empty), tracker (recorded 14 days), Trend Radar (recorded feed).');
  console.log('Not available locally: Anthropic, Higgsfield (MAISTRO_NO_RENDER=1), F1X8, storage, Sprinklr, member e-mail sign-in.');
});
module.exports = { server };
