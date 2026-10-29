// Product 3D models (owner 2026-10-29): a Blender .glb uploaded once per product; the page's captured views are the
// product reference for every render of that product's campaigns (image bots and the video bot).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { api, req, res, mockFetch, json, loadPage } = require('../helpers');
const { fakePostgrest } = require('../fake-postgrest');

const ENV = { SUPABASE_URL: 'https://sb.test', SUPABASE_SERVICE_ROLE_KEY: 'k' };
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.from([2, 0, 0, 0, 40, 0, 0, 0])]);
const VIEW = (n) => `https://sb.test/storage/v1/object/public/refs/v${n}.jpg`;

function storageFake() {
  const objects = {};
  const route = [
    [/\/storage\/v1\/object\/upload\/sign\/assets\//, (u) => json({ url: `/object/upload/sign/assets/${String(u).split('/upload/sign/assets/')[1]}?token=up` })],
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'POST', (u) => json({ signedURL: `/object/sign/assets/${String(u).split('/object/sign/assets/')[1]}?token=t` })],
    [(u, init) => /\/storage\/v1\/object\/sign\/assets\//.test(u) && (init.method || 'GET') === 'GET', (u) => { const p = decodeURIComponent(String(u).split('/object/sign/assets/')[1].split('?')[0]); return objects[p] ? new Response(objects[p], { status: 200 }) : new Response('nf', { status: 404 }); }],
    [(u, init) => /\/storage\/v1\/object\/assets\//.test(u) && init.method === 'POST', async (u, init) => { objects[String(u).split('/object/assets/')[1]] = Buffer.from(init.body); return json({ Key: 'ok' }); }],
  ];
  return { objects, route };
}

test('products3d: sign → save checks the bytes are a .glb and the views are refs → list → every render of the product carries the views; remove', async () => {
  const sf = storageFake(); const pg = fakePostgrest();
  const f = mockFetch([...sf.route, pg.route]);
  const studio = api('studio.js', ENV);
  process.env.SUPABASE_URL = ENV.SUPABASE_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
  const P = require('../../api/_studio/products3d.js'); P._reset();
  const post = async (body) => { const r = res(); await studio.handler(req({ method: 'POST', body }), r); return r; };
  try {
    let r = await post({ action: 'product3d-sign', product: '' }); assert.equal(r.statusCode, 422);
    r = await post({ action: 'product3d-sign', product: 'Galaxy Z Flip8' });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.match(r.body.path, /^products\/galaxy-z-flip8\/model-[a-z0-9]+\.glb$/); assert.match(r.body.uploadUrl, /token=up/); assert.equal(r.body.maxBytes, 50 * 1024 * 1024);
    const path = r.body.path;
    sf.objects[path] = Buffer.from('not a model at all');
    const views = [{ angle: 'front ¾', url: VIEW(1), hero: true }, { angle: 'back', url: VIEW(2) }, { angle: 'side', url: VIEW(3) }, { angle: 'top', url: VIEW(4) }, { angle: 'front', url: VIEW(5) }];
    r = await post({ action: 'product3d-save', product: 'Galaxy Z Flip8', path, views }); assert.equal(r.statusCode, 422); assert.equal(r.body.code, 'not_glb', 'the bytes decide, not the name');
    sf.objects[path] = GLB;
    r = await post({ action: 'product3d-save', product: 'Galaxy Z Flip8', path: 'products/galaxy-s26/model-x.glb', views }); assert.equal(r.body.code, 'bad_path');
    r = await post({ action: 'product3d-save', product: 'Galaxy Z Flip8', path, views: [{ angle: 'x', url: 'https://evil.test/x.jpg' }] }); assert.equal(r.body.code, 'no_views', 'only views stored in Maistro\'s refs bucket');
    r = await post({ action: 'product3d-save', product: 'Galaxy Z Flip8', path, views });
    assert.equal(r.statusCode, 200, JSON.stringify(r.body)); assert.equal(r.body.model.slug, 'galaxy-z-flip8'); assert.equal(r.body.model.views.length, 5);
    assert.ok(JSON.parse(sf.objects['products/index.json']).models['galaxy-z-flip8'], 'the index lives in storage');

    r = res(); await studio.handler(req({ query: { products3d: '1' } }), r);
    assert.equal(r.statusCode, 200); assert.equal(r.body.models.length, 1); assert.match(r.body.models[0].modelUrl, /\/object\/sign\/assets\/products\/galaxy-z-flip8\/model-/);

    // a campaign of "Galaxy Z Flip8 Bespoke" matches the Flip8 model; the hero view first, at most 4, then the campaign photo is cut
    let rr = await P.renderRefs('Galaxy Z Flip8 Bespoke Edition', 'https://sb.test/storage/v1/object/public/refs/photo.jpg');
    assert.equal(rr.model, 'galaxy-z-flip8'); assert.equal(rr.ref, VIEW(1)); assert.deepEqual(rr.refs, [VIEW(1), VIEW(2), VIEW(3), VIEW(4)]);
    rr = await P.renderRefs('Galaxy S26 Ultra', 'https://sb.test/storage/v1/object/public/refs/photo.jpg');
    assert.equal(rr.model, null); assert.deepEqual(rr.refs, ['https://sb.test/storage/v1/object/public/refs/photo.jpg'], 'no model: the campaign photo alone');

    // a new main view, then an added angle
    r = await post({ action: 'product3d-views', product: 'Galaxy Z Flip8', views: views.map((v, i) => ({ angle: v.angle, url: v.url, ...(i === 1 ? { hero: true } : {}) })) });
    assert.equal(r.statusCode, 200); assert.equal((await P.renderRefs('Galaxy Z Flip8')).ref, VIEW(2));

    // the adapter sends every view as product_image_urls with the 3D-model rule
    const H = require('../../api/_adapters/hermes.js');
    const run = H.renderRun({ prompt: 'p', aspect_ratio: '9:16', ref: VIEW(2), refs: [VIEW(2), VIEW(1), VIEW(3)], productModel: 'galaxy-z-flip8', imageUrl: 'https://sb.test/k.png', duration: 5 }, 'video');
    const input = JSON.parse(run.input);
    assert.deepEqual(input.product_image_urls, [VIEW(2), VIEW(1), VIEW(3)]); assert.equal(input.first_frame_url, 'https://sb.test/k.png');
    assert.match(run.instructions, /exact 3D model of the product/);
    assert.deepEqual(JSON.parse(H.renderRun({ prompt: 'p', ref: VIEW(9) }, 'thumb').input).product_image_urls, [VIEW(9)], 'one campaign photo still works');

    r = await post({ action: 'product3d-remove', product: 'Galaxy Z Flip8' }); assert.equal(r.statusCode, 200);
    r = await post({ action: 'product3d-remove', product: 'Galaxy Z Flip8' }); assert.equal(r.statusCode, 404);
    P._reset(); assert.deepEqual((await P.renderRefs('Galaxy Z Flip8')).refs, []);
  } finally { f.restore(); studio.restore(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('products3d: the draft sends the 3D views with clips that show the device (and with a text-to-video clip)', async () => {
  const sf = storageFake(); const pg = fakePostgrest();
  const f = mockFetch([...sf.route, pg.route]);
  const studio = api('studio.js', ENV); const pieces = api('pieces.js', ENV);
  process.env.SUPABASE_URL = ENV.SUPABASE_URL; process.env.SUPABASE_SERVICE_ROLE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
  const P = require('../../api/_studio/products3d.js'); P._reset();
  sf.objects['products/index.json'] = Buffer.from(JSON.stringify({ models: { 'galaxy-z-flip8': { slug: 'galaxy-z-flip8', product: 'Galaxy Z Flip8', modelPath: 'products/galaxy-z-flip8/model-a.glb', views: [{ angle: 'front ¾', url: VIEW(1), hero: true }, { angle: 'back', url: VIEW(2) }] } } }));
  try {
    let r = res(); await pieces.handler(req({ method: 'POST', body: { pieceId: 'gen-p3', stage: 'plan', artifact: { title: 'P', product: 'Galaxy Z Flip8', msg: 'm', markets: ['UAE'], platforms: ['tiktok'], th: ['#0c1418', '#1d5a63'] }, piece: { title: 'P', product: 'Galaxy Z Flip8', platforms: ['tiktok'] } } }), r);
    const store = require('../../api/_store.js');
    await store.recordVersion('gen-p3', 'board', { aspect: '9:16', shots: [
      { n: 1, durationS: 3, camera: 'push-in', action: 'the phone opens', product: { visible: true }, keyframe: { state: 'rendered', assetPath: 'pieces/gen-p3/board/k1.png' } },
      { n: 2, durationS: 3, camera: 'pan', action: 'a street', product: { visible: false }, keyframe: { state: 'rendered', assetPath: 'pieces/gen-p3/board/k2.png' } },
    ], rev: 0 }, { producedBy: 'hermes', kind: 'image' });
    r = res(); await studio.handler(req({ method: 'POST', body: { action: 'draft', pieceId: 'gen-p3' } }), r);
    assert.equal(r.statusCode, 200, JSON.stringify(r.body));
    const clips = pg.tables.jobs.filter((j) => j.kind === 'hermes_video').sort((a, b) => a.payload.attachTo.shot - b.payload.attachTo.shot);
    assert.equal(clips.length, 2);
    assert.deepEqual(clips[0].payload.refs, [VIEW(1), VIEW(2)]); assert.equal(clips[0].payload.productModel, 'galaxy-z-flip8'); assert.equal(clips[0].payload.imageAssetPath, 'pieces/gen-p3/board/k1.png');
    assert.equal(clips[1].payload.refs, undefined, 'a shot without the device gets no product reference');
  } finally { f.restore(); studio.restore(); pieces.restore(); delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; }
});

test('page: the Product 3D models card lists models, names the Blender export, and a campaign of that product shows the 3D chip', async () => {
  const model = { slug: 'galaxy-z-flip8', product: 'Galaxy Z Flip8', modelPath: 'products/galaxy-z-flip8/model-a.glb', modelUrl: 'https://sb.test/m.glb', views: [{ angle: 'front ¾', url: VIEW(1), hero: true }, { angle: 'back', url: VIEW(2) }] };
  const X = loadPage({ fetchImpl: async (u) => (String(u).includes('products3d=1') ? json({ models: [model], maxBytes: 1 }) : new Promise(() => {})) });
  try {
    let html = X.rP3d(); assert.match(html, /LOADING…/);
    await new Promise((r) => setTimeout(r, 20));
    html = X.rP3d();
    assert.match(html, /The exact product in every render/); assert.match(html, /File → Export → glTF 2\.0/); assert.match(html, /glTF Binary \(\.glb\)/);
    assert.match(html, /<b style="font-size:13px">Galaxy Z Flip8<\/b>/); assert.match(html, /2 VIEWS/); assert.match(html, /onclick="p3dView\('galaxy-z-flip8'\)"/); assert.match(html, /accept="\.glb,model\/gltf-binary"/);
    assert.equal(X.p3dFor('Galaxy Z Flip8 Bespoke').slug, 'galaxy-z-flip8'); assert.equal(X.p3dFor('Galaxy S26'), null);
    const chip = X.rRefControl({ id: 'x1', product: 'Galaxy Z Flip8' }); assert.match(chip, /3D MODEL · 2 VIEWS/);
    assert.doesNotMatch(X.rRefControl({ id: 'x2', product: 'Galaxy S26' }), /3D MODEL/);
    X.P3D.confirm = null; await X.p3dRemove('galaxy-z-flip8'); assert.equal(X.P3D.confirm, 'galaxy-z-flip8', 'the first click only asks');
  } finally { X.restore(); }
});
