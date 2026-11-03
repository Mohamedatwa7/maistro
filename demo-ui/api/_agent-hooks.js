// Reviewer feedback → Hermes (owner request 2026-11-03, docs/agent-ingest.md "Webhook").
// When a person decides a stage or reviews a shot on a campaign Hermes created through /api/agent, Maistro POSTs the
// event to HERMES_WEBHOOK_URL (default https://hermes.maistro-agents.com/hooks/maistro), signed with HMAC-SHA256
// over `<timestamp>.<body>` using HERMES_WEBHOOK_SECRET:
//   X-Maistro-Timestamp: <unix seconds>   X-Maistro-Signature: sha256=<hex>
// Off unless the secret is set. Best effort: a slow or failing receiver never blocks or fails the decision.
const crypto = require('node:crypto');
const { queryRows } = require('./_supabase.js');

const DEFAULT_URL = 'https://hermes.maistro-agents.com/hooks/maistro';
const q = (v) => encodeURIComponent(String(v));

function sign(secret, ts, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
}

/** Is this a campaign Hermes created through the agent API (its plan says source: hermes)? */
async function isAgentCampaign(legacyId) {
  if (!/^gen-h/.test(String(legacyId || ''))) return false;
  const [piece] = await queryRows('content_pieces', `select=id&legacy_id=eq.${q(legacyId)}&limit=1`);
  if (!piece) return false;
  const [plan] = await queryRows('stages', `select=current_version_id&piece_id=eq.${q(piece.id)}&kind=eq.plan&limit=1`);
  if (!plan || !plan.current_version_id) return false;
  const [v] = await queryRows('artifact_versions', `select=payload&id=eq.${q(plan.current_version_id)}&limit=1`);
  return Boolean(v && v.payload && v.payload.source === 'hermes' && !v.payload.deletedAt);
}

/** event: { type: 'stage.decision'|'shot.review'|'stage.reopened', campaignId, stage, shot?, assetId?, decision?, comment? } */
async function notifyHermes(event, { timeoutMs = 4000 } = {}) {
  const secret = String(process.env.HERMES_WEBHOOK_SECRET || '').trim();
  if (!secret || !event || !event.campaignId) return { sent: false, reason: 'off' };
  try {
    if (!(await isAgentCampaign(event.campaignId))) return { sent: false, reason: 'not_agent_campaign' };
    const body = JSON.stringify({ ...event, at: new Date().toISOString() });
    const ts = Math.floor(Date.now() / 1000);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(process.env.HERMES_WEBHOOK_URL || DEFAULT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', 'User-Agent': 'Maistro-webhook/1.0', 'X-Maistro-Timestamp': String(ts), 'X-Maistro-Signature': sign(secret, ts, body) }, body, signal: ctl.signal });
      if (!r.ok) console.warn(`[agent-hooks] ${event.type} → ${r.status}`);
      return { sent: r.ok, status: r.status };
    } finally { clearTimeout(timer); }
  } catch (e) {
    console.warn('[agent-hooks] webhook failed:', e.message);
    return { sent: false, reason: 'error' };
  }
}

module.exports = { notifyHermes, sign, DEFAULT_URL };
