// Sprinklr API v3 client (ADR-008), built from the vendored spec docs/vendor/sprinklr-v3-publishing.json — no
// guessed endpoints. Drafts only: the client can verify credentials, create and read drafts, render a preview and
// read posts. Scheduling and publishing (POST /publishing/draft/schedule, POST /publishing/post, /publishing/message,
// /publishing/reply) are not on the allowlist, so nothing Maistro does can put a post live on an account; a person
// schedules the draft inside Sprinklr.
const ENVS = ['prod', 'prod0', 'prod2', 'prod3', 'prod4', 'prod5', 'prod6', 'prod8', 'prod11', 'prod12', 'prod15', 'prod16', 'prod17', 'prod18', 'prod19', 'prod21', 'prod25'];
const ALLOWED = new Set(['GET /me', 'POST /publishing/draft', 'GET /publishing/draft', 'GET /publishing/preview/generate', 'GET /publishing/preview/status', 'GET /publishing/post']);
const TIMEOUT_MS = 20000;

const fail = (status, code, message, extra) => Object.assign(new Error(message), { status, code, ...extra });
function config() {
  const env = String(process.env.SPRINKLR_ENV || '').trim();
  const key = process.env.SPRINKLR_API_KEY, token = process.env.SPRINKLR_ACCESS_TOKEN;
  return { env, key, token, configured: Boolean(key && token && ENVS.includes(env)) };
}
const base = (env) => `https://api3.sprinklr.com/${env}/api/v3`;

async function call(method, path, { query, body } = {}) {
  if (!ALLOWED.has(`${method} ${path}`)) throw fail(403, 'sprinklr_call_blocked', `${method} ${path} is not allowed: Maistro creates drafts only and never schedules or publishes`);
  const c = config();
  if (!c.configured) throw fail(503, 'sprinklr_not_configured', 'Sprinklr is not configured (SPRINKLR_API_KEY, SPRINKLR_ACCESS_TOKEN and a valid SPRINKLR_ENV)');
  const qs = query ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null)).toString() : '';
  const r = await fetch(base(c.env) + path + qs, {
    method,
    headers: { authorization: `Bearer ${c.token}`, key: c.key, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const raw = await r.text();
  let data = raw; try { data = raw ? JSON.parse(raw) : null; } catch (e) { /* plain-text body */ }
  if (!r.ok) {
    const first = data && Array.isArray(data.errors) && data.errors[0];
    throw fail(r.status === 401 || r.status === 403 ? r.status : 502, 'sprinklr_error', `Sprinklr ${method} ${path} answered ${r.status}${first && first.message ? `: ${first.message}` : ''}`, { upstreamStatus: r.status });
  }
  return data;
}

/** A Sprinklr response is either the value or { data, errors } (spec ApiResponse); unwrap it. */
const unwrap = (d) => (d && typeof d === 'object' && !Array.isArray(d) && 'data' in d ? d.data : d);

const me = async () => unwrap(await call('GET', '/me'));
/** returns the draft id (the spec's 200 body is a string) */
async function createDraft(message) {
  const d = unwrap(await call('POST', '/publishing/draft', { body: message }));
  const id = typeof d === 'string' || typeof d === 'number' ? String(d) : d && d.id != null ? String(d.id) : null;
  if (!id) throw fail(502, 'sprinklr_error', 'Sprinklr created no draft id');
  return id;
}
async function getDraft(id) { const d = unwrap(await call('GET', '/publishing/draft', { query: { id } })); return Array.isArray(d) ? d[0] || null : d; }
/** returns the preview request id, read back with previewStatus() */
async function previewGenerate(messageId) { const d = unwrap(await call('GET', '/publishing/preview/generate', { query: { messageId, exportType: 'PNG', name: `maistro-${messageId}` } })); return typeof d === 'string' ? d : d && d.id != null ? String(d.id) : null; }
async function previewStatus(id) { const d = unwrap(await call('GET', '/publishing/preview/status', { query: { id } })); return { id: d && d.id ? String(d.id) : id, status: (d && d.status) || null, url: (d && d.url) || null }; }
async function getPosts(ids) { const d = unwrap(await call('GET', '/publishing/post', { query: { id: [].concat(ids).slice(0, 50).join(',') } })); return [].concat(d || []); }

module.exports = { ENVS, ALLOWED, config, call, me, createDraft, getDraft, previewGenerate, previewStatus, getPosts };
