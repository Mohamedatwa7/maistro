const { fetchT } = require('./_http.js');

// Thin Supabase PostgREST client for the campaign_events table.
// Uses the service-role key server-side only — never expose it to the browser.

function config() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/$/, ''), key };
}

async function insertRow(table, row) {
  const c = config();
  if (!c) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured on the server');
  const r = await fetchT(`${c.url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: c.key,
      Authorization: `Bearer ${c.key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  }, { timeoutMs: 15000 });
  if (!r.ok) throw new Error(`supabase insert failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
}

async function listRows(table, select, limit = 1000, order = 'at.desc') {
  const c = config();
  if (!c) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not configured on the server');
  const r = await fetchT(
    `${c.url}/rest/v1/${table}?select=${select}&order=${order}&limit=${limit}`,
    { headers: { apikey: c.key, Authorization: `Bearer ${c.key}` } },
    { timeoutMs: 15000, retries: 1 },
  );
  if (!r.ok) throw new Error(`supabase select failed (${r.status}): ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

const insertEvent = (row) => insertRow('campaign_events', row);
const listEvents = (limit) => listRows('campaign_events', 'project_id,stage,agent,trend,artifact,at', limit);

module.exports = { insertEvent, listEvents, insertRow, listRows };
