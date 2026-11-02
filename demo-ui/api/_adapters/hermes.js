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
//   organizer → maistro-organizer  campaign review          { review, story_check, miscommunications, fixes_requested }
// Every reply also carries qa { checked, passed, regenerated, dropped, product, spec_card, notes, verdict }.
// Any bot may answer { error, note, error_code?, fallback? } instead. The session ids, the product spec, the
// budgets and the response schemas live in api/_studio/hermes-contract.js (docs/hermes-integration.md). The bots generate with Higgsfield credits on the owner's
// plan; their files are public CloudFront URLs (d8j0ntlcm91z4.cloudfront.net).
// The dispatch to Hermes (/api/hermes, /api/ingest, origin external_hermes) is a separate path.
//
// Config (server env):
//   HERMES_API_URL          base URL of the Hermes gateway, https (e.g. https://hermes.example.com)
//   HERMES_BOT_<ROLE>       profile name per bot; unset = the maistro-* profile above
//   HERMES_KEY_<ROLE>       that profile's key; else HERMES_KEY_<PROFILE> as named in the bots'
//                           maistro_api_keys.env (e.g. HERMES_KEY_MAISTRO_VIDEO); else HERMES_API_KEY
//   ROLE ∈ MOOD, THUMB, BRIEF, BOARD, VIDEO, ORGANIZER
//   MAISTRO_HERMES_BUDGETS          max_credits overrides (JSON; hermes-contract.js BUDGET_DEFAULTS)
//   MAISTRO_HERMES_TEST_MODE=1      every run in TEST MODE: --dry-run only, max_credits 1 (below any image)
//   MAISTRO_HERMES_USD_PER_CREDIT  assumed $ per Higgsfield credit for the budget gate (default 0.06)
const { fetchT } = require('../_http.js');
const refsMod = require('../_studio/refs.js');
const C = require('../_studio/hermes-contract.js');

const ROLES = ['mood', 'thumb', 'brief', 'board', 'video', 'organizer'];
const PROFILES = { mood: 'maistro-moodboard', thumb: 'maistro-thumbnail', brief: 'maistro-brief', board: 'maistro-storyboard', video: 'maistro-video', organizer: 'maistro-organizer' };
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

const QA = '"qa": {"checked": <n>, "passed": <n>, "regenerated": <n>, "dropped": <n>, "product": "<what you verified about the device>", "spec_card": "<the product spec card you held it to>", "notes": "<QA notes>", "verdict": "pass|warn|fail"}';
const FRAME = '{"index": <shot_index>, "act": "<act>", "beat": "<beat>", "image": "<https URL>", "duration_s": <seconds>, "shot_size": "<size>", "angle": "<angle>", "lens": "<lens>", "move": "<camera move>", "action": "<action>", "device_pose": "<how the device is held/shown, or not in frame>", "light": "<light>", "vo": "<voice-over or empty>", "transition": "<transition into the next shot>", ' + QA + ', "story_flag": "<only if this shot breaks the story or shot list, else omit>"}';
/** What the bot must hand back, appended to every run's instructions. */
function outputContract(role, n = 1, opts = {}) {
  const refuse = ' If you will not make it because it breaks your content policy, reply instead with ONLY {"refused": "<one-line reason>"} in the same kind of block. On any other failure reply {"error": "<what went wrong>", "note": "<what Maistro or another bot should change>", "error_code": "<code, e.g. higgsfield_credits_exhausted>", "fallback": "<optional>"}.';
  const budget = ' If max_credits stopped a QA re-render, still deliver your best result and add "budget_blocked_retry": true.';
  if (role === 'organizer') return 'Reply with ONLY one JSON object inside a ```json code block: {"review": [{"asset": "<asset>", "verdict": "pass|warn|fail", "defects": ["..."]}], "story_check": "<does the campaign tell one story>", "miscommunications": ["<where bots worked from different context>"], "fixes_requested": [{"to": "<maistro-storyboard|maistro-video|maistro-moodboard|maistro-thumbnail|maistro-brief>", "shot": <shot number or null>, "fix": "<the change>"}], ' + QA + '}. No other text.';
  if (role === 'brief') return 'When you are done, reply with ONLY one JSON object inside a ```json code block: {"brief": <the brief, exactly in the BRIEF JSON SCHEMA given in the task>}. On failure reply {"error": "<what went wrong>", "note": "..."}. No other text.';
  if (role === 'video') return `When you are done, reply with ONLY one JSON object inside a \`\`\`json code block: {"video": "<https URL of the finished MP4 clip>", "first_frame": "<the first_frame_url you used>", "duration_s": <seconds>, "resolution": "<resolution>", "aspect": "<aspect>", "note": "<one line on what you made>", ${QA}}. The URL must be publicly downloadable over https for at least 24 hours. If the first frame cannot work (filter, product not visible enough), reply with the error and say in "note" exactly what new first frame you need. No other text.${budget}${refuse}`;
  if (role === 'board' && opts.plan) return `When you are done, reply with ONLY one JSON object inside a \`\`\`json code block: {"story": {"logline": "...", "product_truth": "...", "emotional_arc": "...", "acts": ["..."]}, "frames": [${FRAME}, …one per shot, in order], "note": "<one line on what you made>", ${QA}}. Every image a PNG, JPG or WebP publicly downloadable over https for at least 24 hours. No other text.${budget}${refuse}`;
  if (role === 'board') return `When you are done, reply with ONLY one JSON object inside a \`\`\`json code block: {"frames": [${FRAME}], "note": "<one line on what you made>", ${QA}}: exactly ONE frame, for shot shot_index of shot_count (the shot list is already written and approved; keep the story, the character and the look continuous with previous_keyframe_urls). The image must be a PNG, JPG or WebP publicly downloadable over https for at least 24 hours. No other text.${budget}${refuse}`;
  return `When you are done, reply with ONLY one JSON object inside a \`\`\`json code block: {"images": [${n > 1 ? `<exactly ${n} https URLs>` : '"<https URL>"'}], ${role === 'mood' ? '"variation_plan": ["<what each image varies>"], "swap_proposals": ["<optional swaps you suggest>"], ' : ''}"note": "<one line on what you made>", ${QA}}. Every URL must be a PNG, JPG or WebP that is publicly downloadable over https for at least 24 hours. No other text.${budget}${refuse}`;
}

// Seedance 2.0 (the video bot's default) makes 4–15 s clips; the image bots take 1k/2k/4k
const clipSeconds = (d) => Math.min(15, Math.max(4, Math.ceil(Number(d) || 5)));
const VIDEO_RES = ['480p', '720p', '1080p', '4k'];
const imageRes = (r) => { const v = String(r || '').toLowerCase(); return ['1k', '2k', '4k'].includes(v) ? v : v === '2160p' ? '4k' : v === '720p' || v === '480p' ? '1k' : '2k'; };
const videoRes = (r) => (VIDEO_RES.includes(String(r)) ? String(r) : '720p');

// Owner 2026-10-29: when the product has a 3D model, every render must use it — strict, not a style hint.
const PRODUCT_MODEL_RULE = [
  'STRICT PRODUCT RULE: product_image_urls are renders of the exact 3D model of the product from several angles.',
  'Every device in the output must be that model and nothing else: identical silhouette, proportions and real-world size (relative to hands and objects), thickness, corner radii, camera layout, lens count and placement, buttons, hinge, screen shape, colour and finish.',
  'Pass the views to your generator as its product/subject reference. Do not redesign, restyle, recolour, simplify or add anything to the device; no extra lenses, no logo or text on it, no different model.',
  'Show it from whatever angle the shot needs, but if the device cannot be shown faithfully in a shot, keep it out of frame rather than show a different one.',
].join(' ');

/** The run body for a render job (mood/thumb/board image, draft/final clip). `input` is a JSON string in
 *  the field names the bots understand (aspect, resolution, count, duration, audio, product_image_urls,
 *  moodboard_image_urls, first_frame_url, max_credits); the video bot refuses a run missing
 *  resolution, duration or aspect, so those are always set. */
// the product reference: the 3D model's views (payload.refs, hero first) or the one campaign photo (payload.ref)
const styleRefs = (payload) => (Array.isArray(payload.styleRefs) ? payload.styleRefs.filter(isHttps).slice(0, refsMod.MAX) : []);
const productRefs = (payload) => [...new Set([payload.ref, ...(Array.isArray(payload.refs) ? payload.refs : [])].filter(isHttps))].slice(0, 4);
/** The campaign's locked product (hermes-contract productSpec), on every request to every bot. */
const productOf = (payload) => (payload.productSpec && payload.productSpec.family ? payload.productSpec : C.productSpec({ family: (payload.meta && payload.meta.product) || payload.product || '' }));
/** Official images first (payload.productImages), then the 3D views / campaign photo. */
const productImagesOf = (payload) => [...new Set([...(Array.isArray(payload.productImages) ? payload.productImages : []), ...productRefs(payload)].filter(isHttps))].slice(0, 4);
const testPrefix = (payload) => (C.testMode(payload) ? `${C.TEST_MODE_INSTRUCTION}\n\n` : '');

function renderRun(payload, role) {
  const n = role === 'mood' && Number(payload.batch) > 1 ? Math.min(8, Number(payload.batch)) : 1;
  const plan = role === 'board' && Boolean(payload.planMode);
  const sc = role === 'board' && !plan && payload.shotContext ? payload.shotContext : null;
  const task = role === 'video' ? 'Make one video clip (image-to-video when first_frame_url is given: the clip starts exactly on that keyframe, keeping its product, character, setting and lighting).'
    : role === 'mood' ? `Make the moodboard: ${n} cohesive image variations of one art direction.`
    : role === 'thumb' ? 'Make the thumbnail / cover key visual, with no headline text (Maistro sets the type itself).'
    : plan ? 'Write the story and shot list, then make all keyframes'
    : sc ? `Make ONE storyboard keyframe: shot ${sc.shot_index} of ${sc.shot_count} (the shot list is already written and approved; do not write a new one).`
    : 'Make ONE storyboard keyframe for the one shot described (the shot list is already written and approved; do not write a new one).';
  const anchors = Array.isArray(payload.anchorUrls) ? payload.anchorUrls.filter(isHttps).slice(0, 4) : [];
  const product = productOf(payload);
  const perImage = imageRes(payload.resolution) === '4k' ? 4 : 2;
  const req = {
    task: `${task}${plan ? '.' : ''} For a Samsung Gulf social campaign.`,
    prompt: String(payload.prompt || ''),
    aspect: payload.aspect_ratio || (role === 'video' || role === 'board' ? '9:16' : '16:9'),
    resolution: role === 'video' ? videoRes(payload.resolution) : imageRes(payload.resolution),
    count: n,
    product,
    product_image_urls: productImagesOf(payload),
    ...(role === 'video' ? { duration: clipSeconds(payload.duration), audio: payload.generateAudio !== false } : {}),
    ...(role === 'video' && isHttps(payload.imageUrl) ? { first_frame_url: payload.imageUrl } : {}),
    ...(anchors.length ? { moodboard_image_urls: anchors, moodboard_images: anchors.map((url) => ({ url, look_reference: true })) } : {}),
    ...(sc ? { shot_index: sc.shot_index, shot_count: sc.shot_count, story: sc.story || null, shot_list: sc.shot_list || [], previous_keyframe_urls: (payload.previousKeyframeUrls || []).filter(isHttps) } : {}),
    ...(plan && payload.planContext ? { brief: payload.planContext.brief || null, story: payload.planContext.story || null, shot_count_range: [4, 8], target_duration_s: payload.planContext.targetDurationS || null } : {}),
    ...(payload.fixRequest ? { fix_request: String(payload.fixRequest).slice(0, 1200) } : {}),
    ...(styleRefs(payload).length ? { style_reference_urls: styleRefs(payload) } : {}),
    ...(payload.meta && payload.meta.changes ? { reviewer_changes: String(payload.meta.changes) } : {}),
    max_credits: C.testMode(payload) ? C.TEST_MODE_MAX_CREDITS : C.budgetFor(role, { perImage, n, plan, frames: plan ? 8 : 0, videoCredits: role === 'video' ? credits('video', payload) : 0 }),
  };
  const endCard = /end[\s_-]?card|clean plate|logo/i.test(req.prompt) && role !== 'video';
  const rules = [
    plan ? 'Plan the whole storyboard yourself from the brief: the story first, then 4–8 shots, then one keyframe per shot, continuous in character, product and look.' : 'The prompt was written by Maistro\'s art director from the approved earlier stages: follow it closely.',
    `The device is exactly the ${C.productLine(product)}: the locked product spec in "product". ${req.product_image_urls.length ? 'product_image_urls are its official images (front, back, side): same form factor, cameras, colour and finish; never invent a different device or colourway.' : 'Hold it to that model and colourway exactly.'}`,
    payload.productModel ? PRODUCT_MODEL_RULE : null,
    req.moodboard_images ? C.LOOK_REF_RULE : null,
    sc ? 'shot_list is the full approved list and story the campaign story: make this keyframe the shot at shot_index so it cuts with its neighbours; previous_keyframe_urls are the approved keyframes before it (match the character, wardrobe, setting and light).' : null,
    req.fix_request ? 'fix_request is what the video bot (or the reviewer) needs from this frame: apply it, keep the shot\'s place in the story.' : null,
    req.style_reference_urls ? refsMod.BOT_RULE : null,
    req.reviewer_changes ? 'Apply only the reviewer_changes; keep everything else.' : null,
    role !== 'video' ? C.TEXT_RULE : null,
    role !== 'video' && (endCard || plan) ? C.END_CARD_RULE : null,
    role === 'video' && req.audio ? 'Native audio, no music you cannot license.' : null,
  ].filter(Boolean).join(' ');
  return { input: JSON.stringify(req), instructions: `${testPrefix(payload)}${rules}\n\n${outputContract(role, n, { plan })}` };
}

/** The run body for the brief bot: Maistro's brief rules + the campaign context + the schema to fill. */
function briefRun(payload) {
  const product = productOf(payload), imgs = productImagesOf(payload);
  return {
    input: `${payload.context}\n\nPRODUCT (locked spec; the brief names exactly this model and colourway): ${JSON.stringify({ product, product_image_urls: imgs })}${styleRefs(payload).length ? `\n\nREFERENCE IMAGES FROM THE USER (open and look at each): ${styleRefs(payload).join(' ')}\n${refsMod.BRIEF_RULE}` : ''}\n\nBRIEF JSON SCHEMA (your "brief" must validate against it):\n${JSON.stringify(payload.schema)}`,
    instructions: `${testPrefix(payload)}${payload.system}\n\n${outputContract('brief')}`,
  };
}

/** The organizer bot's campaign review: it reads the campaign ledger on the Hermes side. */
function reviewRun(legacyId, opts = {}) {
  return { input: `review campaign ${C.campaignKey(legacyId)}`, instructions: `${testPrefix(opts)}${outputContract('organizer')}` };
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
  const it = C.interpret(m[1], j);
  // the bot declined on policy grounds: the job service treats it like a provider moderation (explained, never resubmitted)
  if (it.kind === 'refused') return { status: 'nsfw', raw_status: raw, error: it.reason };
  // { error, note, error_code?, fallback? }: the bot could not make it; the job service routes it (hermes-contract botError)
  if (it.kind === 'error') return { status: 'failed', raw_status: 'bot_error', error: `the ${c.profile} bot: ${it.error.error.slice(0, 240)}${it.error.note ? ` (${it.error.note.slice(0, 200)})` : ''}`, botError: it.error };
  if (m[1] === 'organizer') return { status: 'completed', raw_status: raw, parsed: j, problems: it.problems, usage: d.usage || null };
  const frameUrls = (it.frames || []).map((f) => f.image);
  const images = (Array.isArray(j.images) ? j.images : j.image ? [j.image] : frameUrls).map((x) => (x && typeof x === 'object' ? x.url : x)).filter(isHttps);
  const video = isHttps(j.video) ? j.video : j.video && isHttps(j.video.url) ? j.video.url : null;
  return {
    status: 'completed', raw_status: raw, images, video, brief: j.brief && typeof j.brief === 'object' ? j.brief : null, note: it.note, usage: d.usage || null, runtime: d.runtime || null,
    qa: it.qa, storyFlag: it.storyFlag || ((it.frames || []).find((f) => f.story_flag) || {}).story_flag || null, budgetBlockedRetry: it.budgetBlockedRetry, problems: it.problems,
    ...(it.frames ? { frames: it.frames, story: it.story } : {}), ...(it.variationPlan ? { variationPlan: it.variationPlan, swapProposals: it.swapProposals } : {}),
  };
}

// The bots spend Higgsfield credits (MAISTRO_INTEGRATION.md "Media facts"): Nano Banana Pro 2 per image
// (4 at 4k); Seedance 2.0 4.5/s at 720p, 12/s at 1080p. Resolutions not in the table are priced up.
const VIDEO_CREDITS_PER_S = { '480p': 4.5, '720p': 4.5, '1080p': 12, '4k': 12 };
function credits(role, payload = {}, n = 1) {
  if (role === 'video') return VIDEO_CREDITS_PER_S[videoRes(payload.resolution)] * clipSeconds(payload.duration);
  return (imageRes(payload.resolution) === '4k' ? 4 : 2) * n;
}
/** The cap the bot's media helper holds the run to (hermes-contract budgets: QA re-renders included, at most 150). */
const maxCredits = (role, payload = {}, n = 1) => C.budgetFor(role, { perImage: imageRes(payload.resolution) === '4k' ? 4 : 2, n, plan: Boolean(payload.planMode), frames: payload.planMode ? 8 : 0, videoCredits: role === 'video' ? credits('video', payload) : 0 });
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

module.exports = { ROLES, PROFILES, roleFor, credits, maxCredits, priceRender, config, renderRun, briefRun, reviewRun, outputContract, productOf, productImagesOf, parseOutput, submit, status, classify, estimate };
