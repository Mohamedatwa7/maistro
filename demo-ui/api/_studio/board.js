// Stage 4 — Storyboard (Phase 6.5): define every shot precisely before
// spending on video. Claude writes the shot list from the APPROVED brief
// (duration, type, camera, action, product visibility and feature, on-screen
// text, line, audio cue, transition); the checks that are arithmetic or
// coverage run in code; one Sonnet call judges the trend mechanic and the
// hook; Soul renders ONE keyframe per shot through the job service, anchored
// to the selected moodboard tiles and the catalog product (reference path),
// and every keyframe gets the vision check with the previous keyframe as an
// extra anchor (cross-shot consistency). Shots are reviewed one by one; only
// rejected shots regenerate.
const { registerPrompt, recordGeneration } = require('../_records.js');
const { queryRows } = require('../_supabase.js');

const VERSION = 'storyboard-v1-2026-10-21';
const CHECK_VERSION = 'storyboard-check-v1-2026-10-21';
const MODEL = () => process.env.MAISTRO_STUDIO_MODEL || 'claude-opus-5-5';
const CHECK_MODEL = () => process.env.MAISTRO_VISION_MODEL || 'claude-sonnet-5-5';
const SHOT_TYPES = ['wide', 'medium', 'close_up', 'macro', 'pov', 'insert', 'end_card'];
const TRANSITIONS = ['cut', 'match_cut', 'whip', 'dissolve', 'hold', 'none'];
const MIN_SHOTS = 3, MAX_SHOTS = 8;
const DURATION_TOLERANCE = 0.1; // ±10 % of the brief's target
const HOOK_WINDOW_S = 3;

const SHOT = {
  type: 'object', additionalProperties: false,
  required: ['n', 'durationS', 'type', 'camera', 'action', 'product', 'onScreenText', 'line', 'audioCue', 'transition'],
  properties: {
    n: { type: 'integer' }, durationS: { type: 'number' }, type: { type: 'string', enum: SHOT_TYPES }, camera: { type: 'string' }, action: { type: 'string' },
    product: { type: 'object', additionalProperties: false, required: ['visible', 'feature'], properties: { visible: { type: 'boolean' }, feature: { type: 'string' } } },
    onScreenText: { type: 'object', additionalProperties: false, required: ['en', 'ar'], properties: { en: { type: 'string' }, ar: { type: 'string' } } },
    line: { type: 'object', additionalProperties: false, required: ['en', 'ar'], properties: { en: { type: 'string' }, ar: { type: 'string' } } },
    audioCue: { type: 'string' }, transition: { type: 'string', enum: TRANSITIONS },
  },
};
const SCHEMA = { type: 'object', additionalProperties: false, required: ['shots', 'hookShot', 'notes'], properties: { shots: { type: 'array', items: SHOT }, hookShot: { type: 'integer' }, notes: { type: 'string' } } };

const SYSTEM = [
  'You are Frame, the storyboard writer inside MAISTRO (Samsung Gulf social video). You turn an APPROVED BRIEF into a precise shot list that a video model will render shot by shot.',
  'Rules: between 3 and 8 shots; the durations add up to the brief\'s target duration; the hook lands inside the first 3 seconds; every feature the brief lists appears in a shot where the product is visible; the key message appears as on-screen text or a line; the CTA appears in the last two shots; the final shot is the end card (type "end_card": Samsung logo, no product action, a hold).',
  'Each shot: one camera angle AND movement in `camera` (e.g. "low angle, slow push-in"), one concrete action, whether the product is visible and which catalog feature it shows ("" when none), on-screen text en/ar ("" when none — keep it to a few words, it is overlaid in code), the voiceover or caption line en/ar, an audio cue, and the transition INTO the next shot.',
  'Follow the trend\'s mechanic beat by beat so the piece is recognisable as the trend, inside the approved moodboard\'s setting, palette and lighting. The product is only ever the catalog product; never describe its shape beyond the catalog look line. Arabic lines read as native Gulf Arabic, never literal translations. No real identifiable people, no competitor devices, nothing against the cultural rules.',
  'Return the shots, which shot carries the hook, and a one-line note for the user.',
].join('\n');

const CHECK_SYSTEM = [
  'You review a storyboard shot list for a Samsung Gulf social video against its trend profile and brief. Answer strictly from the material:',
  '1. TREND MECHANIC: do the shots reproduce the trend\'s mechanic beat by beat (yes | partial | no), with the beats that are missing?',
  '2. HOOK: is the first 3 seconds a real scroll-stopper for this trend (strong | ok | weak) and why?',
  '3. BRAND RISKS: anything a reviewer must see (cultural, competitor, claim, tone) — empty when none.',
].join('\n');
const CHECK_SCHEMA = { type: 'object', additionalProperties: false, required: ['followsTrendMechanic', 'missingBeats', 'hookStrength', 'hookNotes', 'risks'], properties: { followsTrendMechanic: { type: 'string', enum: ['yes', 'partial', 'no'] }, missingBeats: { type: 'array', items: { type: 'string' } }, hookStrength: { type: 'string', enum: ['strong', 'ok', 'weak'] }, hookNotes: { type: 'string' }, risks: { type: 'array', items: { type: 'string' } } } };

function validateShape(j) {
  const p = [];
  if (!j || typeof j !== 'object' || !Array.isArray(j.shots)) return ['shots: array required'];
  if (j.shots.length < MIN_SHOTS || j.shots.length > MAX_SHOTS) p.push(`shots: between ${MIN_SHOTS} and ${MAX_SHOTS}`);
  j.shots.forEach((s, i) => {
    if (s.n !== i + 1) p.push(`shots[${i}].n: must be ${i + 1}`);
    if (typeof s.durationS !== 'number' || !(s.durationS > 0) || s.durationS > 30) p.push(`shots[${i}].durationS: 0–30 s`);
    if (!SHOT_TYPES.includes(s.type)) p.push(`shots[${i}].type: enum`);
    if (!TRANSITIONS.includes(s.transition)) p.push(`shots[${i}].transition: enum`);
    if (typeof s.action !== 'string' || !s.action.trim()) p.push(`shots[${i}].action: required`);
    if (typeof s.camera !== 'string' || !s.camera.trim()) p.push(`shots[${i}].camera: required`);
    if (!s.product || typeof s.product.visible !== 'boolean') p.push(`shots[${i}].product.visible: boolean`);
    if (/\b(iphone|pixel|xiaomi|oppo|huawei|apple)\b/i.test(`${s.action} ${s.onScreenText && s.onScreenText.en} ${s.line && s.line.en}`)) p.push(`shots[${i}]: names a competitor`);
  });
  if (!Number.isInteger(j.hookShot) || j.hookShot < 1 || j.hookShot > j.shots.length) p.push('hookShot: a shot number');
  return p;
}

/** Numbers and coverage, computed in code. Each: {code, passed, detail}. */
function codeChecks(j, brief) {
  const out = [];
  const spec = brief && brief.spec ? brief.spec : null;
  const target = spec ? spec.format.targetDurationS : null;
  const total = Math.round(j.shots.reduce((s, x) => s + x.durationS, 0) * 10) / 10;
  if (target) out.push({ code: 'duration_matches_brief', passed: Math.abs(total - target) <= target * DURATION_TOLERANCE, detail: `${total} s vs brief ${target} s (±${Math.round(DURATION_TOLERANCE * 100)} %)` });
  else out.push({ code: 'duration_matches_brief', passed: false, detail: 'the brief has no structured target duration' });
  let t = 0, hookAt = null; for (const s of j.shots) { if (s.n === j.hookShot) { hookAt = t; break; } t += s.durationS; }
  out.push({ code: 'hook_in_first_seconds', passed: hookAt != null && hookAt < HOOK_WINDOW_S, detail: hookAt != null ? `hook (shot ${j.hookShot}) starts at ${hookAt} s` : 'hook shot not found' });
  const features = spec ? spec.products.flatMap((p) => p.features || []) : [];
  const shown = j.shots.filter((s) => s.product.visible).map((s) => String(s.product.feature || '').toLowerCase());
  const missingF = features.filter((f) => !shown.some((x) => x.includes(String(f).toLowerCase())));
  out.push({ code: 'features_covered', passed: missingF.length === 0 && (features.length === 0 || shown.length > 0), detail: missingF.length ? `features never shown: ${missingF.join(', ')}` : features.length ? `all ${features.length} feature(s) shown` : 'no features listed in the brief' });
  const km = spec ? String(spec.keyMessage || '').toLowerCase() : '';
  const copy = j.shots.map((s) => `${s.onScreenText.en} ${s.onScreenText.ar} ${s.line.en} ${s.line.ar}`.toLowerCase()).join(' ');
  const kmWords = km.split(/\W+/).filter((w) => w.length > 3);
  const kmHit = km && (copy.includes(km) || (kmWords.length && kmWords.filter((w) => copy.includes(w)).length >= Math.ceil(kmWords.length * 0.6)));
  out.push({ code: 'key_message_present', passed: Boolean(kmHit), detail: kmHit ? 'key message carried in text or line' : 'the key message does not appear in any on-screen text or line' });
  const cta = spec ? String(spec.cta || '').toLowerCase() : '';
  const lastTwo = j.shots.slice(-2).map((s) => `${s.onScreenText.en} ${s.line.en} ${s.action}`.toLowerCase()).join(' ');
  const ctaWords = cta.split(/\W+/).filter((w) => w.length > 2);
  const ctaHit = cta && (lastTwo.includes(cta) || (ctaWords.length && ctaWords.filter((w) => lastTwo.includes(w)).length >= Math.ceil(ctaWords.length * 0.5)));
  out.push({ code: 'cta_at_end', passed: Boolean(ctaHit), detail: ctaHit ? 'CTA in the last two shots' : 'CTA missing from the last two shots' });
  const last = j.shots[j.shots.length - 1];
  out.push({ code: 'end_card', passed: last.type === 'end_card' && /logo|samsung/i.test(`${last.action} ${last.onScreenText.en}`), detail: last.type === 'end_card' ? 'end card closes the piece' : 'the last shot is not an end card' });
  out.push({ code: 'product_visible', passed: j.shots.some((s) => s.product.visible), detail: `${j.shots.filter((s) => s.product.visible).length} shot(s) show the product` });
  return out;
}

async function briefFor(pieceId) {
  const [stage] = await queryRows('stages', `select=state,current_version_id&piece_id=eq.${encodeURIComponent(pieceId)}&kind=eq.brief&limit=1`);
  if (!stage || !stage.current_version_id) return null;
  const [v] = await queryRows('artifact_versions', `select=id,version,payload&id=eq.${encodeURIComponent(stage.current_version_id)}&limit=1`);
  return v ? { approved: stage.state === 'approved', versionId: v.id, version: v.version, payload: v.payload || {} } : null;
}

function userMessage({ piece, brief, mood, trend, judgement, productLook, rules, userInput }) {
  const d = mood.direction || {};
  const b = brief.payload;
  return [
    `CAMPAIGN: ${JSON.stringify({ title: piece.title, product: piece.product, markets: piece.markets, platforms: piece.platforms, trend: piece.trend_name }, null, 1)}`,
    `APPROVED BRIEF${brief.approved ? '' : ' (current version, not yet approved)'}: ${JSON.stringify(b.spec || { objective: b.objective, keyMessage: b.msg, mandatories: b.mandatories }, null, 1)}`,
    `TREND PROFILE: ${JSON.stringify(judgement ? judgement.profile : trend ? { name: trend.name, mechanic: trend.mechanic, why: trend.why, fit: trend.samsungFit } : 'not available — follow the brief\'s trend hook', null, 1)}`,
    `APPROVED MOODBOARD: ${JSON.stringify(mood.direction ? { leadingPrinciple: d.leadingPrinciple, setting: d.setting, palette: d.palette, lighting: d.lighting, mood: d.mood, styling: d.styling, wardrobe: d.wardrobe, compositionStyle: d.compositionStyle, cameraFeel: d.cameraFeel, selectedTiles: mood.tiles.map((t) => t.tag), reviewerAnnotations: mood.annotations } : { note: mood.note }, null, 1)}`,
    `PRODUCT (catalog look line): ${piece.product}: ${productLook || 'not in the catalog — the product cannot be shown'}`,
    `CULTURAL RULES: ${JSON.stringify(rules || [])}`,
    `WHAT THE USER ASKED FOR: "${String(userInput || '').trim() || '(left to you)'}"`,
  ].join('\n\n');
}

async function shotList({ piece, brief, mood, trend, judgement, productLook, rules, userInput, client, memberId, legacyId }) {
  const Anthropic = client ? null : require('@anthropic-ai/sdk');
  const c = client || new Anthropic({ timeout: 120000, maxRetries: 1 });
  registerPrompt('studio.storyboard', VERSION, `SYSTEM:\n${SYSTEM}\n\nUSER: campaign {{campaign}} brief {{brief}} trend {{trend}} mood {{mood}} product {{productLook}} rules {{rules}} ask {{userInput}}`, ['campaign', 'brief', 'trend', 'mood', 'productLook', 'rules', 'userInput']);
  const user = userMessage({ piece, brief, mood, trend, judgement, productLook, rules, userInput });
  const t0 = Date.now();
  const rec = { kind: 'claude', legacyPieceId: legacyId, stage: 'board', model: MODEL(), promptName: 'studio.storyboard', promptVersion: VERSION, resolvedPrompt: `${SYSTEM}\n\n${user}`, userPrompt: user, params: { briefVersion: brief.version, briefApproved: brief.approved }, memberId };
  let response;
  try { response = await c.messages.create({ model: MODEL(), max_tokens: 8000, system: SYSTEM, messages: [{ role: 'user', content: user }], output_config: { format: { type: 'json_schema', schema: SCHEMA } } }); }
  catch (e) { await recordGeneration({ ...rec, status: 'failed', error: e.message, latencyMs: Date.now() - t0 }); throw e; }
  const text = response.content && response.content.find((b) => b.type === 'text');
  let j; try { j = JSON.parse(text ? text.text : ''); } catch (e) { await recordGeneration({ ...rec, status: 'failed', error: 'malformed JSON', latencyMs: Date.now() - t0 }); return { error: 'malformed JSON' }; }
  const problems = validateShape(j);
  if (problems.length) { await recordGeneration({ ...rec, status: 'failed', error: `validation: ${problems.join('; ')}`, latencyMs: Date.now() - t0, usage: response.usage }); return { error: 'shot list failed validation', problems }; }
  await recordGeneration({ ...rec, status: 'succeeded', latencyMs: Date.now() - t0, usage: response.usage || null });
  return { list: j, promptVersion: VERSION, model: MODEL() };
}

async function mechanicCheck({ list, brief, trend, judgement, client, legacyId, memberId }) {
  const Anthropic = client ? null : require('@anthropic-ai/sdk');
  const c = client || new Anthropic({ timeout: 90000, maxRetries: 1 });
  registerPrompt('studio.storyboard.check', CHECK_VERSION, `SYSTEM:\n${CHECK_SYSTEM}\n\nUSER: shots {{shots}} brief {{brief}} trend {{trend}}`, ['shots', 'brief', 'trend']);
  const user = `SHOT LIST: ${JSON.stringify(list, null, 1)}\n\nBRIEF (trend hook, key message, CTA): ${JSON.stringify(brief.payload.spec ? { trendHook: brief.payload.spec.trendHook, keyMessage: brief.payload.spec.keyMessage, cta: brief.payload.spec.cta } : brief.payload.objective, null, 1)}\n\nTREND PROFILE: ${JSON.stringify(judgement ? judgement.profile : trend ? { name: trend.name, mechanic: trend.mechanic, why: trend.why } : 'none', null, 1)}`;
  const t0 = Date.now();
  const rec = { kind: 'claude', legacyPieceId: legacyId, stage: 'board', model: CHECK_MODEL(), promptName: 'studio.storyboard.check', promptVersion: CHECK_VERSION, resolvedPrompt: `${CHECK_SYSTEM}\n\n${user}`, userPrompt: user, params: {}, memberId };
  let response;
  try { response = await c.messages.create({ model: CHECK_MODEL(), max_tokens: 4000, system: CHECK_SYSTEM, messages: [{ role: 'user', content: user }], output_config: { format: { type: 'json_schema', schema: CHECK_SCHEMA }, effort: 'low' } }); }
  catch (e) { await recordGeneration({ ...rec, status: 'failed', error: e.message, latencyMs: Date.now() - t0 }); return { error: e.message }; }
  const text = response.content && response.content.find((b) => b.type === 'text');
  let j; try { j = JSON.parse(text ? text.text : ''); } catch (e) { await recordGeneration({ ...rec, status: 'failed', error: 'malformed JSON', latencyMs: Date.now() - t0 }); return { error: 'malformed JSON' }; }
  await recordGeneration({ ...rec, status: 'succeeded', latencyMs: Date.now() - t0, usage: response.usage || null });
  return { check: j, model: CHECK_MODEL(), promptVersion: CHECK_VERSION };
}

function checkFlags(check) {
  if (!check) return ['mechanic check unavailable'];
  const f = [];
  if (check.followsTrendMechanic === 'no') f.push('does not follow the trend mechanic');
  if (check.followsTrendMechanic === 'partial') f.push(`trend mechanic partly missing: ${(check.missingBeats || []).join(', ') || 'see notes'}`);
  if (check.hookStrength === 'weak') f.push(`weak hook: ${check.hookNotes}`);
  for (const r of check.risks || []) f.push(`risk: ${r}`);
  return f;
}

/** The Soul prompt for one shot's keyframe, anchored to the direction and the catalog look. */
function keyframePrompt(shot, direction, productLook, refAttached) {
  const d = direction || {};
  const pal = (d.palette || []).map((c) => `${c.name} ${c.hex}`).join(', ');
  const product = shot.product.visible ? (refAttached ? 'The device is the exact product from the reference image' : productLook ? `The device is exactly: ${productLook}` : 'no device shown') + (shot.product.feature ? `, showing ${shot.product.feature}` : '') + '.' : 'No phone or device in frame.';
  const type = shot.type === 'end_card' ? 'A clean end-card frame: Samsung Blue background, empty centre for a logo overlaid later' : `${shot.type.replace('_', ' ')} shot, ${shot.camera}`;
  return `${type}. ${shot.action} ${product} Setting: ${d.setting || 'as the moodboard'}. ${d.lighting ? `Lighting: ${d.lighting}.` : ''} ${d.styling ? `Styling: ${d.styling}.` : ''} ${d.wardrobe ? `Wardrobe: ${d.wardrobe}.` : ''} Palette: ${pal || 'Samsung Blue #1428A0 present and intentional'}. ${d.cameraFeel ? `Camera feel: ${d.cameraFeel}.` : ''} Single still frame, cinematic, no text, no logos, no competitor devices, no real identifiable people.`.replace(/\s+/g, ' ').trim();
}

/** The stored storyboard artifact: the shot list with empty keyframe slots the jobs fill in. */
function artifactFrom(list, meta) {
  return {
    shots: list.shots.map((s) => ({ ...s, keyframe: null, review: null })),
    hookShot: list.hookShot, notes: list.notes, totalS: Math.round(list.shots.reduce((a, s) => a + s.durationS, 0) * 10) / 10,
    boardVersion: meta.promptVersion || VERSION, briefVersionId: meta.briefVersionId || null, briefApproved: Boolean(meta.briefApproved), moodApproved: Boolean(meta.moodApproved), aspect: meta.aspect || '9:16',
    prompt: `storyboard of ${list.shots.length} shots`, note: list.notes,
  };
}

module.exports = { VERSION, CHECK_VERSION, SYSTEM, SCHEMA, CHECK_SCHEMA, SHOT_TYPES, TRANSITIONS, DURATION_TOLERANCE, HOOK_WINDOW_S, validateShape, codeChecks, briefFor, userMessage, shotList, mechanicCheck, checkFlags, keyframePrompt, artifactFrom };
