// A tiny in-memory PostgREST for the campaign-store tests: enough of the
// query grammar the store uses (select, eq/in filters, order, limit, insert
// with return=representation and ignore-duplicates upserts, PATCH by filter)
// to run api/_store.js end to end without a database. Not a general fake.
const crypto = require('node:crypto');

const UNIQUE = {
  content_pieces: [['legacy_id']],
  stages: [['piece_id', 'kind']],
  artifact_versions: [['stage_id', 'version']],
  adlcp_documents: [['artifact_version_id', 'kind']],
  members: [['id'], ['email']],
  trends_cache: [['id']],
  kb_documents: [['kind', 'key', 'version']],
};

function fakePostgrest(base = 'https://sb.test') {
  const tables = {};
  const t = (name) => (tables[name] = tables[name] || []);
  const now = () => new Date().toISOString();

  function parse(url) {
    const u = new URL(url);
    const table = u.pathname.replace(/^\/rest\/v1\//, '');
    const filters = []; let order = null; let limit = Infinity; let select = '*'; let onConflict = null;
    for (const [k, v] of u.searchParams) {
      if (k === 'select') select = v;
      else if (k === 'order') order = v;
      else if (k === 'limit') limit = Number(v);
      else if (k === 'on_conflict') onConflict = v.split(',');
      else {
        if (v === 'not.is.null') { filters.push({ col: k, op: 'notnull' }); continue; }
        if (v === 'is.null') { filters.push({ col: k, op: 'isnull' }); continue; }
        const m = v.match(/^(eq|in|lte|gte|lt|gt)\.(.*)$/s);
        if (!m) throw new Error(`fake-postgrest: unsupported filter ${k}=${v}`);
        filters.push({ col: k, op: m[1], val: m[1] === 'in' ? m[2].replace(/^\(|\)$/g, '').split(',').map(decodeURIComponent) : m[2] });
      }
    }
    return { table, filters, order, limit, select, onConflict };
  }
  const matches = (row, f) => f.every(({ col, op, val }) => {
    if (op === 'notnull') return row[col] != null;
    if (op === 'isnull') return row[col] == null;
    if (op === 'eq') return String(row[col]) === String(val);
    if (op === 'in') return val.includes(String(row[col]));
    if (row[col] == null) return false;
    const a = row[col], b = (typeof a === 'number' ? Number(val) : String(val)), x = (typeof a === 'number' ? a : String(a));
    return op === 'lte' ? x <= b : op === 'gte' ? x >= b : op === 'lt' ? x < b : x > b;
  });
  const project = (row, select) => (select === '*' ? { ...row } : Object.fromEntries(select.split(',').map((c) => [c, row[c]])));

  function defaults(table, row) {
    const r = { ...row };
    if (!r.id) r.id = crypto.randomUUID();
    if (table === 'content_pieces') { r.created_at = r.created_at || now(); r.updated_at = now(); }
    if (table === 'stages') { r.state = r.state || 'locked'; r.current_version_id = r.current_version_id || null; r.updated_at = now(); }
    if (table === 'artifact_versions') r.created_at = now();
    if (table === 'approvals') r.decided_at = now();
    if (table === 'adlcp_documents') r.uploaded_at = now();
    if (table === 'jobs') { r.state = r.state || 'queued'; r.attempts = r.attempts || 0; r.created_at = r.created_at || now(); r.provider_ref = r.provider_ref || null; }
    if (table === 'qc_results') r.created_at = now();
    if (table === 'trend_snapshots') r.id = r.id || rows.length + 1;
    if (table === 'trend_scores' || table === 'trend_decisions' || table === 'reconciliation_reports' || table === 'kb_documents' || table === 'generation_records' || table === 'creative_specs' || table === 'prompt_registry') r.id = r.id || rows.length + 1;
    if (table === 'kb_documents') { r.active = r.active !== undefined ? r.active : true; r.created_at = now(); }
    if (table === 'members') { r.active = r.active !== undefined ? r.active : true; r.created_at = r.created_at || now(); r.updated_at = now(); }
    return r;
  }

  const calls = [];
  async function handler(url, init = {}) {
    if (!String(url).startsWith(base + '/rest/v1/')) throw new Error('fake-postgrest: not my url ' + url);
    const p = parse(String(url));
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ method, table: p.table, url: String(url) });
    const prefer = String((init.headers || {}).Prefer || '');
    const rows = t(p.table);
    if (method === 'GET') {
      let out = rows.filter((r) => matches(r, p.filters));
      if (p.order) { const [col, dir] = p.order.split(',')[0].split('.'); out.sort((a, b) => { const x = a[col], y = b[col]; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1); }); }
      out = out.slice(0, p.limit).map((r) => project(r, p.select));
      return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'POST') {
      const body = JSON.parse(init.body);
      const list = Array.isArray(body) ? body : [body];
      const inserted = [];
      for (const raw of list) {
        const r = defaults(p.table, raw);
        const keys = UNIQUE[p.table] || [];
        const dupRow = rows.find((x) => keys.some((cols) => cols.every((c) => String(x[c]) === String(r[c]))));
        const dup = Boolean(dupRow);
        if (dup) {
          if (prefer.includes('ignore-duplicates')) continue;
          if (prefer.includes('merge-duplicates')) { Object.assign(dupRow, raw); inserted.push(dupRow); continue; }
          return new Response(JSON.stringify({ code: '23505', message: `duplicate key value violates unique constraint on ${p.table}` }), { status: 409 });
        }
        if (p.table === 'approvals' && r.decision === 'approved' && rows.some((x) => x.artifact_version_id === r.artifact_version_id && x.decision === 'approved')) {
          return new Response(JSON.stringify({ code: '23505', message: 'approvals_one_approved_per_version' }), { status: 409 });
        }
        rows.push(r); inserted.push(r);
      }
      return new Response(prefer.includes('representation') ? JSON.stringify(inserted) : '', { status: 201, headers: { 'content-type': 'application/json' } });
    }
    if (method === 'PATCH') {
      const patch = JSON.parse(init.body);
      const out = [];
      for (const r of rows) if (matches(r, p.filters)) { Object.assign(r, patch, p.table === 'stages' ? { updated_at: now() } : {}); out.push(r); }
      return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error('fake-postgrest: unsupported method ' + method);
  }
  return { base, tables, calls, handler, route: [(u) => String(u).startsWith(base + '/rest/v1/'), handler] };
}

module.exports = { fakePostgrest };
