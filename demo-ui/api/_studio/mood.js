// Stage 1 — Moodboard (Phase 6.2). Claude produces a STRUCTURED visual
// direction first (setting, named palette, lighting, mood, styling,
// wardrobe, composition, camera feel, how the trend's visual language is
// adapted to Samsung) and one Soul prompt per board tile; Soul then renders
// a set. Numbers and names come from the knowledge base; nothing here
// invents product facts — the catalog look line is the product description.
const { registerPrompt, recordGeneration } = require('../_records.js');

const VERSION = 'mood-direction-v1-2026-10-21';
const MODEL = () => process.env.MAISTRO_STUDIO_MODEL || 'claude-opus-4-8';
const TILES = 4; // Soul v2 batch size

const SYSTEM = [
  'You are the art director inside MAISTRO, Samsung Gulf\'s content platform. You produce the VISUAL DIRECTION for a campaign moodboard before any image is generated.',
  'Rules: the direction must be concrete and reproducible (named colours with hex codes from the brand palette, named lighting, named materials); it must adapt the TREND\'s visual language to Samsung\'s Confident Explorer persona and Refined Wit; blue must be present and intentional; no competitor devices or logos, no real identifiable people, no text inside images, nothing against the Gulf cultural rules you are given.',
  'The product is described ONLY by its catalog look line — never add features, colours or claims that are not in the catalog.',
  'Produce exactly four image prompts, each demonstrating a different facet of the direction (for example: palette and materials; the product in its setting; lighting and mood; the trend mechanic adapted). Each prompt is a complete Soul text-to-image prompt under 90 words that describes a single cohesive board tile — not a collage — in the stated direction.',
].join('\n');

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['setting', 'palette', 'lighting', 'mood', 'styling', 'wardrobe', 'compositionStyle', 'cameraFeel', 'trendAdaptation', 'leadingPrinciple', 'tiles'],
  properties: {
    setting: { type: 'string' }, lighting: { type: 'string' }, mood: { type: 'string' }, styling: { type: 'string' }, wardrobe: { type: 'string' },
    compositionStyle: { type: 'string' }, cameraFeel: { type: 'string' }, trendAdaptation: { type: 'string' },
    leadingPrinciple: { type: 'string', enum: ['Openly invite', 'Boldly lead', 'Authentically grounded'] },
    palette: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'hex', 'role'], properties: { name: { type: 'string' }, hex: { type: 'string' }, role: { type: 'string', enum: ['dominant', 'secondary', 'accent'] } } } },
    tiles: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['tag', 'demonstrates', 'prompt'], properties: { tag: { type: 'string' }, demonstrates: { type: 'string' }, prompt: { type: 'string' } } } },
  },
};

function userMessage({ piece, trend, userInput, productLook, rules, palette }) {
  return [
    `CAMPAIGN: ${JSON.stringify({ title: piece.title, product: piece.product, keyMessage: piece.msg, angle: piece.angle, markets: piece.markets, platforms: piece.platforms }, null, 1)}`,
    `PRODUCT (catalog look line — the only product facts you may use): ${piece.product}: ${productLook || 'not in the catalog — do not describe the device'}`,
    trend ? `TREND: ${JSON.stringify(trend, null, 1)}` : 'TREND: none (free brief)',
    `BRAND PALETTE (use these names and hexes): ${JSON.stringify(palette)}`,
    `CULTURAL RULES: ${JSON.stringify(rules)}`,
    `WHAT THE USER ASKED FOR: "${String(userInput || '').trim() || '(left to you)'}"`,
    'Produce the visual direction and the four tile prompts.',
  ].join('\n\n');
}

function validateDirection(d) {
  const p = [];
  if (!d || typeof d !== 'object') return ['$: object required'];
  for (const k of ['setting', 'lighting', 'mood', 'styling', 'wardrobe', 'compositionStyle', 'cameraFeel', 'trendAdaptation']) if (typeof d[k] !== 'string' || !d[k].trim()) p.push(`${k}: required`);
  if (!Array.isArray(d.palette) || d.palette.length < 2 || d.palette.length > 8) p.push('palette: 2–8 colours');
  else d.palette.forEach((c, i) => { if (!/^#[0-9a-fA-F]{6}$/.test(String(c.hex || ''))) p.push(`palette[${i}].hex: #rrggbb`); });
  if (!Array.isArray(d.tiles) || d.tiles.length !== TILES) p.push(`tiles: exactly ${TILES}`);
  (Array.isArray(d.tiles) ? d.tiles : []).forEach((t, i) => { if (typeof t.prompt !== 'string' || t.prompt.split(/\s+/).length > 110) p.push(`tiles[${i}].prompt: ≤ 110 words`); if (/\b(iphone|pixel|xiaomi|oppo|huawei|apple)\b/i.test(String(t.prompt || ''))) p.push(`tiles[${i}].prompt: names a competitor`); });
  return p;
}

/** One structured-output call → { direction } or { error, problems }. */
async function visualDirection({ piece, trend, userInput, productLook, rules, palette, client, memberId }) {
  const Anthropic = client ? null : require('@anthropic-ai/sdk');
  const c = client || new Anthropic({ timeout: 90000, maxRetries: 1 });
  registerPrompt('studio.mood.direction', VERSION, `SYSTEM:\n${SYSTEM}\n\nUSER: campaign {{campaign}} product {{productLook}} trend {{trend}} palette {{palette}} rules {{rules}} ask {{userInput}}`, ['campaign', 'productLook', 'trend', 'palette', 'rules', 'userInput']);
  const user = userMessage({ piece, trend, userInput, productLook, rules, palette });
  const t0 = Date.now();
  const rec = { kind: 'claude', legacyPieceId: piece.id, stage: 'mood', model: MODEL(), promptName: 'studio.mood.direction', promptVersion: VERSION, resolvedPrompt: `${SYSTEM}\n\n${user}`, userPrompt: user, params: { max_tokens: 6000 }, memberId };
  let response;
  try {
    response = await c.messages.create({ model: MODEL(), max_tokens: 6000, system: SYSTEM, messages: [{ role: 'user', content: user }], output_config: { format: { type: 'json_schema', schema: SCHEMA } } });
  } catch (e) { await recordGeneration({ ...rec, status: 'failed', error: e.message, latencyMs: Date.now() - t0 }); throw e; }
  const text = response.content && response.content.find((b) => b.type === 'text');
  if (!text) { await recordGeneration({ ...rec, status: 'failed', error: `no text (stop_reason ${response.stop_reason})`, latencyMs: Date.now() - t0 }); return { error: `no text block (stop_reason ${response.stop_reason})` }; }
  let d; try { d = JSON.parse(text.text); } catch (e) { await recordGeneration({ ...rec, status: 'failed', error: 'malformed JSON', latencyMs: Date.now() - t0 }); return { error: 'malformed JSON' }; }
  const problems = validateDirection(d);
  if (problems.length) { await recordGeneration({ ...rec, status: 'failed', error: `validation: ${problems.slice(0, 3).join('; ')}`, latencyMs: Date.now() - t0, usage: response.usage }); return { error: 'direction failed validation', problems }; }
  await recordGeneration({ ...rec, status: 'succeeded', latencyMs: Date.now() - t0, usage: response.usage || null });
  return { direction: d, promptVersion: VERSION, model: MODEL(), usage: response.usage || null };
}

/** The Soul prompt for a tile: the tile prompt plus the shared direction anchors. */
function tilePrompt(direction, tile, productLook) {
  const pal = (direction.palette || []).map((c) => `${c.name} ${c.hex}`).join(', ');
  return `${tile.prompt} Art direction: ${direction.lighting}; ${direction.compositionStyle}; ${direction.cameraFeel}. Palette: ${pal}. ${productLook ? `The device, when shown, is exactly: ${productLook}.` : ''} No text, no logos, no competitor devices, no real identifiable people.`.replace(/\s+/g, ' ').trim();
}

module.exports = { VERSION, SYSTEM, SCHEMA, TILES, visualDirection, validateDirection, tilePrompt, userMessage };
