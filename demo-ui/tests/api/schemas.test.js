// api/_schemas.js: the ingest contract per stage, plus hermes/director request bodies.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateArtifact, validate, HERMES_BODY, DIRECTOR_BODY, MAX_ARTIFACT_BYTES } = require('../../api/_schemas.js');
const { api, req, res, mockFetch, json } = require('../helpers');

const VALID = {
  plan: { title: 'Snap & Charge', product: 'Galaxy S26 Ultra', msg: 'Power that snaps on', angle: 'one sentence', markets: ['KSA', 'UAE'], platforms: ['tiktok', 'instagram'], th: ['#0c1418', '#1d5a63'] },
  mood: { note: 'art direction', tiles: [['#0a0f14', '#1d3a44', 'Dune'], ['#111111', '#222222', 'Night']] },
  thumb: { title: 'SNAP. CHARGED.', sub: 'Galaxy S26 Ultra · hook', g: ['#0c1418', '#1d5a63'] },
  brief: { objective: 'o', msg: 'm', markets: ['KSA'], platforms: ['tiktok'], deadline: '12 Oct 2026', mandatories: ['logo end-frame'] },
  board: [{ tc: '0:00', d: 'open on the setup line', g: ['#0a0f14', '#1d3a44'] }],
  final: { version: 'v1', dur: '0:15', audio: 'track — licence note', variants: [{ a: '9:16', l: 'EN', k: 'original', st: 'ready' }] },
  qc: { f1x8: [{ n: 'Technical & craft quality', s: 88 }], f1x8Note: 'note', human: 'N. Haddad · lead', humanNote: 'ok' },
};

test('every documented artifact shape validates; the Studio media shapes validate too', () => {
  for (const [stage, a] of Object.entries(VALID)) assert.equal(validateArtifact(stage, a), null, stage);
  assert.equal(validateArtifact('mood', { imageUrl: 'https://cdn/m.png', prompt: 'p', note: 'n' }), null);
  assert.equal(validateArtifact('thumb', { imageUrl: 'https://cdn/t.png', title: 'T', sub: 'S' }), null);
  assert.equal(validateArtifact('board', { imageUrl: 'https://cdn/b.png' }), null);
  assert.equal(validateArtifact('final', { ...VALID.final, videoUrl: 'https://cdn/v.mp4', qcRevised: true, variants: [{ a: '16:9', l: '720p', k: 'seedance', st: 'ready' }] }), null);
  assert.equal(validateArtifact('qc', { real: true, runs: { draft: { score: 6.1 } }, avg: 6.1 }), null);
});

test('missing keys keep the historical message; wrong types, bad colours, bad enums and oversize are reported with paths', () => {
  let r = validateArtifact('mood', { note: 'x' });
  assert.equal(r.message, 'mood artifact is missing: tiles');
  r = validateArtifact('brief', {});
  assert.equal(r.message, 'brief artifact is missing: objective, msg, markets, platforms, deadline, mandatories');
  r = validateArtifact('plan', { ...VALID.plan, th: ['#0c1418', 'red'], platforms: ['tiktok', 'snapchat'] });
  assert.match(r.message, /^plan artifact invalid: /);
  assert.ok(r.problems.includes('$.platforms[1]: must be one of tiktok|instagram|youtube|x'));
  assert.ok(r.problems.includes('$.th[1]: has the wrong format'));
  r = validateArtifact('board', [{ d: 'no tc' }]);
  assert.match(r.message, /board artifact invalid/);
  r = validateArtifact('thumb', { imageUrl: 'http://insecure/t.png' });
  assert.match(r.message, /invalid/);
  r = validateArtifact('qc', { f1x8: [{ n: 'x', s: 140 }], f1x8Note: 'a', human: 'b', humanNote: 'c' });
  assert.ok(r.problems.includes('$.f1x8[0].s: above 100'));
  r = validateArtifact('final', { ...VALID.final, audio: 'x'.repeat(MAX_ARTIFACT_BYTES) });
  assert.match(r.message, /larger than/);
  assert.match(validateArtifact('nope', {}).message, /unknown stage/);
});

test('ingest returns 422 with field paths for a malformed push; a documented push still passes', async () => {
  const inserted = [];
  const f = mockFetch([['https://sb.test/rest/v1/campaign_events', (u, init) => (init.method === 'POST' ? (inserted.push(1), new Response('', { status: 201 })) : json([]))]]);
  const h = api('ingest.js', { MAISTRO_INGEST_KEY: 'k1', SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' });
  try {
    let r = res(); await h.handler(req({ method: 'POST', body: { stage: 'plan', artifact: { ...VALID.plan, th: ['#0c1418'] } }, headers: { Authorization: 'Bearer k1' }, session: false }), r);
    assert.equal(r.statusCode, 422); assert.deepEqual(r.body.problems, ['$.th: must be an array of 2']); assert.equal(inserted.length, 0);
    r = res(); await h.handler(req({ method: 'POST', body: { stage: 'plan', artifact: VALID.plan }, headers: { Authorization: 'Bearer k1' }, session: false }), r);
    assert.equal(r.statusCode, 200); assert.equal(inserted.length, 1);
  } finally { f.restore(); h.restore(); }
});

test('hermes and director request bodies: enums and types enforced after the existing checks', () => {
  assert.deepEqual(validate(HERMES_BODY, { stage: 'plan', trend: { name: 'T' } }), []);
  assert.deepEqual(validate(HERMES_BODY, { stage: 'plan', trend: { name: 'T' }, project: 'not an object' }), ['$.project: must be an object']);
  assert.deepEqual(validate(DIRECTOR_BODY, { stage: 'revise', campaign: { title: 'C' }, userInput: '' }), []);
  assert.deepEqual(validate(DIRECTOR_BODY, { stage: 'revise', campaign: { title: 'C' }, userInput: 'x'.repeat(4001) }), ['$.userInput: longer than 4000 characters']);
});
