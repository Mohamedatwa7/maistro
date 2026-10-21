// Shared harness for the demo-ui tests (node:test, zero dependencies).
//
// - api(): load a serverless handler fresh (module cache cleared) with a given env.
// - mockFetch(): route outbound fetch calls to canned responses and record them.
// - req()/res(): minimal Vercel-style request/response doubles.
// - loadPage(): evaluate index.html's script in a DOM-stub sandbox (same stubs
//   as .smoke-test.js) and expose the page's functions/state for golden tests.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const FIXTURES = path.join(__dirname, 'fixtures');

function fixture(name) {
  const p = path.join(FIXTURES, name);
  const raw = fs.readFileSync(p, 'utf8');
  return name.endsWith('.json') ? JSON.parse(raw) : raw;
}

// Every handler test runs with a valid interim session unless it opts out
// (session: false) — the gate itself is tested in login.test.js.
const TEST_SESSION_SECRET = 'test-session';
function sessionCookie(secret = TEST_SESSION_SECRET, nowMs = Date.now()) {
  const { makeSessionCookieValue, SESSION_COOKIE } = require(path.join(ROOT, 'api', '_auth.js'));
  return `${SESSION_COOKIE}=${makeSessionCookieValue(secret, nowMs)}`;
}
function req({ method = 'GET', body, query = {}, headers = {}, session = true } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (session && !h.cookie) h.cookie = sessionCookie();
  return { method, body, query, headers: h };
}

function res() {
  const r = { statusCode: 200, headers: {}, body: undefined, ended: false };
  r.setHeader = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.status = (s) => { r.statusCode = s; return r; };
  r.json = (b) => { r.body = b; r.ended = true; return r; };
  r.end = () => { r.ended = true; return r; };
  return r;
}

// Load a handler with a controlled environment. Keys set to undefined are deleted.
function api(file, env = {}) {
  env = { MAISTRO_SESSION_SECRET: TEST_SESSION_SECRET, ...env };
  const saved = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  const abs = path.join(ROOT, 'api', file.startsWith('_') || file.startsWith('[') ? file : path.join('_handlers', file));
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(ROOT, 'api'))) delete require.cache[k];
  const handler = require(abs);
  const restore = () => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  return { handler, restore };
}

// routes: array of [matcher(url, init) => boolean | RegExp | string, responder(url, init) => Response | object]
// A plain object responder becomes a 200 JSON response; a Response is used as is.
function mockFetch(routes) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    for (const [m, responder] of routes) {
      const hit = typeof m === 'function' ? m(url, init) : m instanceof RegExp ? m.test(url) : url.includes(m);
      if (!hit) continue;
      const out = typeof responder === 'function' ? await responder(url, init) : responder;
      if (out instanceof Response) return out;
      return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('unmocked fetch: ' + url);
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const text = (body, status = 200, headers = {}) => new Response(body, { status, headers });

// Anthropic Messages API double: returns one text block containing `payload` as JSON.
const anthropicReply = (payload) => json({
  id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-4-8',
  content: [{ type: 'text', text: JSON.stringify(payload) }],
  stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 },
});

// ---- page harness ----
// Golden tests must not drift with the wall clock: `now` freezes Date for the page.
const FROZEN_NOW = '2026-10-21T10:00:00.000Z';
function loadPage({ fetchImpl, hash = '#/', now = FROZEN_NOW } = {}) {
  const RealDate = Date;
  const fixed = new RealDate(now).getTime();
  class FrozenDate extends RealDate {
    constructor(...a) { super(...(a.length ? a : [fixed])); }
    static now() { return fixed; }
  }
  globalThis.Date = FrozenDate;
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/<script>([\s\S]*)<\/script>/);
  if (!m) throw new Error('no script block in index.html');
  const noop = () => {};
  const ctxStub = new Proxy({}, { get: (t, k) => (k === 'canvas' ? { width: 1200, height: 800 } : noop), set: () => true });
  const elStub = () => ({
    classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, appendChild: noop, style: {}, dataset: {},
    getContext: () => ctxStub, innerHTML: '', textContent: '', value: '',
    width: 0, height: 0, clientWidth: 1200, clientHeight: 800,
    querySelectorAll: () => [], querySelector: () => null, focus: noop,
    getBoundingClientRect: () => ({ width: 1200, height: 800 }),
    parentElement: { getBoundingClientRect: () => ({ width: 1200, height: 800 }), clientHeight: 800 },
  });
  const view = elStub();
  const g = globalThis;
  const saved = {};
  const set = (k, v) => { saved[k] = g[k]; g[k] = v; };
  set('document', {
    querySelector: (s) => (s === '#view' ? view : elStub()), querySelectorAll: () => [],
    getElementById: () => null, createElement: elStub, addEventListener: noop,
    body: { classList: { add: noop, remove: noop, toggle: noop, contains: () => false } },
    head: { appendChild: noop },
  });
  set('window', g);
  set('location', { hash, href: '', origin: 'https://www.ma1stro.com', pathname: '/', search: '' });
  set('history', { replaceState: noop });
  set('addEventListener', noop); set('removeEventListener', noop);
  set('requestAnimationFrame', () => 0); set('cancelAnimationFrame', noop);
  set('Image', class { constructor() { this.complete = false; } addEventListener() {} });
  set('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
  set('localStorage', { getItem: () => null, setItem: noop, removeItem: noop });
  set('innerHeight', 800); set('scrollY', 0); set('scrollTo', noop);
  set('setInterval', () => 0); set('clearInterval', noop);
  set('fetch', fetchImpl || (() => new Promise(() => {})));
  const exportsList = 'CAL,rHome,rCalendar,rTrends,rStudio,rPerformance,rCopilot,STATE,TRENDS,PROJECTS,DELIVS,STAGES,SENTI,loadSentiment,sentiCompose,sentiDedupe,sentiFoldAcross,allComments,docLabel,pfPosts,pfStats,pfState,attachTo,delivTitle,syncStage,applyServerPieces,storeProducer,storeMeta,storeArtifact,SYNC,recordDecision,useJobs,jobPoll,qcJobPoll,POLL_MS,SCORED,rScoredBoard,scoredList,loadScored,KB,rejectOptions,loadKb,rMoodSet,CHECKS,rThumbCover,thumbAspectFor,mediaAttrs,qcAssets,hydrateAssets,ASSET_URLS,QCRUN,QCHEAT,AUTH,authFromHash,requestMagicLink,exchangeToken,qcFixes,genCtx,radarToTrend,cpTrendPayload,cpPayloadFromText,esc,fmt,pct,stageArtifact,BOT_STAGE_IDX,GEN,QCRUN';
  let X;
  try {
    X = eval(m[1] + `\n;({${exportsList}})`); // eslint-disable-line no-eval
  } finally {
    // keep globals in place for the returned functions, but allow restore()
  }
  X.view = view;
  X.restore = () => { globalThis.Date = RealDate; for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete g[k]; else g[k] = v; } };
  return X;
}

module.exports = { ROOT, FIXTURES, fixture, req, res, api, mockFetch, json, text, anthropicReply, loadPage, sessionCookie, TEST_SESSION_SECRET };
