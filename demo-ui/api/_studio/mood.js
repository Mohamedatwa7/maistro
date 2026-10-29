// Stage 1 — Moodboard (Phase 6.2). Claude produces THREE distinct moods, each a
// STRUCTURED visual direction (setting, named palette, lighting, mood, styling,
// wardrobe, composition, camera feel, how the trend's visual language is
// adapted to Samsung); the moodboard bot renders a small set per mood and the
// person picks the mood the video follows (owner 2026-10-29). Numbers and
// names come from the knowledge base; nothing here invents product facts —
// the product is its 3D model's views when one exists, else the catalog look line.
const { registerPrompt, recordGeneration } = require('../_records.js');

const VERSION = 'mood-direction-v2-2026-10-29'; // v2: three moods to pick from
const MODEL = () => process.env.MAISTRO_STUDIO_MODEL || 'claude-opus-5-5';
const TILES = 4; // legacy single-direction set (v1 versions)
const MOODS = 3, PER_MOOD = 2; // v2: three moods, two images each

const SYSTEM = [
  'You are the art director inside MAISTRO, Samsung Gulf\'s content platform. You produce THREE alternative MOODS for a campaign before any image is generated; the person picks one and the whole video follows it.',
  'The three moods must be clearly different from each other (setting, light, energy, palette emphasis) — for example one calm and premium, one bold and energetic, one warm and everyday — while each stays on-brand and fits the trend and the campaign. Give each a short evocative name (2–4 words) and a one-sentence pitch a non-technical marketer understands.',
  'Rules for every mood: concrete and reproducible (named colours with hex codes from the brand palette, named lighting, named materials); adapt the TREND\'s visual language to Samsung\'s Confident Explorer persona and Refined Wit; blue present and intentional; no competitor devices or logos, no real identifiable people, no text inside images, nothing against the Gulf cultural rules you are given.',
  'The product: never describe its shape, colour or features beyond the catalog look line. When a 3D MODEL of the product exists, the renders are held to it exactly, so refer to it only as "the exact product" and leave its geometry to the model.',
].join('\n');

const DIRECTION_PROPS = {
  setting: { type: 'string' }, lighting: { type: 'string' }, mood: { type: 'string' }, styling: { type: 'string' }, wardrobe: { type: 'string' },
  compositionStyle: { type: 'string' }, cameraFeel: { type: 'string' }, trendAdaptation: { type: 'string' },
  leadingPrinciple: { type: 'string', enum: ['Openly invite', 'Boldly lead', 'Authentically grounded'] },
  palette: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'hex', 'role'], properties: { name: { type: 'string' }, hex: { type: 'string' }, role: { type: 'string', enum: ['dominant', 'secondary', 'accent'] } } } },
};
const DIRECTION_KEYS = ['setting', 'palette', 'lighting', 'mood', 'styling', 'wardrobe', 'compositionStyle', 'cameraFeel', 'trendAdaptation', 'leadingPrinciple'];
const OPTION = { type: 'object', additionalProperties: false, required: ['name', 'pitch', ...DIRECTION_KEYS], properties: { name: { type: 'string' }, pitch: { type: 'string' }, ...DIRECTION_PROPS } };
const SCHEMA = { type: 'object', additionalProperties: false, required: ['options'], properties: { options: { type: 'array', items: OPTION } } };

function userMessage({ piece, trend, userInput, productLook, rules, palette, hasModel }) {
  return [
    `CAMPAIGN: ${JSON.stringify({ title: piece.title, product: piece.product, keyMessage: piece.msg, angle: piece.angle, markets: piece.markets, platforms: piece.platforms }, null, 1)}`,
    `PRODUCT (catalog look line — the only product facts you may use): ${piece.product}: ${productLook || 'not in the catalog — do not describe the device'}${hasModel ? '\n3D MODEL: yes — every render is held to the product\'s exact 3D model (shape, size, colours, cameras, buttons); call it "the exact product".' : ''}`,
    trend ? `TREND: ${JSON.stringify(trend, null, 1)}` : 'TREND: none (free brief)',
    `BRAND PALETTE (use these names and hexes): ${JSON.stringify(palette)}`,
    `CULTURAL RULES: ${JSON.stringify(rules)}`,
    `WHAT THE USER ASKED FOR: "${String(userInput || '').trim() || '(left to you)'}"`,
    `Produce exactly ${MOODS} clearly different moods.`,
  ].join('\n\n');
}

function validateDirection(d) {
  const p = [];
  if (!d || typeof d !== 'object') return ['$: object required'];
  for (const k of ['setting', 'lighting', 'mood', 'styling', 'wardrobe', 'compositionStyle', 'cameraFeel', 'trendAdaptation']) if (typeof d[k] !== 'string' || !d[k].trim()) p.push(`${k}: required`);
  if (!Array.isArray(d.palette) || d.palette.length < 2 || d.palette.length > 8) p.push('palette: 2–8 colours');
  else d.palette.forEach((c, i) => { if (!/^#[0-9a-fA-F]{6}$/.test(String(c.hex || ''))) p.push(`palette[${i}].hex: #rrggbb`); });
  // v1 directions carried four tile prompts; v2 moods have none
  if (d.tiles !== undefined) {
    if (!Array.isArray(d.tiles) || d.tiles.length !== TILES) p.push(`tiles: exactly ${TILES}`);
    (Array.isArray(d.tiles) ? d.tiles : []).forEach((t, i) => { if (typeof t.prompt !== 'string' || t.prompt.split(/\s+/).length > 110) p.push(`tiles[${i}].prompt: ≤ 110 words`); if (/\b(iphone|pixel|xiaomi|oppo|huawei|apple)\b/i.test(String(t.prompt || ''))) p.push(`tiles[${i}].prompt: names a competitor`); });
  }
  if (/\b(iphone|pixel|xiaomi|oppo|huawei|apple)\b/i.test(DIRECTION_KEYS.filter((k) => typeof d[k] === 'string').map((k) => d[k]).join(' '))) p.push('direction: names a competitor');
  return p;
}

/** The three moods: each a complete direction with a name and a pitch, and no two with the same name. */
function validateMoods(j) {
  if (!j || !Array.isArray(j.options)) return ['options: array required'];
  const p = [];
  if (j.options.length !== MOODS) p.push(`options: exactly ${MOODS}`);
  j.options.forEach((o, i) => {
    if (typeof o.name !== 'string' || !o.name.trim()) p.push(`options[${i}].name: required`);
    if (typeof o.pitch !== 'string' || !o.pitch.trim()) p.push(`options[${i}].pitch: required`);
    for (const x of validateDirection(o)) p.push(`options[${i}].${x}`);
  });
  const names = j.options.map((o) => String(o.name || '').trim().toLowerCase());
  if (new Set(names).size !== names.length) p.push('options: the moods need different names');
  return p;
}

/** One structured-output call → { options: [3 moods] } or { error, problems }. */
async function visualDirections({ piece, trend, userInput, productLook, rules, palette, hasModel, client, memberId }) {
  const Anthropic = client ? null : require('@anthropic-ai/sdk');
  const c = client || new Anthropic({ timeout: 90000, maxRetries: 1 });
  registerPrompt('studio.mood.direction', VERSION, `SYSTEM:\n${SYSTEM}\n\nUSER: campaign {{campaign}} product {{productLook}} trend {{trend}} palette {{palette}} rules {{rules}} ask {{userInput}}`, ['campaign', 'productLook', 'trend', 'palette', 'rules', 'userInput']);
  const user = userMessage({ piece, trend, userInput, productLook, rules, palette, hasModel });
  const t0 = Date.now();
  const rec = { kind: 'claude', legacyPieceId: piece.id, stage: 'mood', model: MODEL(), promptName: 'studio.mood.direction', promptVersion: VERSION, resolvedPrompt: `${SYSTEM}\n\n${user}`, userPrompt: user, params: { max_tokens: 8000, moods: MOODS }, memberId };
  let response;
  try {
    response = await c.messages.create({ model: MODEL(), max_tokens: 8000, system: SYSTEM, messages: [{ role: 'user', content: user }], output_config: { format: { type: 'json_schema', schema: SCHEMA } } });
  } catch (e) { await recordGeneration({ ...rec, status: 'failed', error: e.message, latencyMs: Date.now() - t0 }); throw e; }
  const text = response.content && response.content.find((b) => b.type === 'text');
  if (!text) { await recordGeneration({ ...rec, status: 'failed', error: `no text (stop_reason ${response.stop_reason})`, latencyMs: Date.now() - t0 }); return { error: `no text block (stop_reason ${response.stop_reason})` }; }
  let j; try { j = JSON.parse(text.text); } catch (e) { await recordGeneration({ ...rec, status: 'failed', error: 'malformed JSON', latencyMs: Date.now() - t0 }); return { error: 'malformed JSON' }; }
  const problems = validateMoods(j);
  if (problems.length) { await recordGeneration({ ...rec, status: 'failed', error: `validation: ${problems.slice(0, 3).join('; ')}`, latencyMs: Date.now() - t0, usage: response.usage }); return { error: 'moods failed validation', problems }; }
  await recordGeneration({ ...rec, status: 'succeeded', latencyMs: Date.now() - t0, usage: response.usage || null });
  return { options: j.options, promptVersion: VERSION, model: MODEL(), usage: response.usage || null };
}

/** The Soul prompt for a tile: the tile prompt plus the shared direction anchors. */
function tilePrompt(direction, tile, productLook) {
  const pal = (direction.palette || []).map((c) => `${c.name} ${c.hex}`).join(', ');
  return `${tile.prompt} Art direction: ${direction.lighting}; ${direction.compositionStyle}; ${direction.cameraFeel}. Palette: ${pal}. ${productLook ? `The device, when shown, is exactly: ${productLook}.` : ''} No text, no logos, no competitor devices, no real identifiable people.`.replace(/\s+/g, ' ').trim();
}

/** The set prompt for one mood: the bot renders ONE prompt as a small batch of variations, so the
 *  prompt is that mood's whole direction (setting, product, lighting, styling, palette). With a 3D model
 *  the device is the exact product from its renders (product_image_urls), never a description. */
function setPrompt(direction, productLook, hasModel) {
  const pal = (direction.palette || []).map((c) => `${c.name} ${c.hex}`).join(', ');
  const subject = hasModel ? 'featuring the exact product from the reference renders of its 3D model (identical shape, proportions, size, colours, camera layout and buttons),'
    : productLook ? `featuring the device, which is exactly: ${productLook},` : 'without any phone or device,';
  return `${direction.setting}, ${subject} ${direction.styling}; ${direction.wardrobe ? `wardrobe: ${direction.wardrobe};` : ''} ${direction.trendAdaptation || ''} Art direction: ${direction.lighting}; ${direction.compositionStyle}; ${direction.cameraFeel}; mood: ${direction.mood}. Palette: ${pal}. No text, no logos, no competitor devices, no real identifiable people.`.replace(/\s+/g, ' ').trim();
}

/** The direction fields of a mood (its name and pitch kept alongside). */
const directionOf = (o) => Object.fromEntries(['name', 'pitch', ...DIRECTION_KEYS].filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/** The stored v2 moodboard: three moods with empty image slots the jobs fill in. `images` stays the flat
 *  list (mood 1's slots, then mood 2's, …) so tile indexes, checks and the approval selection keep working. */
function moodsArtifact(options, { promptVersion, prompts }) {
  const moods = options.map((o, i) => ({ n: i + 1, name: o.name, pitch: o.pitch, direction: directionOf(o), prompt: prompts[i], state: 'pending', jobId: null, error: null }));
  const images = moods.flatMap((m) => Array.from({ length: PER_MOOD }, (_, k) => ({ mood: m.n, state: 'pending', url: null, assetPath: null, tag: `${m.name} · ${k + 1}` })));
  return { setMode: 'moods', moods, images, chosen: null, direction: null, directionVersion: promptVersion, prompt: `${moods.length} moods to pick from`, note: `Pick one of ${moods.length} moods — the brief, storyboard and video follow it.` };
}

/** Index of a mood's first image slot in the flat list. */
const slotOf = (moodN) => (moodN - 1) * PER_MOOD;

module.exports = { VERSION, SYSTEM, SCHEMA, TILES, MOODS, PER_MOOD, visualDirections, validateDirection, validateMoods, tilePrompt, setPrompt, moodsArtifact, slotOf, directionOf, userMessage };
