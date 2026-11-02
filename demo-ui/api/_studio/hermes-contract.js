// The Maistro ⇄ Hermes bots contract (owner 2026-11-02, "fix how Maistro coordinates the bots").
// Pure: no I/O. Every request builder (api/_adapters/hermes.js), the job service (api/_jobs.js) and the
// studio actions read the session ids, the locked product spec, the credit budgets, the response
// schemas, the staleness model and the failure routing from here. See docs/hermes-integration.md.

/**
 * @typedef {{ family: string, colour: string|null, model_code: string|null }} ProductSpec
 * @typedef {{ checked: number|null, passed: number|null, regenerated: number|null, dropped: number|null, product: string|null, spec_card: string|null, notes: string|null, verdict: string|null }} Qa
 * @typedef {{ index: number, act: string, beat: string, image: string|null, duration_s: number|null, shot_size: string, angle: string, lens: string, move: string, action: string, device_pose: string, light: string, vo: string, transition: string, qa: Qa|null, story_flag: string|null }} Frame
 * @typedef {{ logline: string, product_truth: string, emotional_arc: string, acts: string[] }} Story
 * @typedef {{ error: string, note: string, errorCode: string|null, fallback: string|null, wantsNewFrame: boolean, creditsExhausted: boolean }} BotError
 */

// ---------- sessions ----------
// The Hermes side reads the campaign ledger key with ^maistro-gen-([A-Za-z0-9]+)-([a-z]+): the campaign
// id is alphanumeric only, the role lower-case letters only, then an optional -v<n> per campaign version.
const SESSION_RE = /^maistro-gen-([A-Za-z0-9]+)-([a-z]+)(?:-v(\d+))?$/;
const ROLE_SUFFIX = { brief: 'brief', mood: 'mood', board: 'board', thumb: 'thumb', video: 'draft' };

/** The page's piece id (gen-k3x9…, ext-…) → the alphanumeric campaign id the ledger is keyed by. Stable. */
function campaignKey(legacyId) {
  const k = String(legacyId || '').replace(/^gen-/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 48);
  if (!k) throw Object.assign(new Error(`no alphanumeric campaign id in "${legacyId}"`), { status: 400 });
  return k;
}
/** maistro-gen-<campaign>-<role>[-v<n>]; v1 is the bare id, later campaign versions start a fresh session. */
function sessionId(legacyId, role, version) {
  const suffix = ROLE_SUFFIX[role];
  if (!suffix) throw Object.assign(new Error(`no session suffix for role "${role}"`), { status: 400 });
  const v = Number(version);
  return `maistro-gen-${campaignKey(legacyId)}-${suffix}${Number.isInteger(v) && v > 1 ? `-v${v}` : ''}`;
}
function parseSessionId(s) {
  const m = SESSION_RE.exec(String(s || ''));
  return m ? { campaign: m[1], role: m[2], version: m[3] ? Number(m[3]) : 1 } : null;
}
const reviewSessionId = (legacyId, ts = Date.now()) => `maistro-review-${campaignKey(legacyId)}-${Number(ts) || Date.now()}`;

// ---------- the product: one locked spec every request reads ----------
// Known colourways and model codes. The KB catalog entry (product_catalog: colors, modelCodes,
// referenceImages) adds to this; nothing here is guessed — a colour without a code sends model_code null.
// referenceImages: the official Samsung Gulf gallery shots for that model code (samsung.com/ae, flattened on white),
// served from our own /assets (open past the coming-soon gate) so the links never break for the bots.
const ASSET_BASE = 'https://www.ma1stro.com/assets/products';
const PRODUCT_SPECS = {
  'Galaxy S26 Ultra': {
    defaultColour: 'Sky Blue', codes: { 'Sky Blue': 'SM-S948BLBIMEA' },
    referenceImages: ['front', 'back', 'side', 'back-three-quarter'].map((view) => ({ url: `${ASSET_BASE}/galaxy-s26-ultra/sky-blue-${view}.jpg`, view, colour: 'Sky Blue' })),
  },
};
const norm = (s) => String(s || '').trim().toLowerCase();

/** @returns {ProductSpec} */
function productSpec({ family, colour, catalog } = {}) {
  const fam = String(family || '').trim();
  const knownName = Object.keys(PRODUCT_SPECS).find((k) => norm(k) === norm(fam));
  const known = PRODUCT_SPECS[knownName] || { codes: {} };
  const cat = catalog && typeof catalog === 'object' ? catalog : {};
  const codes = { ...known.codes, ...(cat.modelCodes && typeof cat.modelCodes === 'object' ? cat.modelCodes : {}) };
  const catColours = Array.isArray(cat.colors) ? cat.colors.map((c) => (typeof c === 'string' ? c : c && c.name)).filter(Boolean) : [];
  const pick = String(colour || '').trim() || known.defaultColour || catColours[0] || '';
  const name = Object.keys(codes).find((k) => norm(k) === norm(pick)) || catColours.find((k) => norm(k) === norm(pick)) || pick;
  return { family: knownName || fam, colour: name || null, model_code: (name && codes[name]) || null };
}
/** "Samsung Galaxy S26 Ultra in Sky Blue (SM-S948BLBIMEA)" — the one sentence that replaces the generic look line. */
function productLine(spec) {
  if (!spec || !spec.family) return '';
  return `Samsung ${spec.family.replace(/^Samsung\s+/i, '')}${spec.colour ? ` in ${spec.colour}` : ''}${spec.model_code ? ` (${spec.model_code})` : ''}`;
}
const isHttps = (u) => typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/.test(u);
const VIEW_ORDER = ['front', 'back', 'side'];
/** Official images (front, back, side — the catalog's, in the campaign colour) first, then the fallbacks
 *  (the product's 3D-model views, the campaign photo). https only, no repeats, at most `max`. */
function productImages(spec, catalog, fallbacks = [], max = 4) {
  const known = spec && spec.family ? PRODUCT_SPECS[Object.keys(PRODUCT_SPECS).find((k) => norm(k) === norm(spec.family))] : null;
  // the KB catalog's own images win; the shipped official shots fill in when it has none
  const fromCatalog = catalog && Array.isArray(catalog.referenceImages) && catalog.referenceImages.length ? catalog.referenceImages : null;
  const imgs = fromCatalog || (known && known.referenceImages ? known.referenceImages : []);
  const ofColour = imgs.filter((x) => x && isHttps(x.url) && (!x.colour || !spec || !spec.colour || norm(x.colour) === norm(spec.colour)));
  const rank = (x) => { const i = VIEW_ORDER.indexOf(norm(x.view)); return i < 0 ? VIEW_ORDER.length : i; };
  const official = [...ofColour].sort((a, b) => rank(a) - rank(b)).map((x) => x.url);
  return [...new Set([...official, ...fallbacks.filter(isHttps)])].slice(0, max);
}

// ---------- credit budgets (max_credits), in one place ----------
// Nano Banana Pro: 2 credits per 2k image, 4 at 4k. A keyframe gets the image plus two QA re-renders.
// Override any of these with MAISTRO_HERMES_BUDGETS='{"keyframe":8}' (numbers only).
const BUDGET_DEFAULTS = { keyframe: 6, moodPerImage: 6, thumb: 6, planFrame: 6, videoHeadroom: 1.25, videoMin: 4, cap: 150 };
function budgets() {
  let o = {};
  try { o = JSON.parse(process.env.MAISTRO_HERMES_BUDGETS || '{}') || {}; } catch (e) { o = {}; }
  const out = { ...BUDGET_DEFAULTS };
  for (const k of Object.keys(out)) if (Number.isFinite(Number(o[k])) && Number(o[k]) > 0) out[k] = Number(o[k]);
  return out;
}
/** max_credits for one run. perImage = 2 or 4; n = images; frames = PLAN-mode shot count; videoCredits = priced clip. */
function budgetFor(role, { perImage = 2, n = 1, frames = 0, videoCredits = 0, plan = false } = {}) {
  const B = budgets();
  const retries3 = perImage * 3; // the image + two QA re-renders
  let c;
  if (role === 'video') c = Math.max(B.videoMin, Math.ceil(videoCredits * B.videoHeadroom));
  else if (role === 'board' && plan) c = Math.max(B.planFrame, retries3) * Math.max(1, Math.min(8, frames || 8));
  else if (role === 'board') c = Math.max(B.keyframe, retries3);
  else if (role === 'mood') c = Math.max(B.moodPerImage, retries3) * Math.max(1, n);
  else if (role === 'thumb') c = Math.max(B.thumb, retries3);
  else c = Math.max(B.keyframe, retries3);
  return Math.min(B.cap, Math.ceil(c));
}

// ---------- TEST MODE (no credits spent) ----------
const TEST_MODE_INSTRUCTION = 'TEST MODE: run every maistro_media.py command with --dry-run only and set image/video URLs to "dry-run".';
// 1, not 0: below the cost of any image (2), and never mistaken for "unset" by the media helper
const TEST_MODE_MAX_CREDITS = 1;
const testMode = (payload) => process.env.MAISTRO_HERMES_TEST_MODE === '1' || Boolean(payload && payload.testMode);

// ---------- what the bots are told about text and logos ----------
const TEXT_RULE = '"No logos / no text" means: no generated text, captions or third-party logos in the image. The product\'s own official SAMSUNG wordmark on its back stays, exactly as on the real device.';
const END_CARD_RULE = 'Never draw the Samsung logo or any logo. For an end card make a clean plate (background only, the centre left empty): Maistro composites the official white Samsung lettermark in post.';
const LOOK_REF_RULE = 'moodboard_images are LOOK references only (look_reference: true): take their palette, light, setting and styling, never the device in them. The device comes only from product and product_image_urls.';

// ---------- response schemas (Hermes enforces none) ----------
// A field spec is 'type' or 'type?' (optional); types: str, num, bool, arr, obj, any, and 'a|b'. Extra fields pass.
const SCHEMAS = {
  qa: { checked: 'num?', passed: 'num|bool?', regenerated: 'num|bool?', dropped: 'num|bool?', product: 'str|obj?', spec_card: 'str|obj?', notes: 'str|arr?', verdict: 'str?' },
  mood: { images: 'arr', variation_plan: 'arr?', swap_proposals: 'arr?', note: 'str?', qa: 'obj?' },
  thumb: { images: 'arr', note: 'str?', qa: 'obj?' },
  board: { story: 'obj?', frames: 'arr', note: 'str?', qa: 'obj?' },
  video: { video: 'str|obj', first_frame: 'str?', duration_s: 'num?', resolution: 'str?', aspect: 'str?', shot_list: 'arr?', note: 'str?', qa: 'obj?' },
  brief: { brief: 'obj' },
  error: { error: 'str|obj', note: 'str?', error_code: 'str?', fallback: 'str?' },
  review: { review: 'arr', story_check: 'any?', miscommunications: 'arr?', fixes_requested: 'arr?', qa: 'obj?' },
};
const typeOk = (v, t) => (t === 'any' ? true : t === 'str' ? typeof v === 'string' : t === 'num' ? typeof v === 'number' && Number.isFinite(v) : t === 'bool' ? typeof v === 'boolean' : t === 'arr' ? Array.isArray(v) : t === 'obj' ? Boolean(v) && typeof v === 'object' && !Array.isArray(v) : false);
/** → list of problems ([] = valid). Unknown fields are ignored. */
function validate(schemaName, obj) {
  const S = SCHEMAS[schemaName];
  if (!S) return [`no schema "${schemaName}"`];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['not a JSON object'];
  const out = [];
  for (const [k, spec] of Object.entries(S)) {
    const opt = spec.endsWith('?');
    const types = spec.replace(/\?$/, '').split('|');
    if (obj[k] === undefined || obj[k] === null) { if (!opt) out.push(`${k}: required`); continue; }
    if (!types.some((t) => typeOk(obj[k], t))) out.push(`${k}: expected ${types.join(' or ')}`);
  }
  if (schemaName !== 'qa' && obj.qa && typeof obj.qa === 'object') out.push(...validate('qa', obj.qa).map((p) => `qa.${p}`));
  return out;
}

const str = (v, n = 500) => (typeof v === 'string' ? v.slice(0, n) : v == null ? '' : typeof v === 'object' ? JSON.stringify(v).slice(0, n) : String(v).slice(0, n));
const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? Number(v) : null);
/** @returns {Qa|null} */
function normQa(qa) {
  if (!qa || typeof qa !== 'object' || Array.isArray(qa)) return null;
  return { checked: numOrNull(qa.checked), passed: numOrNull(qa.passed), regenerated: numOrNull(qa.regenerated), dropped: numOrNull(qa.dropped), product: qa.product == null ? null : str(qa.product, 400), spec_card: qa.spec_card == null ? null : str(qa.spec_card, 800), notes: qa.notes == null ? null : Array.isArray(qa.notes) ? qa.notes.map((x) => str(x, 200)).join(' · ').slice(0, 800) : str(qa.notes, 800), verdict: typeof qa.verdict === 'string' ? qa.verdict.slice(0, 40) : null };
}
/** @returns {Frame} */
function normFrame(f, i) {
  const x = f && typeof f === 'object' ? f : {};
  const img = typeof x.image === 'string' ? x.image : x.image && x.image.url ? x.image.url : typeof x.url === 'string' ? x.url : null;
  return { index: Number(x.index) || i + 1, act: str(x.act, 80), beat: str(x.beat, 200), image: img, duration_s: numOrNull(Number(x.duration_s)), shot_size: str(x.shot_size || x.shot, 60), angle: str(x.angle, 120), lens: str(x.lens, 60), move: str(x.move || x.camera, 160), action: str(x.action, 600), device_pose: str(x.device_pose, 300), light: str(x.light, 200), vo: str(x.vo, 400), transition: str(x.transition, 60), qa: normQa(x.qa), story_flag: x.story_flag ? str(x.story_flag, 400) : null };
}
/** @returns {Story|null} */
function normStory(s) {
  if (!s || typeof s !== 'object') return null;
  return { logline: str(s.logline, 400), product_truth: str(s.product_truth || s.productTruth, 400), emotional_arc: str(s.emotional_arc || s.emotionalArc, 400), acts: Array.isArray(s.acts) ? s.acts.map((a) => str(a, 400)).slice(0, 8) : [] };
}

// the video bot's "send me a new first frame" — routed to the storyboard bot
const NEW_FRAME_RE = /\b(first[\s-]?frame|keyframe|start(?:ing)?[\s-]frame|opening frame)\b/i;
const ASK_RE = /\b(new|another|different|send|change|changed|re-?render|replace|update|show(?:s)? more|regenerate)\b/i;
const wantsNewFrame = (note, error) => { const t = `${note || ''} ${error || ''}`; return NEW_FRAME_RE.test(t) && ASK_RE.test(t); };

/** @returns {BotError} */
function botError(j) {
  const error = str(j.error, 300), note = str(j.note, 600);
  const errorCode = typeof j.error_code === 'string' ? j.error_code.slice(0, 80) : null;
  return { error, note, errorCode, fallback: typeof j.fallback === 'string' ? j.fallback.slice(0, 80) : null, wantsNewFrame: wantsNewFrame(note, error), creditsExhausted: errorCode === 'higgsfield_credits_exhausted' };
}

/** A bot's parsed reply → { kind: 'error'|'refused'|'result', problems, ... }. Never throws on extra fields. */
function interpret(role, j) {
  if (!j || typeof j !== 'object') return { kind: 'error', problems: ['no JSON in the reply'], error: { error: 'no JSON in the reply', note: '', errorCode: null, fallback: null, wantsNewFrame: false, creditsExhausted: false } };
  if (j.refused) return { kind: 'refused', reason: str(j.refused, 300), problems: [] };
  if (j.error) return { kind: 'error', error: botError(j), problems: validate('error', j) };
  const schema = role === 'organizer' ? 'review' : role;
  const out = { kind: 'result', problems: SCHEMAS[schema] ? validate(schema, j) : [], qa: normQa(j.qa), note: str(j.note, 500), budgetBlockedRetry: j.budget_blocked_retry === true, storyFlag: j.story_flag ? str(j.story_flag, 400) : null };
  if (role === 'board') { out.frames = (Array.isArray(j.frames) ? j.frames : []).map(normFrame).sort((a, b) => a.index - b.index); out.story = normStory(j.story); }
  if (role === 'mood') { out.variationPlan = Array.isArray(j.variation_plan) ? j.variation_plan.slice(0, 12) : []; out.swapProposals = Array.isArray(j.swap_proposals) ? j.swap_proposals.slice(0, 12) : []; }
  if (role === 'video') { out.firstFrame = isHttps(j.first_frame) ? j.first_frame : null; }
  return out;
}

/** The organizer's campaign review → a display-ready shape; each fix maps to the studio action that runs it. */
function reviewResult(j) {
  const r = interpret('organizer', j);
  if (r.kind !== 'result') return { ok: false, ...r };
  return {
    ok: true, problems: r.problems, qa: r.qa,
    review: (j.review || []).map((x) => ({ asset: str(x && x.asset, 200), verdict: str(x && x.verdict, 40), defects: Array.isArray(x && x.defects) ? x.defects.map((d) => str(d, 300)) : x && x.defects ? [str(x.defects, 300)] : [] })),
    storyCheck: j.story_check == null ? null : str(j.story_check, 1200),
    miscommunications: Array.isArray(j.miscommunications) ? j.miscommunications.map((m) => str(m, 400)) : [],
    fixes: (Array.isArray(j.fixes_requested) ? j.fixes_requested : []).map((f) => ({ to: str(f && f.to, 60), shot: Number(f && f.shot) || null, fix: str(f && f.fix, 600), run: fixAction(f) })),
  };
}
/** fixes_requested[i] → { action, shot?, changes? / userInput? } for /api/studio, or null when no bot fits. */
function fixAction(f) {
  const to = norm(f && f.to).replace(/^maistro-/, '');
  const fix = str(f && f.fix, 600), shot = Number(f && f.shot) || null;
  if (/^(storyboard|board|keyframe)/.test(to)) return shot ? { action: 'board-shot', shot, changes: fix } : { action: 'board', userInput: fix };
  if (/^(video|draft|clip)/.test(to)) return shot ? { action: 'draft-shot', shot, changes: fix } : { action: 'draft' };
  if (/^(moodboard|mood)/.test(to)) return { action: 'mood', userInput: fix };
  if (/^(thumbnail|thumb|cover)/.test(to)) return { action: 'thumb', userInput: fix };
  if (/^brief/.test(to)) return { action: 'brief', userInput: fix };
  return null;
}

// ---------- pipeline order ----------
const ORDER = ['brief', 'mood', 'board', 'thumb', 'draft'];
/** Earlier steps that are not approved (skipped steps count as done). mode: 'warn' (default) | 'strict' | 'off'. */
function orderCheck(stage, states = {}, skipped = []) {
  const i = ORDER.indexOf(stage);
  if (i <= 0) return [];
  return ORDER.slice(0, i).filter((k) => !skipped.includes(k) && states[k] !== 'approved').map((k) => ({ stage: k, state: states[k] || 'missing' }));
}
const orderMode = () => { const m = String(process.env.MAISTRO_PIPELINE_ORDER || 'warn').toLowerCase(); return ['warn', 'strict', 'off'].includes(m) ? m : 'warn'; };

// ---------- shot-level staleness ----------
/** The keyframe a clip must start on: the storyboard shot's current keyframe, if rendered and not rejected. */
function currentKeyframe(boardShot) {
  const kf = boardShot && boardShot.keyframe;
  if (!kf || kf.state !== 'rendered') return null;
  if (boardShot.review && boardShot.review.decision === 'rejected') return null;
  return kf;
}
const kfId = (kf) => (kf ? kf.assetPath || kf.url || kf.jobId || null : null); // clip.fromKeyframe is the keyframe's asset path
/** Draft shots whose clip was made from a keyframe that is no longer the storyboard shot's current one.
 *  → [{ n, boardShot, from, current }] */
function staleClips(boardShots = [], draftShots = []) {
  const out = [];
  for (const d of draftShots || []) {
    if (!d || !d.clip || d.clip.state !== 'rendered' || !d.boardShot) continue;
    const b = (boardShots || []).find((x) => x && x.n === d.boardShot);
    const now = b && b.keyframe && b.keyframe.state === 'rendered' ? kfId(b.keyframe) : null;
    const from = (d.clip && d.clip.fromKeyframe) || kfId(d.keyframe);
    if (now && from && now !== from) out.push({ n: d.n, boardShot: d.boardShot, from, current: now });
  }
  return out;
}

/** Our shot list (storyboard SHOT schema) → the shot_list items the storyboard bot reads. */
function botShot(s) {
  const cam = String(s.camera || '');
  const [angle, ...rest] = cam.split(',');
  const act = s.act || (s.beat === 'opening' ? 'Act 1 — setup' : s.beat === 'closing' || s.beat === 'end_card' ? 'Act 3 — resolution' : 'Act 2 — story');
  return {
    index: s.n, act, beat: s.beatLabel || s.beat || '', shot_size: String(s.type || '').replace('_', ' '),
    angle: s.angle || angle.trim(), lens: s.lens || '', move: s.move || rest.join(',').trim(),
    action: s.action || '', device_pose: s.devicePose || (s.product && s.product.visible ? `in frame${s.product.feature ? `, showing ${s.product.feature}` : ''}` : 'not in frame'),
    duration_s: Number(s.durationS) || null, transition: s.transition || '',
  };
}
/** The story the storyboard bot is given: the shot list's own, else the brief's storyline. @returns {Story|null} */
function storyFrom(listStory, storyline, keyMessage) {
  if (listStory && listStory.logline) return normStory(listStory);
  if (!storyline || !storyline.logline) return null;
  return { logline: str(storyline.logline, 400), product_truth: str(keyMessage || '', 400), emotional_arc: [storyline.openingScene, ...(storyline.beats || []), storyline.closingScene].filter(Boolean).join(' → ').slice(0, 400), acts: [storyline.openingScene, ...(storyline.beats || []), storyline.closingScene].filter(Boolean).map((a) => str(a, 400)) };
}

// ---------- PLAN mode: the storyboard bot writes the story + shot list + every keyframe ----------
const SHOT_TYPES = ['wide', 'medium', 'close_up', 'macro', 'pov', 'insert', 'end_card'];
const TRANSITIONS = ['cut', 'match_cut', 'whip', 'dissolve', 'hold', 'none'];
function shotType(s) { const v = norm(s).replace(/[\s-]+/g, '_'); return SHOT_TYPES.find((t) => v.includes(t)) || (/extreme|ecu|detail/.test(v) ? 'macro' : /^(cu|close)/.test(v) ? 'close_up' : /^(ws|ls|long|establish)/.test(v) ? 'wide' : /end/.test(v) ? 'end_card' : 'medium'); }
function transitionOf(s) { const v = norm(s).replace(/[\s-]+/g, '_'); return TRANSITIONS.find((t) => v === t) || TRANSITIONS.find((t) => t !== 'cut' && v.includes(t)) || (v ? 'cut' : 'none'); }
/** PLAN-mode frames → storyboard shots (our SHOT shape + the bot's per-frame fields). Beats by position. */
function shotsFromFrames(frames) {
  const n = frames.length;
  return frames.map((f, i) => {
    const type = shotType(f.shot_size);
    const endCard = i === n - 1 && (type === 'end_card' || /end/i.test(f.beat));
    const beat = i === 0 ? 'opening' : endCard ? 'end_card' : i === (n > 1 && shotType(frames[n - 1].shot_size) === 'end_card' ? n - 2 : n - 1) ? 'closing' : 'story';
    const visible = !/^(not|no)\b|out of frame|none/i.test(f.device_pose || '') && Boolean(f.device_pose);
    return {
      n: i + 1, beat, beatLabel: f.beat, act: f.act, durationS: f.duration_s || 3, type: endCard ? 'end_card' : type,
      camera: [f.angle, f.move].filter(Boolean).join(', ') || f.shot_size || 'static', angle: f.angle, lens: f.lens, move: f.move,
      action: f.action || f.beat || '', devicePose: f.device_pose, light: f.light,
      product: { visible, feature: '' }, onScreenText: { en: '', ar: '' }, line: { en: f.vo || '', ar: '' }, audioCue: '', transition: transitionOf(f.transition),
      qa: f.qa, storyFlag: f.story_flag,
    };
  });
}

// ---------- logging ----------
/** Deep copy with secrets out: auth headers/keys masked, signed-URL tokens (?token=, X-Amz-Signature…) redacted. */
function redact(v) {
  if (typeof v === 'string') return v.replace(/([?&](?:token|sig|signature|X-Amz-Signature|X-Amz-Credential|key|apikey)=)[^&\s"']+/gi, '$1REDACTED').replace(/Bearer\s+[\w.~+/-]+=*/g, 'Bearer [redacted]');
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, /^(authorization|api[_-]?key|secret|password|token)$/i.test(k) ? '[redacted]' : redact(x)]));
  return v;
}

module.exports = {
  SESSION_RE, ROLE_SUFFIX, campaignKey, sessionId, parseSessionId, reviewSessionId,
  PRODUCT_SPECS, productSpec, productLine, productImages,
  BUDGET_DEFAULTS, budgets, budgetFor,
  TEST_MODE_INSTRUCTION, TEST_MODE_MAX_CREDITS, testMode, TEXT_RULE, END_CARD_RULE, LOOK_REF_RULE,
  SCHEMAS, validate, normQa, normFrame, normStory, wantsNewFrame, botError, interpret, reviewResult, fixAction,
  ORDER, orderCheck, orderMode, currentKeyframe, staleClips, botShot, storyFrom, shotsFromFrames, redact,
};
