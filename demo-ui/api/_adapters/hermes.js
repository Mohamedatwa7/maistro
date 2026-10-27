// Hermes adapter: Maistro asks the content bots on the owner's Hermes Agent
// (moodboard, thumbnail, brief, storyboard, video) to make a stage's asset,
// in place of Higgsfield. Same shape as the Higgsfield adapter — submit a
// run, read its status, no polling loops here; the job service decides when
// to ask again.
//
// Hermes Agent API server (docs: user-guide/features/api-server):
//   POST {base}[/p/<profile>]/v1/runs      { input, instructions, session_id } → { run_id, status }
//   GET  {base}[/p/<profile>]/v1/runs/{id} → { status, output, usage, runtime }
//   Authorization: Bearer <that profile's API_SERVER_KEY>; Idempotency-Key replays a retried submit.
// Each bot is one Hermes profile (gateway.multiplex_profiles). A run only answers on the profile that
// created it, so the bot role is part of the provider ref ("<role>:<run_id>").
//
// Config (server env):
//   HERMES_API_URL          base URL of the Hermes gateway, https (e.g. https://hermes.example.com)
//   HERMES_API_KEY          default bearer key
//   HERMES_BOT_<ROLE>       profile name per bot; unset = the default profile (unprefixed)
//   HERMES_KEY_<ROLE>       that profile's key; unset = HERMES_API_KEY
//   ROLE ∈ MOOD, THUMB, BRIEF, BOARD, VIDEO
const { fetchT } = require('../_http.js');

const ROLES = ['mood', 'thumb', 'brief', 'board', 'video'];
const PROFILE_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Which bot makes a job: video for clips, brief for the brief, else the stage's own image bot. */
function roleFor(kind, stage) {
  if (kind === 'hermes_video') return 'video';
  if (kind === 'hermes_brief') return 'brief';
  return ['mood', 'thumb', 'board'].includes(stage) ? stage : null;
}

function config(role) {
  const base = String(process.env.HERMES_API_URL || '').trim().replace(/\/+$/, '');
  if (!base) throw Object.assign(new Error('HERMES_API_URL is not configured'), { status: 503, retryable: false, code: 'not_configured' });
  if (!/^https:\/\//.test(base) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(base)) throw Object.assign(new Error('HERMES_API_URL must be https'), { status: 503, retryable: false, code: 'not_configured' });
  const R = String(role || '').toUpperCase();
  const profile = String(process.env[`HERMES_BOT_${R}`] || '').trim();
  if (profile && !PROFILE_RE.test(profile)) throw Object.assign(new Error(`HERMES_BOT_${R} must be a Hermes profile name ([a-zA-Z0-9_-])`), { status: 503, retryable: false, code: 'not_configured' });
  const key = process.env[`HERMES_KEY_${R}`] || process.env.HERMES_API_KEY;
  if (!key) throw Object.assign(new Error(`HERMES_API_KEY (or HERMES_KEY_${R}) is not configured`), { status: 503, retryable: false, code: 'not_configured' });
  return { root: profile ? `${base}/p/${profile}` : base, profile: profile || 'default', key };
}

const isHttps = (u) => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u);

/** What the bot must hand back, appended to every run's instructions. */
function outputContract(role, n = 1) {
  const refuse = ' If you will not make it because it breaks your content policy, reply instead with ONLY {"refused": "<one-line reason>"} in the same kind of block.';
  if (role === 'brief') return 'When you are done, reply with ONLY one JSON object inside a ```json code block: {"brief": <the brief, exactly in the BRIEF JSON SCHEMA given in the task>}. No other text.';
  if (role === 'video') return 'When you are done, reply with ONLY one JSON object inside a ```json code block: {"video": "<https URL of the finished MP4 clip>", "note": "<one line on what you made>"}. The URL must be publicly downloadable over https for at least 24 hours. No other text.' + refuse;
  return `When you are done, reply with ONLY one JSON object inside a \`\`\`json code block: {"images": [${n > 1 ? `<exactly ${n} https URLs>` : '"<https URL>"'}], "note": "<one line on what you made>"}. Every URL must be a PNG, JPG or WebP that is publicly downloadable over https for at least 24 hours. Never put text, captions or logos inside the image unless the task asks for it. No other text.${refuse}`;
}

/** The run body for a render job (mood/thumb/board image, draft/final clip). */
function renderRun(payload, role) {
  const n = role === 'mood' && Number(payload.batch) > 1 ? Number(payload.batch) : 1;
  const lines = [
    `TASK: ${role === 'video' ? 'make one video clip' : role === 'mood' ? `make the moodboard: ${n} image variations of one art direction` : role === 'thumb' ? 'make the thumbnail key visual' : 'make one storyboard keyframe'} for a Samsung Gulf social campaign.`,
    `CREATIVE PROMPT (written by Maistro's art director from the approved earlier stages — follow it closely):\n${payload.prompt}`,
    `FORMAT: aspect ratio ${payload.aspect_ratio || (role === 'video' ? '9:16' : '16:9')}${payload.resolution ? `, ${payload.resolution}` : ''}${role === 'video' ? `, ${payload.duration || 5} seconds, ${payload.generateAudio === false ? 'no audio' : 'native audio, no music you cannot license'}` : ''}.`,
  ];
  if (role === 'video' && isHttps(payload.imageUrl)) lines.push(`FIRST FRAME (image-to-video — the clip starts exactly on this keyframe, keep its product, character, setting and lighting): ${payload.imageUrl}`);
  if (isHttps(payload.ref)) lines.push(`PRODUCT REFERENCE PHOTO (the device shown MUST be exactly this product — same form factor, cameras, colours and finish; never invent a different device): ${payload.ref}`);
  const anchors = Array.isArray(payload.anchorUrls) ? payload.anchorUrls.filter(isHttps).slice(0, 4) : [];
  if (anchors.length) lines.push(`APPROVED MOODBOARD IMAGES (match their palette, light and styling):\n${anchors.join('\n')}`);
  if (Number.isInteger(payload.seed)) lines.push(`SEED: ${payload.seed} (use it if your generator takes a seed, so this shot can be re-rendered the same way)`);
  if (payload.meta && payload.meta.changes) lines.push(`REVIEWER CHANGES (apply only these): ${payload.meta.changes}`);
  return { input: lines.join('\n\n'), instructions: outputContract(role, n) };
}

/** The run body for the brief bot: Maistro's brief rules + the campaign context + the schema to fill. */
function briefRun(payload) {
  return {
    input: `${payload.context}\n\nBRIEF JSON SCHEMA (your "brief" must validate against it):\n${JSON.stringify(payload.schema)}`,
    instructions: `${payload.system}\n\n${outputContract('brief')}`,
  };
}

function classify(status, text) {
  const t = String(text || '').slice(0, 200);
  if (status === 429) return { retryable: true, code: 'concurrency', message: `Hermes is at its run limit (429) — will retry` };
  if (status >= 500 || status === 408) return { retryable: true, code: 'provider_unavailable', message: `Hermes ${status}: ${t || 'temporarily unavailable'} — will retry` };
  if (status === 401 || status === 403) return { retryable: false, code: 'auth', message: `Hermes rejected the key (${status}) — check HERMES_API_KEY / HERMES_KEY_<ROLE> against that profile's API_SERVER_KEY` };
  if (status === 404) return { retryable: false, code: 'not_found', message: `Hermes 404: ${t || 'profile or run not found'} — check HERMES_BOT_<ROLE> and that gateway.multiplex_profiles is on` };
  if (status === 409) return { retryable: false, code: 'conflict', message: `Hermes 409: ${t || 'idempotency key conflict'}` };
  return { retryable: false, code: 'bad_request', message: `Hermes ${status}: ${t || 'request rejected'}` };
}
async function providerError(r) {
  const body = await r.text().catch(() => '');
  let detail = body; try { const j = JSON.parse(body); detail = (j.error && (j.error.message || j.error)) || j.detail || j.message || body; } catch (e) { /* text */ }
  const c = classify(r.status, typeof detail === 'string' ? detail : JSON.stringify(detail));
  return Object.assign(new Error(c.message), { status: r.status, retryable: c.retryable, code: c.code });
}

/** Submit a run to the bot for `role`. Returns { ref: "<role>:<run_id>", v: 0, status, bot }.
 *  opts.idempotencyKey (the job id) makes a retried submit return the original run. */
async function submit(role, body, opts = {}) {
  // Owner rule 2026-10-22 (no spend for testing) holds for Hermes too: its bots may call paid generators.
  if (process.env.MAISTRO_NO_RENDER === '1') throw Object.assign(new Error('renders are disabled here (MAISTRO_NO_RENDER=1): no spend for testing — owner decision 2026-10-22'), { status: 403, retryable: false, code: 'renders_disabled' });
  if (!ROLES.includes(role)) throw Object.assign(new Error(`no Hermes bot for "${role}"`), { status: 400, retryable: false });
  const c = config(role);
  const idem = opts.idempotencyKey ? { 'Idempotency-Key': String(opts.idempotencyKey).slice(0, 255) } : {};
  const r = await fetchT(`${c.root}/v1/runs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json', 'User-Agent': 'Maistro/1.0', ...idem },
    body: JSON.stringify({ ...body, ...(opts.sessionId ? { session_id: String(opts.sessionId).slice(0, 120) } : {}) }),
  }, { timeoutMs: 30000 });
  if (!r.ok) throw await providerError(r);
  const d = await r.json().catch(() => ({}));
  if (!d.run_id || !/^[\w.:-]{1,128}$/.test(String(d.run_id))) throw Object.assign(new Error(`Hermes returned no run_id (${r.status})`), { status: 502, retryable: true });
  return { ref: `${role}:${d.run_id}`, v: 0, status: d.status || 'started', bot: c.profile };
}

/** The last JSON object in the bot's reply: a ```json block, else the last balanced {...}. */
function parseOutput(output) {
  if (output && typeof output === 'object' && !Array.isArray(output)) return output;
  const text = Array.isArray(output) ? output.map((o) => (typeof o === 'string' ? o : (o && (o.text || (Array.isArray(o.content) ? o.content.map((c) => c.text || '').join('') : ''))) || '')).join('\n') : String(output || '');
  const fences = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const f of fences.reverse()) { try { const j = JSON.parse(f.trim()); if (j && typeof j === 'object') return j; } catch (e) { /* next */ } }
  for (let end = text.lastIndexOf('}'); end > 0; end = text.lastIndexOf('}', end - 1)) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (text[i] === '}') depth++;
      else if (text[i] === '{' && --depth === 0) { try { return JSON.parse(text.slice(i, end + 1)); } catch (e) { break; } }
    }
  }
  return { text };
}

const RUNNING = ['started', 'queued', 'running', 'stopping', 'unknown'];

/** Status of a run → { status, images, video, brief, note, raw_status, error }.
 *  status is one of running | waiting | completed | failed | canceled. */
async function status(ref) {
  const m = /^([a-z]+):([\w.:-]{1,128})$/.exec(String(ref || ''));
  if (!m || !ROLES.includes(m[1])) throw Object.assign(new Error('invalid Hermes run ref'), { status: 400 });
  const c = config(m[1]);
  const r = await fetchT(`${c.root}/v1/runs/${encodeURIComponent(m[2])}`, { headers: { Authorization: `Bearer ${c.key}` } }, { timeoutMs: 15000, retries: 1 });
  if (r.status === 404) return { status: 'failed', raw_status: 'not_found', error: 'Hermes no longer knows this run (statuses are kept briefly after they finish, or the gateway restarted)' };
  if (!r.ok) throw await providerError(r);
  const d = await r.json().catch(() => ({}));
  const raw = String(d.status || '');
  if (raw === 'waiting_for_approval') return { status: 'waiting', raw_status: raw, error: 'the Hermes run is waiting for an approval inside Hermes — approve or deny it there' };
  if (RUNNING.includes(raw)) return { status: 'running', raw_status: raw };
  if (raw === 'cancelled' || raw === 'interrupted') return { status: 'canceled', raw_status: raw, error: `Hermes run ${raw}` };
  if (raw !== 'completed') return { status: 'failed', raw_status: raw, error: (d.error && (d.error.message || d.error)) || `Hermes run ${raw || 'failed'}` };
  const j = parseOutput(d.output);
  // the bot declined on policy grounds: the job service treats it like a provider moderation (explained, never resubmitted)
  if (j.refused) return { status: 'nsfw', raw_status: raw, error: String(j.refused).slice(0, 300) };
  const images = (Array.isArray(j.images) ? j.images : j.image ? [j.image] : []).map((x) => (x && typeof x === 'object' ? x.url : x)).filter(isHttps);
  const video = isHttps(j.video) ? j.video : j.video && isHttps(j.video.url) ? j.video.url : null;
  return { status: 'completed', raw_status: raw, images, video, brief: j.brief && typeof j.brief === 'object' ? j.brief : null, note: typeof j.note === 'string' ? j.note.slice(0, 500) : '', usage: d.usage || null, runtime: d.runtime || null };
}

/** Hermes returns no price, so a re-render is priced at the same assumptions the budget gate uses
 *  (MAISTRO_UNPRICED_IMAGE_USD per image, MAISTRO_UNPRICED_VIDEO_USD_PER_S per clip second). Same call
 *  shape as the Higgsfield estimate the QC fix plan was written against: (endpoint id, body). */
async function estimate(endpoint, body = {}) {
  const video = /video/i.test(String(endpoint)) || body.duration != null;
  if (video) {
    const secs = Math.min(30, Math.max(4, Math.ceil(Number(body.duration) || 5)));
    const perS = Number(process.env.MAISTRO_UNPRICED_VIDEO_USD_PER_S || 0.5);
    return { usd: Math.round(secs * perS * 10000) / 10000, credits: null, basis: `assumed $${perS.toFixed(2)}/s × ${secs} s (Hermes returns no price)` };
  }
  const usd = Number(process.env.MAISTRO_UNPRICED_IMAGE_USD || 0.05) * (Number(body.batch_size) || 1);
  return { usd: Math.round(usd * 10000) / 10000, credits: null, basis: 'assumed image price (Hermes returns no price)' };
}

module.exports = { ROLES, roleFor, config, renderRun, briefRun, outputContract, parseOutput, submit, status, classify, estimate };
