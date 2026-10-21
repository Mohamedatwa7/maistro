// Automated visual checks (Phase 6.2 "Automated checks"): a vision call
// looks at each generated image and answers fixed questions — product
// present where intended and consistent with the catalog look, no
// competitor device or logo, no real identifiable person, no prohibited
// imagery, palette and lighting match the stated direction, Gulf cultural
// rules respected. Verdicts are structured and stored; they flag, they do
// not decide — the human approval does.
const { registerPrompt, recordGeneration } = require('../_records.js');

const VERSION = 'vision-check-v1.1-2026-10-21'; // v1.1: anchors (moodboard consistency) and the reserved text side
const MODEL = () => process.env.MAISTRO_VISION_MODEL || 'claude-sonnet-5-5';

const SYSTEM = [
  'You check generated campaign images for MAISTRO (Samsung Gulf). Answer the fixed questions for EACH image from what is visible; never assume. "unsure" is allowed and means a human must look.',
  'Product consistency: compare the device shown with the catalog look line; a different form factor, an older generation\'s shape, a wrong colour or a competitor-like design is a mismatch.',
  'Prohibited: competitor devices or logos; readable text inside the image; real identifiable people or celebrities; minors; alcohol, gambling, drugs; revealing or suggestive dress or posing; religious or political symbols used as devices; tragedy or violence.',
  'Palette and lighting: judge against the named direction (colours by hex family, lighting by description).',
  'When ANCHOR images (the approved moodboard tiles) are given, judge whether each candidate image continues their palette, lighting, materials and mood: consistentWithMood yes | partial | no. When a reserved text side is given, say whether that side is clean negative space (textSpaceClear yes | partial | no).',
].join('\n');

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['images'],
  properties: {
    images: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['index', 'productPresent', 'productMatchesCatalog', 'competitorOrLogo', 'realPerson', 'textInImage', 'prohibitedImagery', 'paletteMatch', 'lightingMatch', 'culturalOk', 'consistentWithMood', 'textSpaceClear', 'notes'],
      properties: {
        consistentWithMood: { type: 'string', enum: ['yes', 'partial', 'no', 'n/a'] }, textSpaceClear: { type: 'string', enum: ['yes', 'partial', 'no', 'n/a'] },
        index: { type: 'integer' },
        productPresent: { type: 'string', enum: ['yes', 'no', 'unsure'] }, productMatchesCatalog: { type: 'string', enum: ['yes', 'no', 'unsure', 'n/a'] },
        competitorOrLogo: { type: 'string', enum: ['yes', 'no', 'unsure'] }, realPerson: { type: 'string', enum: ['yes', 'no', 'unsure'] }, textInImage: { type: 'string', enum: ['yes', 'no', 'unsure'] },
        prohibitedImagery: { type: 'string', enum: ['yes', 'no', 'unsure'] }, paletteMatch: { type: 'string', enum: ['yes', 'partial', 'no'] }, lightingMatch: { type: 'string', enum: ['yes', 'partial', 'no'] },
        culturalOk: { type: 'string', enum: ['yes', 'no', 'unsure'] }, notes: { type: 'string' },
      } } },
  },
};

/** Pass = no hard failure and no "unsure" on the safety questions; flags list what to look at. */
function verdict(img, expectProduct) {
  const flags = [];
  if (expectProduct && img.productPresent === 'no') flags.push('product missing');
  if (expectProduct && img.productMatchesCatalog === 'no') flags.push('product does not match the catalog');
  if (img.competitorOrLogo !== 'no') flags.push(img.competitorOrLogo === 'yes' ? 'competitor device or logo' : 'competitor/logo unsure');
  if (img.realPerson !== 'no') flags.push(img.realPerson === 'yes' ? 'real identifiable person' : 'person unsure');
  if (img.textInImage === 'yes') flags.push('text inside the image');
  if (img.prohibitedImagery !== 'no') flags.push(img.prohibitedImagery === 'yes' ? 'prohibited imagery' : 'prohibited imagery unsure');
  if (img.culturalOk !== 'yes') flags.push(img.culturalOk === 'no' ? 'cultural rule broken' : 'cultural fit unsure');
  if (img.paletteMatch === 'no') flags.push('palette off-direction');
  if (img.lightingMatch === 'no') flags.push('lighting off-direction');
  if (img.consistentWithMood === 'no') flags.push('inconsistent with the moodboard');
  if (img.textSpaceClear === 'no') flags.push('reserved text side is not clear');
  const hard = flags.some((f) => /^(product missing|product does not match|competitor device|real identifiable|text inside|prohibited imagery$|cultural rule broken)/.test(f));
  const unsure = flags.some((f) => /unsure/.test(f));
  return { pass: !hard && !unsure, needsReview: !hard && unsure, flags };
}

/** images: [{index, url}] (signed or public, fetchable by the model). */
/** expectProduct: true (every image), false (none), or the indexes that are meant to show the product. */
async function visionCheck({ images, anchors, textSide, direction, product, productLook, rules, client, legacyPieceId, stage, jobId, expectProduct }) {
  const Anthropic = client ? null : require('@anthropic-ai/sdk');
  const c = client || new Anthropic({ timeout: 90000, maxRetries: 1 });
  registerPrompt('studio.vision.check', VERSION, `SYSTEM:\n${SYSTEM}\n\nUSER: images {{n}} direction {{direction}} product {{productLook}} rules {{rules}}`, ['n', 'direction', 'productLook', 'rules']);
  const content = [];
  (anchors || []).forEach((a) => { content.push({ type: 'text', text: `ANCHOR (approved moodboard tile ${a.index + 1}):` }); content.push({ type: 'image', source: { type: 'url', url: a.url } }); });
  images.forEach((im) => { content.push({ type: 'text', text: `IMAGE ${im.index}:` }); content.push({ type: 'image', source: { type: 'url', url: im.url } }); });
  const userText = `DIRECTION: ${JSON.stringify({ palette: direction && direction.palette, lighting: direction && direction.lighting, mood: direction && direction.mood }, null, 1)}\nPRODUCT: ${product || 'none expected'}${productLook ? ` — catalog look: ${productLook}` : ''}\nCULTURAL RULES: ${JSON.stringify(rules || [])}\nANCHORS: ${(anchors || []).length ? `${anchors.length} approved moodboard tile(s) shown above — judge consistentWithMood against them` : 'none (answer n/a)'}\nRESERVED TEXT SIDE: ${textSide || 'none (answer n/a)'}\nAnswer the questions for every image (indexes ${images.map((i) => i.index).join(', ')}).`;
  content.push({ type: 'text', text: userText });
  const t0 = Date.now();
  const rec = { kind: 'claude', legacyPieceId, stage, model: MODEL(), promptName: 'studio.vision.check', promptVersion: VERSION, resolvedPrompt: `${SYSTEM}\n\n${userText}`, userPrompt: userText, params: { images: images.length, anchors: (anchors || []).length, textSide: textSide || null }, inputAssets: [...(anchors || []).map((a) => a.url), ...images.map((i) => i.url)], jobId };
  let response;
  try {
    response = await c.messages.create({ model: MODEL(), max_tokens: 8000, system: SYSTEM, messages: [{ role: 'user', content }], output_config: { format: { type: 'json_schema', schema: SCHEMA }, effort: 'low' } });
  } catch (e) { await recordGeneration({ ...rec, status: 'failed', error: e.message, latencyMs: Date.now() - t0 }); throw e; }
  const text = response.content && response.content.find((b) => b.type === 'text');
  let j; try { j = JSON.parse(text ? text.text : ''); } catch (e) { await recordGeneration({ ...rec, status: 'failed', error: 'malformed JSON', latencyMs: Date.now() - t0 }); return { error: 'malformed JSON' }; }
  if (!j || !Array.isArray(j.images)) { await recordGeneration({ ...rec, status: 'failed', error: 'no images array', latencyMs: Date.now() - t0 }); return { error: 'no images array' }; }
  const expects = (i) => (Array.isArray(expectProduct) ? expectProduct.includes(i) : expectProduct === undefined ? Boolean(product) : Boolean(expectProduct));
  const results = images.map((im) => { const r = j.images.find((x) => x.index === im.index) || null; return r ? { index: im.index, productExpected: expects(im.index), ...r, ...verdict(r, expects(im.index)) } : { index: im.index, missing: true, pass: false, needsReview: true, flags: ['no verdict returned'] }; });
  await recordGeneration({ ...rec, status: 'succeeded', latencyMs: Date.now() - t0, usage: response.usage || null });
  return { results, passed: results.every((r) => r.pass), model: MODEL(), promptVersion: VERSION, usage: response.usage || null };
}

module.exports = { VERSION, SYSTEM, SCHEMA, visionCheck, verdict };
