// Knowledge base loader (Phase 6.1): the active document per (kind, key)
// from kb_documents, cached for a few minutes per function instance; the
// seed is the fallback when the database is not configured or empty, so
// prompts are never blank. Writes create a new version (append-only).
const { queryRows, insertRows, patchRows } = require('../_supabase.js');
const { seedDocuments, buildPrompts } = require('./seed.js');

const TTL_MS = 5 * 60 * 1000;
let cache = { at: 0, docs: null };
const configured = () => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

async function activeDocuments({ force = false } = {}) {
  if (!force && cache.docs && Date.now() - cache.at < TTL_MS) return cache.docs;
  let docs = null;
  if (configured()) {
    try {
      const rows = await queryRows('kb_documents', 'select=id,kind,key,version,content,source,note,created_at&active=eq.true&order=kind.asc,key.asc&limit=1000');
      if (rows.length) docs = rows;
    } catch (e) { console.warn('[kb] read failed, using the seed:', e.message); }
  }
  if (!docs) docs = seedDocuments().map((d, i) => ({ id: -(i + 1), ...d, created_at: null, seeded: true }));
  cache = { at: Date.now(), docs };
  return docs;
}

async function getDocument(kind, key) {
  const docs = await activeDocuments();
  return docs.find((d) => d.kind === kind && d.key === key) || null;
}

/** The prompt texts the generation handlers inject, plus a fingerprint of the
 *  active documents (ids and versions) so a generation record can name the
 *  knowledge-base state it was built from. */
async function brandPrompts() {
  const docs = await activeDocuments();
  const fp = docs.filter((d) => d.kind === 'brand_kb' || d.kind === 'product_catalog').map((d) => `${d.kind}:${d.key}@${d.version}${d.seeded ? ':seed' : ''}`).sort().join(',');
  return { ...buildPrompts(docs), kbFingerprint: require('node:crypto').createHash('sha256').update(fp).digest('hex').slice(0, 16) };
}

/** Append a new active version of (kind, key); the previous version is
 *  deactivated. Returns the new row. */
async function putDocument({ kind, key, content, note, source, memberId }) {
  if (!configured()) throw Object.assign(new Error('storage is not configured'), { status: 503 });
  const prev = await queryRows('kb_documents', `select=id,version&kind=eq.${encodeURIComponent(kind)}&key=eq.${encodeURIComponent(key)}&order=version.desc&limit=1`);
  const version = (prev[0] ? prev[0].version : 0) + 1;
  const [row] = await insertRows('kb_documents', [{ kind, key, version, content, note: note || null, source: source || 'owner edit', created_by: memberId || null, active: true }], { returning: true });
  if (prev[0]) await patchRows('kb_documents', `kind=eq.${encodeURIComponent(kind)}&key=eq.${encodeURIComponent(key)}&version=lt.${version}`, { active: false });
  cache = { at: 0, docs: null };
  return row;
}

/** Insert every seed document that has no version yet (idempotent). */
async function seedMissing() {
  if (!configured()) throw Object.assign(new Error('storage is not configured'), { status: 503 });
  const existing = await queryRows('kb_documents', 'select=kind,key&limit=2000');
  const have = new Set(existing.map((d) => `${d.kind}|${d.key}`));
  const rows = seedDocuments().filter((d) => !have.has(`${d.kind}|${d.key}`));
  if (rows.length) await insertRows('kb_documents', rows.map((d) => ({ ...d, active: true })));
  cache = { at: 0, docs: null };
  return { inserted: rows.length, existing: existing.length };
}

/** Write the current seed of the given kinds as NEW versions (seed corrections
 *  after the first seeding); documents whose active content already equals the
 *  seed are skipped. */
async function reseedKinds(kinds, note = 'seed update') {
  const docs = await activeDocuments({ force: true });
  let written = 0, skipped = 0;
  for (const d of seedDocuments().filter((x) => kinds.includes(x.kind))) {
    const cur = docs.find((x) => x.kind === d.kind && x.key === d.key && !x.seeded);
    if (cur && JSON.stringify(cur.content) === JSON.stringify(d.content) && cur.source === d.source) { skipped++; continue; }
    await putDocument({ kind: d.kind, key: d.key, content: d.content, note, source: d.source });
    written++;
  }
  return { written, skipped };
}

const resetCache = () => { cache = { at: 0, docs: null }; };

module.exports = { activeDocuments, getDocument, brandPrompts, putDocument, seedMissing, reseedKinds, resetCache };
