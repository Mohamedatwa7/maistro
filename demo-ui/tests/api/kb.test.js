// Phase 6.1: the knowledge base — seed equals today's prompts, versions are append-only,
// prompts read the active version, the route is gated.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json, anthropicReply } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');
const { seedDocuments, buildPrompts } = require('../../api/_kb/seed.js');
const kb = require('../../api/_kb/index.js');
const { PRODUCTS_PROMPT, BRAND_PROMPT, PRODUCT_CATALOG } = require('../../api/_brand.js');
const { makeSessionCookieValue, SESSION_COOKIE } = require('../../api/_auth.js');

const SB = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const adminCookie = () => `${SESSION_COOKIE}=${makeSessionCookieValue('test-session', Date.now(), undefined, { id: 'u-owner', email: 'owner@samsung.com', role: 'admin', name: 'Owner' })}`;

test('the seed reproduces today\'s prompts byte for byte and carries provenance and explicit gaps instead of invented facts', () => {
  const docs = seedDocuments();
  const p = buildPrompts(docs);
  assert.equal(p.PRODUCTS_PROMPT, PRODUCTS_PROMPT); assert.equal(p.BRAND_PROMPT, BRAND_PROMPT);
  assert.equal(docs.filter((d) => d.kind === 'product_catalog' && !d.key.startsWith('_')).length, PRODUCT_CATALOG.length);
  assert.ok(docs.every((d) => d.source && d.version === 1));
  const fold = docs.find((d) => d.kind === 'product_catalog' && d.key === 'Galaxy Z Fold8');
  assert.equal(fold.content.approvedClaims, null); assert.ok(fold.content.gaps.includes('approved claims with exact wording')); assert.equal(fold.content.captionMentions30d, 31);
  const tt = docs.find((d) => d.kind === 'platform_specs' && d.key === 'tiktok');
  assert.equal(tt.content.verified, false, 'no official page was fetched → unverified');
  const dd = docs.find((d) => d.kind === 'brand_kb' && d.key === 'do_dont');
  assert.ok(dd.content.gaps.some((g) => /disclaimers/.test(g)));
  const tax = docs.find((d) => d.kind === 'rejection_taxonomy');
  assert.ok(tax.content.byStage.final.includes('fix_not_applied'));
});

test('loader: seed fallback without a database; database documents win and are cached; an edit creates a new active version and deactivates the old one', async () => {
  kb.resetCache();
  const saved = { u: process.env.SUPABASE_URL, k: process.env.SUPABASE_SERVICE_ROLE_KEY };
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  try {
    let docs = await kb.activeDocuments();
    assert.ok(docs.every((d) => d.seeded)); assert.equal((await kb.brandPrompts()).BRAND_PROMPT, BRAND_PROMPT);
  } finally { process.env.SUPABASE_URL = saved.u; process.env.SUPABASE_SERVICE_ROLE_KEY = saved.k; }
  kb.resetCache();
  const pg = fakePostgrest();
  const f = mockFetch([pg.route]);
  process.env.SUPABASE_URL = 'https://sb.test'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  try {
    const r = await kb.seedMissing();
    assert.equal(r.inserted, seedDocuments().length); assert.equal((await kb.seedMissing()).inserted, 0, 'idempotent');
    let docs = await kb.activeDocuments();
    assert.ok(docs.every((d) => !d.seeded)); assert.equal((await kb.brandPrompts()).PRODUCTS_PROMPT, PRODUCTS_PROMPT, 'a seeded database changes nothing');
    const row = await kb.putDocument({ kind: 'brand_kb', key: 'essence', content: { text: 'CREATIVE ESSENCE — edited by the owner.' }, note: 'test edit', memberId: 'u-owner' });
    assert.equal(row.version, 2);
    const versions = pg.tables.kb_documents.filter((d) => d.kind === 'brand_kb' && d.key === 'essence');
    assert.deepEqual(versions.map((v) => [v.version, v.active]), [[1, false], [2, true]]);
    const p = await kb.brandPrompts();
    assert.match(p.BRAND_PROMPT, /edited by the owner/); assert.ok(!p.BRAND_PROMPT.includes('Refined Wit: unexpected'));
    const calls = pg.calls.length; await kb.activeDocuments(); assert.equal(pg.calls.length, calls, 'cached');
  } finally { f.restore(); if (saved.u === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = saved.u; if (saved.k === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = saved.k; kb.resetCache(); }
});

test('/api/kb: GET needs a session, PUT and seed need an admin member; validation; the director prompt follows the active version', async () => {
  kb.resetCache();
  const pg = fakePostgrest();
  (pg.tables.members = pg.tables.members || []).push({ id: 'u-owner', email: 'owner@samsung.com', role: 'admin', active: true });
  let seenSystem = '';
  const f = mockFetch([['api.anthropic.com', (u, init) => { seenSystem = JSON.parse(init.body).system; return anthropicReply({ prompt: 'p', note: 'n' }); }], pg.route]);
  const h = api('kb.js', SB);
  try {
    let r = res(); await h.handler(req({ session: false }), r); assert.equal(r.statusCode, 401);
    r = res(); await h.handler(req({}), r); assert.equal(r.statusCode, 200); assert.equal(r.body.seeded, true, 'empty database → seed served');
    r = res(); await h.handler(req({ method: 'PUT', body: { kind: 'brand_kb', key: 'essence', content: { text: 'x' } } }), r); assert.equal(r.statusCode, 403, 'password session cannot edit');
    r = res(); await h.handler(req({ method: 'POST', body: { action: 'seed' }, headers: { cookie: adminCookie() }, session: false }), r); assert.equal(r.statusCode, 200); assert.ok(r.body.inserted > 0);
    r = res(); await h.handler(req({ method: 'PUT', body: { kind: 'nope', key: 'x', content: {} }, headers: { cookie: adminCookie() }, session: false }), r); assert.equal(r.statusCode, 400);
    r = res(); await h.handler(req({ method: 'PUT', body: { kind: 'brand_kb', key: 'essence', content: 'text' }, headers: { cookie: adminCookie() }, session: false }), r); assert.equal(r.statusCode, 422);
    r = res(); await h.handler(req({ method: 'PUT', body: { kind: 'brand_kb', key: 'essence', content: { text: 'CREATIVE ESSENCE — owner version two.' }, note: 'tightened' }, headers: { cookie: adminCookie() }, session: false }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.document.version, 2); assert.equal(r.body.document.created_by, 'u-owner');
    r = res(); await h.handler(req({ query: { kind: 'brand_kb', key: 'essence' } }), r); assert.equal(r.body.count, 1); assert.equal(r.body.documents[0].version, 2);
    const d = api('director.js', { ...SB, ANTHROPIC_API_KEY: 'k' });
    try {
      r = res(); await d.handler(req({ method: 'POST', body: { stage: 'mood', userInput: 'desert', campaign: { title: 'C', product: 'Galaxy Z Fold8' } } }), r);
      assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.match(seenSystem, /owner version two/); assert.match(seenSystem, /Galaxy Z Fold8: 2026 book-style foldable/);
    } finally { d.restore(); }
  } finally { f.restore(); h.restore(); kb.resetCache(); }
});
