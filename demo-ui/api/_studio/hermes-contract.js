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
const slugOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
/** The shipped views of a product, per colour: assets/products/<family>/<colour>-<view>.jpg */
const shipped = (family, colours, views) => colours.flatMap((colour) => views.map((view) => ({ url: `${ASSET_BASE}/${slugOf(family)}/${slugOf(colour)}-${view}.jpg`, view, colour })));
// folds: front = the closed cover screen, open-front = unfolded (the product moment); samsung.com/ae has no open-back shot
const FOLD_VIEWS = ['front', 'back', 'side', 'open-front'];
const PRODUCT_SPECS = {
  'Galaxy S26 Ultra': {
    defaultColour: 'Sky Blue', codes: { 'Sky Blue': 'SM-S948BLBIMEA' },
    referenceImages: shipped('Galaxy S26 Ultra', ['Sky Blue'], ['front', 'back', 'side', 'back-three-quarter']),
  },
  'Galaxy Z Fold8': {
    defaultColour: 'Cream', modelFamily: 'SM-F971B', codes: { Cream: 'SM-F971BZWIMEA', Graphite: 'SM-F971BZKIMEA', Lavender: 'SM-F971BLVOMEA' },
    referenceImages: shipped('Galaxy Z Fold8', ['Cream', 'Graphite', 'Lavender'], FOLD_VIEWS),
  },
  'Galaxy Z Fold8 Ultra': {
    defaultColour: 'Cream', modelFamily: 'SM-F976B', codes: { Cream: 'SM-F976BZWIMEA', Graphite: 'SM-F976BZKIMEA', 'Violet Shadow': 'SM-F976BZVOMEA' },
    referenceImages: shipped('Galaxy Z Fold8 Ultra', ['Cream', 'Graphite', 'Violet Shadow'], FOLD_VIEWS),
  },
};
// Colourways and model codes known for the agent ingest product lock only (api/_handlers/agent.js), as supplied by
// the Hermes operator (MAISTRO_OWNER_REQUEST, 2026-11-03). Not render specs: no official images ship for these yet,
// so the Studio bots keep treating them as catalog products. null = colour known, code not yet confirmed.
const AGENT_PRODUCT_CODES = {
  'Galaxy Z Flip8': { defaultColour: 'Cream', codes: { Cream: 'SM-F776BZWOMEA', Graphite: 'SM-F776BZKOMEA', Pink: 'SM-F776BLIPMEA', Mint: null } },
  'Galaxy Buds4': { defaultColour: 'White', codes: { White: 'SM-R540NZWAMEA', Black: 'SM-R540NZKAMEA' } },
  'Galaxy Buds4 Pro': { codes: {} },
  'Bespoke AI Fridge': { defaultColour: 'Snow White', aliases: ['Bespoke AI Refrigerator', 'Bespoke AI Refrigerators'], codes: { 'Snow White': 'RS80F64G1VRE' } },
};
/** The colourways Maistro knows for a product (for the page's colour picker). */
const coloursOf = (family) => { const k = Object.keys(PRODUCT_SPECS).find((x) => x.toLowerCase() === String(family || '').trim().toLowerCase()); return k ? Object.keys(PRODUCT_SPECS[k].codes) : []; };
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
const VIEW_ORDER = ['front', 'back', 'side', 'open-front'];
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
// production floors (owner 2026-11-02): an override can raise a budget, never take it below these
const BUDGET_FLOORS = { keyframe: 6, moodPerImage: 6, thumb: 6, planFrame: 6, videoHeadroom: 1.25, videoMin: 4, cap: 60 };
function budgets() {
  let o = {};
  try { o = JSON.parse(process.env.MAISTRO_HERMES_BUDGETS || '{}') || {}; } catch (e) { o = {}; }
  const out = { ...BUDGET_DEFAULTS };
  for (const k of Object.keys(out)) if (Number.isFinite(Number(o[k])) && Number(o[k]) > 0) out[k] = Math.max(BUDGET_FLOORS[k], Number(o[k]));
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
// the env switch never applies on the production deployment; a job only carries testMode when a test sets it
const testMode = (payload) => (process.env.MAISTRO_HERMES_TEST_MODE === '1' && process.env.VERCEL_ENV !== 'production') || Boolean(payload && payload.testMode);

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
/** The keyframe a clip must start on (owner 2026-11-02): rendered AND approved by a reviewer. */
function approvedKeyframe(boardShot) {
  const kf = currentKeyframe(boardShot);
  return kf && boardShot.review && boardShot.review.decision === 'approved' ? kf : null;
}
const kfId = (kf) => (kf ? kf.assetPath || kf.url || kf.jobId || null : null); // clip.fromKeyframe is the keyframe's asset path

// ---------- one continuous take (owner 2026-11-05) ----------
// "the video should have a flow so it feels like one long clip rather than separate clips joined together":
// the storyboard keyframes are the SCENES of the video. Consecutive scenes render together as ONE take of at most
// TAKE_MAX_S (the video bot's longest clip); a longer storyboard becomes several takes, each ending on the next
// take's first keyframe so they join on the same frame.
const TAKE_MAX_S = 15;
const sceneS = (s) => Math.max(0.5, Number(s && s.durationS) || 4);
/** shots (in order, each with n and durationS) → [{ lead, shots: [n], durationS, slices: [{ n, from, to }] }];
 *  a slice is the scene's share of its take as fractions, so the rendered take's real length decides the seconds. */
function takesFrom(shots = [], maxS = TAKE_MAX_S) {
  const takes = [];
  for (const s of shots) {
    const d = sceneS(s);
    let t = takes[takes.length - 1];
    if (!t || t.durationS + d > maxS + 1e-9) { t = { lead: s.n, shots: [], durationS: 0 }; takes.push(t); }
    t.shots.push(s.n); t.durationS = Math.round((t.durationS + d) * 100) / 100;
  }
  const r4 = (x) => Math.round(x * 10000) / 10000;
  for (const t of takes) {
    let acc = 0;
    t.slices = t.shots.map((n) => { const d = sceneS(shots.find((x) => x.n === n)); const from = acc; acc += d; return { n, from: r4(from / t.durationS), to: r4(acc / t.durationS) }; });
  }
  return takes;
}
/** The video bot's prompt for one take: the scenes in order with their timing, continuous camera motion between
 *  them, one soundtrack, and the end frame when the next take starts there. */
function takePrompt(scenes = [], { endFrame = false, changes = '' } = {}) {
  const total = scenes.reduce((a, s) => a + sceneS(s), 0);
  let at = 0;
  const parts = scenes.map((s, i) => { const a = at; at += sceneS(s); return `scene ${i + 1} (${Math.round(a * 10) / 10}–${Math.round(at * 10) / 10} s): ${String(s.camera || '').trim()}. ${String(s.action || '').trim()}`.replace(/\s+/g, ' ').replace(/\.\s*\./g, '.').replace(/[.\s]+$/, ''); });
  const product = scenes.some((s) => s.product && s.product.visible) ? ' The device stays exactly as in the keyframes — no morphing, no extra buttons, no logos.' : '';
  return [
    scenes.length > 1
      ? `ONE continuous single-take video of about ${Math.round(total)} seconds — no cuts, no fades, never separate clips joined together. It flows through ${scenes.length} scenes in order, each one matching its keyframe (scene_keyframe_urls, in the same order; the first is first_frame_url): ${parts.join('; ')}.`
      : `One continuous shot of about ${Math.round(total)} seconds: ${parts[0] || ''}.`,
    scenes.length > 1 ? 'Carry the camera from each scene into the next with one continuous motion (a push-in, pan, orbit, follow or match-move through the action) so the whole video plays as one flowing shot, with the same character, wardrobe, product, setting and lighting throughout.' : 'One continuous motion, no cuts.',
    'One continuous soundtrack and ambience for the whole video — the sound never restarts.',
    endFrame ? 'End exactly on end_frame_url: the next part of the video starts on that frame.' : '',
    `${product.trim()} Present tense, no on-screen text, no captions.`,
    changes ? `Changes requested by the reviewer (apply only these, keep everything else): ${changes}.` : '',
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
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

// ---------- product focus: the Galaxy Z Fold8 family (owner 2026-11-02) ----------
const FOCUS_PRODUCTS = ['Galaxy Z Fold8', 'Galaxy Z Fold8 Ultra'];
/** Share of new campaign ideas steered to the focus family: MAISTRO_FOCUS_WEIGHT 0–1, default 0.5. */
const focusWeight = () => { const v = Number(process.env.MAISTRO_FOCUS_WEIGHT); return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.5; };
const FOCUS_INSTRUCTION = 'PRODUCT FOCUS (Samsung Gulf priority): feature the Galaxy Z Fold8 or the Galaxy Z Fold8 Ultra in this campaign, whichever fits the trend better. Pick an angle where the UNFOLD is the story\'s product moment: the device opening from phone to big screen is the turn the whole piece builds to.';
/** Does the user's own input already name a catalog product? Then the focus never overrides it. */
function namesProduct(text, catalogNames = []) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return catalogNames.some((n) => t.includes(String(n).toLowerCase())) || /\b(fold\s?\d|flip\s?\d|s\d{2}|watch\s?\d|buds|tab\s?s\d|bespoke|the frame|neo qled|oled|odyssey|galaxy book|ring)\b/i.test(t);
}
/** Steer this idea to the focus family? Never when the user picked a product; else with probability focusWeight(). */
function focusPick({ userProduct, userText, catalogNames = [], rand = Math.random } = {}) {
  if (userProduct || namesProduct(userText, catalogNames)) return false;
  return rand() < focusWeight();
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
  PRODUCT_SPECS, AGENT_PRODUCT_CODES, productSpec, productLine, productImages, coloursOf,
  BUDGET_DEFAULTS, BUDGET_FLOORS, budgets, budgetFor, FOCUS_PRODUCTS, focusWeight, FOCUS_INSTRUCTION, namesProduct, focusPick,
  TEST_MODE_INSTRUCTION, TEST_MODE_MAX_CREDITS, testMode, TEXT_RULE, END_CARD_RULE, LOOK_REF_RULE,
  SCHEMAS, validate, normQa, normFrame, normStory, wantsNewFrame, botError, interpret, reviewResult, fixAction,
  ORDER, orderCheck, orderMode, currentKeyframe, approvedKeyframe, staleClips, TAKE_MAX_S, takesFrom, takePrompt, botShot, storyFrom, shotsFromFrames, redact,
};
