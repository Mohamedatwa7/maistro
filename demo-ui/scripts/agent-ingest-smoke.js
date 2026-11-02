#!/usr/bin/env node
// Create one test campaign through the agent ingest API and read it back (docs/agent-ingest.md).
//
//   node scripts/agent-ingest-smoke.js <key-file> [--base=https://www.ma1stro.com]
//
// The key file holds the key alone, or an AGENT_INGEST_KEY=… line. The key is never printed. The campaign is
// titled "zz test · agent ingest" so it is easy to spot and delete; nothing is approved, nothing renders, no
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
  const r = await fetch(`${base}/api/agent/${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'User-Agent': 'Maistro-smoke/1.0', ...extra }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, replayed: r.headers.get('idempotent-replayed') === 'true', body: j };
}

(async () => {
  const idem = `smoke-${Date.now()}`;
  const campaign = { title: 'zz test · agent ingest', trend: { id: 'smoke', name: 'Agent ingest smoke test' }, product: { family: 'Galaxy Z Fold8', colour: 'Cream' }, markets: ['UAE'], platforms: ['tiktok'], source: 'hermes' };
  const a = await call('POST', 'campaigns', campaign, { 'Idempotency-Key': idem });
  console.log(`POST /api/agent/campaigns → ${a.status}`, JSON.stringify(a.body));
  if (a.status !== 201) process.exit(1);
  const b = await call('POST', 'campaigns', campaign, { 'Idempotency-Key': idem });
  console.log(`POST again, same Idempotency-Key → ${b.status}, replayed: ${b.replayed}, same id: ${b.body.campaignId === a.body.campaignId}`);
  const bad = await call('POST', 'campaigns', { title: 'x', source: 'hermes' });
  console.log(`POST without the required fields → ${bad.status}`, JSON.stringify({ missing: bad.body.missing }));
  const g = await call('GET', `campaigns/${a.body.campaignId}`);
  const c = g.body;
  console.log(`GET /api/agent/campaigns/${a.body.campaignId} → ${g.status}`);
  console.log(JSON.stringify({ campaignId: c.campaignId, title: c.title, source: c.source, status: c.status, product: c.product, trend: c.trend, markets: c.markets, platforms: c.platforms, stages: Object.fromEntries(Object.entries(c.stages || {}).map(([k, v]) => [k, `${v.state}${v.version ? ` v${v.version.n} by ${v.version.producedBy}` : ''}`])), assets: (c.assets || []).length }, null, 2));
  process.exit(g.status === 200 ? 0 : 1);
})().catch((e) => { console.error('smoke failed:', e.message); process.exit(1); });
