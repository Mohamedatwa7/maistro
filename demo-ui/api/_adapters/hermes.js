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
// The bots (maistro-bots/MAISTRO_INTEGRATION.md, Hermes Agent v0.22.5), one per pipeline stage:
//   mood  → maistro-moodboard   moodboard images            { images, note }
//   thumb → maistro-thumbnail   thumbnail key visual        { images, note }
//   brief → maistro-brief       the structured brief        { brief }
//   board → maistro-storyboard  storyboard keyframes        { frames: [{ index, image, … }], note }
//   video → maistro-video       draft/final clips (i2v)     { video, duration_s, resolution, aspect, note }
// Any bot may answer { error, note } instead. The bots generate with Higgsfield credits on the owner's
// plan; their files are public CloudFront URLs (d8j0ntlcm91z4.cloudfront.net).
// The dispatch to Hermes (/api/hermes, /api/ingest, origin external_hermes) is a separate path.
//
// Config (server env):
//   HERMES_API_URL          base URL of the Hermes gateway, https (e.g. https://hermes.example.com)
//   HERMES_BOT_<ROLE>       profile name per bot; unset = the maistro-* profile above
//   HERMES_KEY_<ROLE>       that profile's key; else HERMES_KEY_<PROFILE> as named in the bots'
//                           maistro_api_keys.env (e.g. HERMES_KEY_MAISTRO_VIDEO); else HERMES_API_KEY
//   ROLE ∈ MOOD, THUMB, BRIEF, BOARD, VIDEO
//   MAISTRO_HERMES_USD_PER_CREDIT  assumed $ per Higgsfield credit for the budget gate (default 0.06)
const { fetchT } = require('../_http.js');

const ROLES = ['mood', 'thumb', 'brief', 'board', 'video'];
const PROFILES = { mood: 'maistro-moodboard', thumb: 'maistro-thumbnail', brief: 'maistro-brief', board: 'maistro-storyboard', video: 'maistro-video' };
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
  const profile = String(process.env[`HERMES_BOT_${R}`] || PROFILES[role] || '').trim();
  if (!PROFILE_RE.test(profile)) throw Object.assign(new Error(`HERMES_BOT_${R} must be a Hermes profile name ([a-zA-Z0-9_-])`), { status: 503, retryable: false, code: 'not_configured' });
  // a key only answers on its own /p/<profile>/ prefix, so each bot has its own
  const fileName = `HERMES_KEY_${profile.toUpperCase().replace(/-/g, '_')}`;
  const key = process.env[`HERMES_KEY_${R}`] || process.env[fileName] || process.env.HERMES_API_KEY;
  if (!key) throw Object.assign(new Error(`${fileName} (or HERMES_KEY_${R}) is not configured`), { status: 503, retryable: false, code: 'not_configured' });
  return { root: `${base}/p/${profile}`, profile, key };
}

const isHttps = (u) => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u);

/** What the bot must hand back, appended to every run's instructions. */
function outputContract(role, n = 1) {
  const refuse = ' If you will not make it because it breaks your content policy, reply instead with ONLY {"refused": "<one-line reason>"} in the same kind of block. On any other failure reply {"error": "<what went wrong>", "note": "..."}.';
  if (role === 'brief') return 'When you are done, reply with ONLY one JSON object inside a ```json code block: {"brief": <the brief, exactly in the BRIEF JSON SCHEMA given in the task>}. On failure reply {"error": "<what went wrong>"}. No other text.';
  if (role === 'video') return 'When you are done, reply with ONLY one JSON object inside a ```json code block: {"video": "<https URL of the finished MP4 clip>", "duration_s": <seconds>, "resolution": "<resolution>", "aspect": "<aspect>", "note": "<one line on what you made>"}. The URL must be publicly downloadable over https for at least 24 hours. No other text.' + refuse;
  if (role === 'board') return 'When you are done, reply with ONLY one JSON object inside a ```json code block: {"frames": [{"index": 1, "image": "<https URL>", "duration_s": <seconds>, "shot": "<shot>", "camera": "<camera>", "vo": "<voice-over or empty>"}], "note": "<one line on what you made>"}: exactly ONE frame, for the one shot in the task (the shot list is already written and approved). The image must be a PNG, JPG or WebP publicly downloadable over https for at least 24 hours. Never put text, captions or logos inside the image. No other text.' + refuse;
  return `When you are done, reply with ONLY one JSON object inside a \`\`\`json code block: {"images": [${n > 1 ? `<exactly ${n} https URLs>` : '"<https URL>"'}], "note": "<one line on what you made>"}. Every URL must be a PNG, JPG or WebP that is publicly downloadable over https for at least 24 hours. Never put text, captions or logos inside the image unless the task asks for it. No other text.${refuse}`;
}

// Seedance 2.0 (the video bot's default) makes 4–15 s clips; the image bots take 1k/2k/4k
const clipSeconds = (d) => Math.min(15, Math.max(4, Math.ceil(Number(d) || 5)));
const VIDEO_RES = ['480p', '720p', '1080p', '4k'];
const imageRes = (r) => { const v = String(r || '').toLowerCase(); return ['1k', '2k', '4k'].includes(v) ? v : v === '2160p' ? '4k' : v === '720p' || v === '480p' ? '1k' : '2k'; };
const videoRes = (r) => (VIDEO_RES.includes(String(r)) ? String(r) : '720p');

/** The run body for a render job (mood/thumb/board image, draft/final clip). `input` is a JSON string in
 *  the field names the bots understand (aspect, resolution, count, duration, audio, product_image_urls,
 *  moodboard_image_urls, first_frame_url, max_credits); the video bot refuses a run missing
 *  resolution, duration or aspect, so those are always set. */
function renderRun(payload, role) {
  const n = role === 'mood' && Number(payload.batch) > 1 ? Math.min(8, Number(payload.batch)) : 1;
  const task = role === 'video' ? 'Make one video clip (image-to-video when first_frame_url is given: the clip starts exactly on that keyframe, keeping its product, character, setting and lighting).'
    : role === 'mood' ? `Make the moodboard: ${n} cohesive image variations of one art direction.`
    : role === 'thumb' ? 'Make the thumbnail / cover key visual, with no headline text (Maistro sets the type itself).'
    : 'Make ONE storyboard keyframe for the one shot described (the shot list is already written and approved; do not write a new one).';
  const anchors = Array.isArray(payload.anchorUrls) ? payload.anchorUrls.filter(isHttps).slice(0, 4) : [];
  const req = {
    task: `${task} For a Samsung Gulf social campaign.`,
    prompt: String(payload.prompt || ''),
    aspect: payload.aspect_ratio || (role === 'video' || role === 'board' ? '9:16' : '16:9'),
    resolution: role === 'video' ? videoRes(payload.resolution) : imageRes(payload.resolution),
    count: n,
    ...(role === 'video' ? { duration: clipSeconds(payload.duration), audio: payload.generateAudio !== false } : {}),
    ...(role === 'video' && isHttps(payload.imageUrl) ? { first_frame_url: payload.imageUrl } : {}),
    ...(isHttps(payload.ref) ? { product_image_urls: [payload.ref] } : {}),
    ...(anchors.length ? { moodboard_image_urls: anchors } : {}),
    ...(Number.isInteger(payload.seed) ? { seed: payload.seed } : {}),
    ...(payload.meta && payload.meta.changes ? { reviewer_changes: String(payload.meta.changes) } : {}),
    max_credits: maxCredits(role, payload, n),
  };
  const rules = [
    'The prompt was written by Maistro\'s art director from the approved earlier stages: follow it closely.',
    req.product_image_urls ? 'The device shown MUST be exactly the product in product_image_urls (same form factor, cameras, colours and finish); never invent a different device.' : null,
    req.moodboard_image_urls ? 'Match the palette, light and styling of moodboard_image_urls (the approved moodboard).' : null,
    req.seed != null ? 'Use the seed if your generator takes one, so this can be re-rendered the same way.' : null,
    req.reviewer_changes ? 'Apply only the reviewer_changes; keep everything else.' : null,
    role === 'video' && req.audio ? 'Native audio, no music you cannot license.' : null,
  ].filter(Boolean).join(' ');
  return { input: JSON.stringify(req), instructions: `${rules}\n\n${outputContract(role, n)}` };
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
  if (raw === 'waiting_for_approval') {
    // the bots only run their one media helper, so an approval prompt is unexpected: deny it (fail closed,
    // nothing extra runs or is spent) and fail the job with a message a person will see
    await fetchT(`${c.root}/v1/runs/${encodeURIComponent(m[2])}/approval`, { method: 'POST', headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ choice: 'deny' }) }, { timeoutMs: 15000 }).catch(() => null);
    return { status: 'failed', raw_status: raw, error: `the ${c.profile} bot asked for an approval inside Hermes; Maistro denied it. Check the bot on the Hermes PC, then try again` };
  }
  if (RUNNING.includes(raw)) return { status: 'running', raw_status: raw };
  // the gateway restarted mid-run: the job service submits the same request again
  if (raw === 'interrupted') return { status: 'interrupted', raw_status: raw, error: 'the Hermes gateway restarted mid-run' };
  if (raw === 'cancelled') return { status: 'canceled', raw_status: raw, error: `Hermes run ${raw}` };
  if (raw !== 'completed') return { status: 'failed', raw_status: raw, error: (d.error && (d.error.message || d.error)) || `Hermes run ${raw || 'failed'}` };
  const j = parseOutput(d.output);
  // the bot declined on policy grounds: the job service treats it like a provider moderation (explained, never resubmitted)
  if (j.refused) return { status: 'nsfw', raw_status: raw, error: String(j.refused).slice(0, 300) };
  // { error, note }: the bot could not make it (missing field, generator failure, over max_credits)
  if (j.error) return { status: 'failed', raw_status: 'bot_error', error: `the ${c.profile} bot: ${String(typeof j.error === 'string' ? j.error : JSON.stringify(j.error)).slice(0, 240)}` };
  const frames = Array.isArray(j.frames) ? [...j.frames].sort((a, b) => (Number(a && a.index) || 0) - (Number(b && b.index) || 0)).map((f) => f && (f.image || f.url)) : [];
  const images = (Array.isArray(j.images) ? j.images : j.image ? [j.image] : frames).map((x) => (x && typeof x === 'object' ? x.url : x)).filter(isHttps);
  const video = isHttps(j.video) ? j.video : j.video && isHttps(j.video.url) ? j.video.url : null;
  return { status: 'completed', raw_status: raw, images, video, brief: j.brief && typeof j.brief === 'object' ? j.brief : null, note: typeof j.note === 'string' ? j.note.slice(0, 500) : '', usage: d.usage || null, runtime: d.runtime || null };
}

// The bots spend Higgsfield credits (MAISTRO_INTEGRATION.md "Media facts"): Nano Banana Pro 2 per image
// (4 at 4k); Seedance 2.0 4.5/s at 720p, 12/s at 1080p. Resolutions not in the table are priced up.
const VIDEO_CREDITS_PER_S = { '480p': 4.5, '720p': 4.5, '1080p': 12, '4k': 12 };
function credits(role, payload = {}, n = 1) {
  if (role === 'video') return VIDEO_CREDITS_PER_S[videoRes(payload.resolution)] * clipSeconds(payload.duration);
  return (imageRes(payload.resolution) === '4k' ? 4 : 2) * n;
}
/** The cap the bot's media helper holds the run to: the priced cost plus headroom, never above its 150 default. */
const maxCredits = (role, payload, n) => Math.min(150, Math.max(4, Math.ceil(credits(role, payload, n) * 1.25)));
const usdPerCredit = () => { const v = Number(process.env.MAISTRO_HERMES_USD_PER_CREDIT); return Number.isFinite(v) && v > 0 ? v : 0.06; };
/** A render priced from the credit table: { usd, credits, basis }. */
function priceRender(role, payload = {}) {
  const n = role === 'mood' && Number(payload.batch) > 1 ? Math.min(8, Number(payload.batch)) : 1;
  const c = credits(role, payload, n), rate = usdPerCredit();
  const what = role === 'video' ? `Seedance 2.0, ${clipSeconds(payload.duration)} s at ${videoRes(payload.resolution)}` : `Nano Banana Pro × ${n}`;
  return { usd: Math.round(c * rate * 10000) / 10000, credits: c, basis: `${c} Higgsfield credits (${what}) × assumed $${rate}/credit (the bots return no price)` };
}

/** Same call shape as the Higgsfield estimate the QC fix plan was written against: (endpoint id, body). */
async function estimate(endpoint, body = {}) {
  const video = /video/i.test(String(endpoint)) || body.duration != null;
  return priceRender(video ? 'video' : 'mood', { ...body, batch: body.batch_size || body.batch });
}

module.exports = { ROLES, PROFILES, roleFor, credits, maxCredits, priceRender, config, renderRun, briefRun, outputContract, parseOutput, submit, status, classify, estimate };
