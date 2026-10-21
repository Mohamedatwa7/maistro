// Generation records and the prompt registry (Phase 6.1 items 6 and 7).
// Every model or render call leaves a row in generation_records — prompt
// name and version, the resolved prompt, parameters, seed, assets, status,
// latency, cost and usage — so a failed generation can be debugged after
// the fact and a prompt change can be traced. Writes are best effort: a
// record that cannot be written is logged, it never fails the generation.
const { insertRows } = require('./_supabase.js');
const crypto = require('node:crypto');

/** The system text (brand + catalog) repeats on every call; it is reconstructible
 *  from the prompt version and the knowledge-base fingerprint, so a record keeps
 *  the user turn and a sha-256 of the full resolved prompt. */
function compactPrompt(rec) {
  if (!rec.resolvedPrompt) return rec;
  const full = String(rec.resolvedPrompt);
  const user = rec.userPrompt != null ? String(rec.userPrompt) : full;
  return { ...rec, resolvedPrompt: user, params: { ...(rec.params || {}), promptSha256: crypto.createHash('sha256').update(full).digest('hex'), promptChars: full.length, ...(rec.kbFingerprint ? { kbFingerprint: rec.kbFingerprint } : {}) } };
}

const configured = () => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const registered = new Set();

/** Register a prompt template version once per function instance (idempotent in the database). */
async function registerPrompt(name, version, template, variables = [], note = null) {
  const key = `${name}@${version}`;
  if (registered.has(key) || !configured()) return;
  registered.add(key);
  try { await insertRows('prompt_registry', [{ name, version, template: String(template).slice(0, 200000), variables, note }], { onConflict: 'name,version', ignoreDuplicates: true }); }
  catch (e) { registered.delete(key); console.warn('[records] prompt registry write failed:', e.message); }
}

/** Write one generation record. Returns the row id or null. */
async function recordGeneration(rec) {
  if (!configured()) return null;
  rec = compactPrompt(rec);
  const row = {
    piece_id: rec.pieceId || null, legacy_piece_id: rec.legacyPieceId || null, stage: rec.stage || null, shot_id: rec.shotId || null,
    kind: rec.kind, model: rec.model || null, prompt_name: rec.promptName || null, prompt_version: rec.promptVersion || null,
    resolved_prompt: rec.resolvedPrompt ? String(rec.resolvedPrompt).slice(0, 60000) : null, params: rec.params || {}, seed: Number.isInteger(rec.seed) ? rec.seed : null,
    input_assets: rec.inputAssets || [], output_assets: rec.outputAssets || [], status: rec.status, error: rec.error ? String(rec.error).slice(0, 1000) : null,
    latency_ms: Number.isFinite(rec.latencyMs) ? Math.round(rec.latencyMs) : null, cost_usd: Number.isFinite(rec.costUsd) ? +rec.costUsd.toFixed(4) : null,
    usage: rec.usage || null, job_id: rec.jobId || null, member_id: rec.memberId || null, correlation_id: rec.correlationId || null,
  };
  try { const [r] = await insertRows('generation_records', [row], { returning: true }); return r ? r.id : null; }
  catch (e) { console.warn('[records] generation record write failed:', e.message); return null; }
}

/** Wrap a model call: times it, records success or failure, rethrows. */
async function recorded(meta, fn) {
  const t0 = Date.now();
  try {
    const out = await fn();
    await recordGeneration({ ...meta, status: 'succeeded', latencyMs: Date.now() - t0, usage: out && out.usage ? out.usage : meta.usage || null, outputAssets: (out && out.outputAssets) || meta.outputAssets || [] });
    return out;
  } catch (e) {
    const refused = e && (e.status === 400 && /moderat|refus|safety/i.test(String(e.message || '')));
    await recordGeneration({ ...meta, status: refused ? 'refused' : /timed out|timeout/i.test(String(e && e.message)) ? 'timed_out' : 'failed', error: e && e.message, latencyMs: Date.now() - t0 });
    throw e;
  }
}

module.exports = { registerPrompt, recordGeneration, recorded };
