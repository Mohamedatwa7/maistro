#!/usr/bin/env node
// Check the key, then create one TEST campaign through the agent ingest API, read it back, list it and delete it
// (docs/agent-ingest.md).
//
//   node scripts/agent-ingest-smoke.js <key-file> [--base=https://www.ma1stro.com]
//
// The key file holds the key alone, or an AGENT_INGEST_KEY=… line. The key is never printed. The campaign is a
// test campaign (never shown to reviewers) and is deleted at the end; nothing is approved, nothing renders, no
// credits are spent. The create is sent twice with the same Idempotency-Key to show the replay.
const fs = require('fs');

const args = process.argv.slice(2);
const opt = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const file = args.find((a) => !a.startsWith('--'));
if (!file) { console.error('usage: node scripts/agent-ingest-smoke.js <key-file> [--base=https://www.ma1stro.com]'); process.exit(2); }
const raw = fs.readFileSync(file, 'utf8');
const m = /^\s*AGENT_INGEST_KEY\s*=\s*"?([^"\r\n]+)"?/m.exec(raw);
const key = (m ? m[1] : raw).trim();
const base = (opt('base') || 'https://www.ma1stro.com').replace(/\/$/, '');

async function call(method, path, body, extra = {}) {
  const r = await fetch(`${base}/api/agent/${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'Hermes/1.0', ...extra }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, replayed: r.headers.get('idempotent-replayed') === 'true', body: j };
}

(async () => {
  const me = await call('GET', 'me');
  console.log(`GET /api/agent/me → ${me.status}`, JSON.stringify({ keyId: me.body.keyId, scopes: me.body.scopes, expiresAt: me.body.expiresAt }));
  if (me.status !== 200) process.exit(1);
  const idem = `smoke-${Date.now()}`;
  // a TEST campaign: hidden from the reviewers, deleted at the end
  const campaign = { title: 'zz test · agent ingest', trend: { id: 'smoke', name: 'Agent ingest smoke test' }, product: { family: 'Galaxy Z Flip8', colour: 'Pink' }, supporting_products: [{ family: 'Galaxy Buds4', colour: 'White' }], markets: ['UAE'], platforms: ['tiktok'], source: 'hermes', external_ref: idem, test: true };
  const a = await call('POST', 'campaigns', campaign, { 'Idempotency-Key': idem });
  console.log(`POST /api/agent/campaigns (test) → ${a.status}`, JSON.stringify(a.body));
  if (a.status !== 201) process.exit(1);
  const b = await call('POST', 'campaigns', campaign, { 'Idempotency-Key': idem });
  console.log(`POST again, same Idempotency-Key → ${b.status}, replayed: ${b.replayed}, same id: ${b.body.campaignId === a.body.campaignId}`);
  const bad = await call('POST', 'campaigns', { title: 'x', source: 'hermes' });
  console.log(`POST without the required fields → ${bad.status}`, JSON.stringify({ missing: bad.body.missing }));
  const unk = await call('POST', 'campaigns', { ...campaign, product: { family: 'Galaxy Z Flip9' } });
  console.log(`POST with an unknown product → ${unk.status} ${unk.body.code}`);
  const g = await call('GET', `campaigns/${a.body.campaignId}`);
  const c = g.body;
  console.log(`GET /api/agent/campaigns/${a.body.campaignId} → ${g.status}`);
  console.log(JSON.stringify({ campaignId: c.campaignId, title: c.title, source: c.source, test: c.test, status: c.status, product: c.product, supportingProducts: c.supportingProducts, externalRef: c.externalRef, stages: Object.fromEntries(Object.entries(c.stages || {}).map(([k, v]) => [k, `${v.state}${v.version ? ` v${v.version.n} by ${v.version.producedBy}` : ''}`])), comments: (c.comments || []).length, assets: (c.assets || []).length }, null, 2));
  const l = await call('GET', `campaigns?source=hermes&external_ref=${encodeURIComponent(idem)}`);
  console.log(`GET /api/agent/campaigns?external_ref=… → ${l.status}, found: ${(l.body.campaigns || []).map((x) => x.campaignId).join(',')}`);
  const d = await call('DELETE', `campaigns/${a.body.campaignId}`);
  const gone = await call('GET', `campaigns/${a.body.campaignId}`);
  console.log(`DELETE (test campaign) → ${d.status}; GET after → ${gone.status}`);
  process.exit(g.status === 200 && d.status === 200 && gone.status === 404 ? 0 : 1);
})().catch((e) => { console.error('smoke failed:', e.message); process.exit(1); });
