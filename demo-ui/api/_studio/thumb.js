// Stage 2 — Thumbnail (Phase 6.3): the cover that wins the scroll. The
// prompt is anchored to the APPROVED moodboard (its direction and the
// reviewer's selected tiles) and to the official product photo through the
// reference path; any headline is rendered as a code overlay in the
// browser (correct Arabic shaping and RTL), never inside the image; the
// platform decides the aspect; the overlay must sit inside the safe zone.
const { registerPrompt, recordGeneration } = require('../_records.js');
const { queryRows } = require('../_supabase.js');

const VERSION = 'thumb-prompt-v1-2026-10-21';
const MODEL = () => process.env.MAISTRO_STUDIO_MODEL || 'claude-opus-5-5';

// Safe zones as fractions of the frame — the stricter union of TikTok's
// in-feed template (top ~12.5 %, bottom ~34 %, sides ~6 %) and Reels'
// centre 1080×1420 area (13 % top and bottom); kb platform_specs marks
// these organic values unverified, so the overlay keeps the conservative one.
const SAFE_ZONE = { '9:16': { top: 0.13, bottom: 0.34, left: 0.06, right: 0.06 }, '16:9': { top: 0.08, bottom: 0.12, left: 0.06, right: 0.06 }, '1:1': { top: 0.08, bottom: 0.12, left: 0.06, right: 0.06 } };

/** 9:16 when every target platform is vertical-first; 16:9 only when a landscape platform is targeted. */
function aspectFor(platforms) {
  const p = (platforms || []).map((x) => String(x).toLowerCase());
  if (!p.length) return '16:9';
  return p.some((x) => x === 'youtube' || x === 'x' || x === 'twitter' || x === 'facebook') ? '16:9' : '9:16';
}

const SYSTEM = [
  'You write the generation prompt for a social-video THUMBNAIL inside MAISTRO (Samsung Gulf): ONE scroll-stopping key visual — a single bold subject, high contrast, cinematic lighting, shallow depth, instantly readable at phone size.',
  'It MUST continue the approved moodboard: reuse its palette (name the hexes), lighting, materials and mood, and the facets of the selected tiles you are given. The product is described only by its catalog look line; when an official product photo is attached, call the device "the exact product from the reference image" and never re-describe its shape.',
  'Reserve clean negative space on ONE side (left or right) where a headline will be overlaid later by code. Never put text, logos or watermarks inside the image. No real identifiable people, no competitor devices, nothing against the Gulf cultural rules.',
  'Return the prompt (under 110 words), which side is reserved for the headline, and a one-line note for the non-technical user.',
].join('\n');

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['prompt', 'textSide', 'note'],
  properties: { prompt: { type: 'string' }, textSide: { type: 'string', enum: ['left', 'right'] }, note: { type: 'string' } },
};

function validateThumb(j) {
  const p = [];
  if (!j || typeof j !== 'object') return ['$: object required'];
  if (typeof j.prompt !== 'string' || !j.prompt.trim()) p.push('prompt: required');
  else { if (j.prompt.split(/\s+/).length > 110) p.push('prompt: ≤ 110 words'); if (/\b(iphone|pixel|xiaomi|oppo|huawei|apple)\b/i.test(j.prompt)) p.push('prompt: names a competitor'); if (/\b(text|headline|caption|typography|lettering|words)\b/i.test(j.prompt) && !/no text|without text|free of text/i.test(j.prompt)) p.push('prompt: asks for text inside the image'); }
  if (!['left', 'right'].includes(j.textSide)) p.push('textSide: left|right');
  if (typeof j.note !== 'string') p.push('note: required');
  return p;
}

/** The approved (or current) moodboard: direction and the reviewer's selected tiles. */
async function moodContext(pieceId) {
  const [stage] = await queryRows('stages', `select=id,state,current_version_id&piece_id=eq.${encodeURIComponent(pieceId)}&kind=eq.mood&limit=1`);
  if (!stage || !stage.current_version_id) return { approved: false, direction: null, tiles: [] };
  const [v] = await queryRows('artifact_versions', `select=id,payload&id=eq.${encodeURIComponent(stage.current_version_id)}&limit=1`);
  const payload = (v && v.payload) || {};
  const approvals = await queryRows('approvals', `select=decision,details&artifact_version_id=eq.${encodeURIComponent(stage.current_version_id)}&decision=eq.approved&limit=1`);
  const sel = approvals[0] && approvals[0].details && Array.isArray(approvals[0].details.selectedImages) ? approvals[0].details.selectedImages : null;
  const images = Array.isArray(payload.images) ? payload.images : payload.imageUrl ? [{ url: payload.imageUrl, assetPath: payload.assetPath || null, tag: null }] : [];
  let tiles = images.map((im, i) => ({ index: i, ...im, selected: sel ? sel.includes(i) : true })).filter((t) => t.selected);
  let direction = payload.direction || null, chosen = null;
  if (payload.setMode === 'moods' && Array.isArray(payload.moods)) {
    // three moods: everything downstream follows the one the person picked (approval, else the pick on the
    // version); until a pick, the first mood that rendered stands in so no stage has to wait
    const details = (approvals[0] && approvals[0].details) || {};
    const pickedN = Number(details.chosenMood) || Number(payload.chosen) || null;
    const m = payload.moods.find((x) => x.n === pickedN) || payload.moods.find((x) => x.state === 'rendered') || null;
    chosen = m ? { n: m.n, name: m.name, pitch: m.pitch, picked: Boolean(pickedN && m.n === pickedN) } : null;
    direction = m ? m.direction : null;
    tiles = tiles.filter((t) => m && t.mood === m.n && t.state === 'rendered');
  }
  return { approved: stage.state === 'approved', direction, chosen, tiles, annotations: approvals[0] && approvals[0].details ? approvals[0].details.annotations || null : null, note: payload.note || null, prompt: payload.prompt || null };
}

async function thumbPrompt({ piece, mood, productLook, rules, userInput, refAttached, aspect, client, memberId }) {
  const Anthropic = client ? null : require('@anthropic-ai/sdk');
  const c = client || new Anthropic({ timeout: 90000, maxRetries: 1 });
  registerPrompt('studio.thumb.prompt', VERSION, `SYSTEM:\n${SYSTEM}\n\nUSER: campaign {{campaign}} product {{productLook}} mood {{mood}} aspect {{aspect}} rules {{rules}} ask {{userInput}}`, ['campaign', 'productLook', 'mood', 'aspect', 'rules', 'userInput']);
  const d = mood.direction || {};
  const user = [
    `CAMPAIGN: ${JSON.stringify({ title: piece.title, product: piece.product, keyMessage: piece.msg, angle: piece.angle, markets: piece.markets, platforms: piece.platforms }, null, 1)}`,
    `PRODUCT (catalog look line): ${piece.product}: ${productLook || 'not in the catalog — do not describe the device'}${refAttached ? ' — an OFFICIAL PRODUCT PHOTO is attached as the image reference.' : ''}`,
    `APPROVED MOODBOARD${mood.approved ? '' : ' (not yet approved — current version)'}: ${JSON.stringify({ leadingPrinciple: d.leadingPrinciple, palette: d.palette, lighting: d.lighting, mood: d.mood, styling: d.styling, compositionStyle: d.compositionStyle, cameraFeel: d.cameraFeel, selectedTiles: mood.tiles.map((t) => t.tag || `tile ${t.index + 1}`), reviewerAnnotations: mood.annotations, legacyNote: mood.direction ? null : mood.note }, null, 1)}`,
    `ASPECT: ${aspect} (${aspect === '9:16' ? 'vertical cover for TikTok / Reels' : 'landscape cover'})`,
    `CULTURAL RULES: ${JSON.stringify(rules || [])}`,
    `WHAT THE USER ASKED FOR: "${String(userInput || '').trim() || '(left to you)'}"`,
  ].join('\n\n');
  const t0 = Date.now();
  const rec = { kind: 'claude', legacyPieceId: piece.id, stage: 'thumb', model: MODEL(), promptName: 'studio.thumb.prompt', promptVersion: VERSION, resolvedPrompt: `${SYSTEM}\n\n${user}`, userPrompt: user, params: { aspect, refAttached: Boolean(refAttached) }, memberId };
  let response;
  try { response = await c.messages.create({ model: MODEL(), max_tokens: 3000, system: SYSTEM, messages: [{ role: 'user', content: user }], output_config: { format: { type: 'json_schema', schema: SCHEMA } } }); }
  catch (e) { await recordGeneration({ ...rec, status: 'failed', error: e.message, latencyMs: Date.now() - t0 }); throw e; }
  const text = response.content && response.content.find((b) => b.type === 'text');
  let j; try { j = JSON.parse(text ? text.text : ''); } catch (e) { await recordGeneration({ ...rec, status: 'failed', error: 'malformed JSON', latencyMs: Date.now() - t0 }); return { error: 'malformed JSON' }; }
  const problems = validateThumb(j);
  if (problems.length) { await recordGeneration({ ...rec, status: 'failed', error: `validation: ${problems.join('; ')}`, latencyMs: Date.now() - t0, usage: response.usage }); return { error: 'thumbnail prompt failed validation', problems }; }
  await recordGeneration({ ...rec, status: 'succeeded', latencyMs: Date.now() - t0, usage: response.usage || null });
  return { prompt: j.prompt, textSide: j.textSide, note: j.note, promptVersion: VERSION, model: MODEL() };
}

/** Overlay geometry for the page (fractions of the frame), inside the safe zone. */
function overlayBox(aspect, side) {
  const z = SAFE_ZONE[aspect] || SAFE_ZONE['16:9'];
  const width = aspect === '9:16' ? 0.84 : 0.44;
  return { top: z.top, bottom: z.bottom, left: side === 'right' ? 1 - z.right - width : z.left, width, safeZone: z, aspect };
}

module.exports = { VERSION, SYSTEM, SCHEMA, SAFE_ZONE, aspectFor, validateThumb, moodContext, thumbPrompt, overlayBox };
