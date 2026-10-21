// Stage 3 — Brief (Phase 6.4): the contract the rest of production must
// honour. Claude writes a fully structured brief from the approved moodboard
// and thumbnail, the trend profile, the catalog entry, the market context, the
// platform specs and the brand KB; every field is required and validated; the
// automated checks are computed in code (claims mapped to approved catalog
// claims, duration inside the platform sweet spot, hashtag limits, audio
// licensing, Arabic present where the markets need it) plus one copy check by
// a model (native Gulf fluency, consistency with the moodboard direction and
// the trend's actual mechanic). Human edits are stored as a new manual version.
const { registerPrompt, recordGeneration } = require('../_records.js');
const { queryRows } = require('../_supabase.js');
const { activeDocuments } = require('../_kb/index.js');
const { moodContext } = require('./thumb.js');

const VERSION = 'brief-v1-2026-10-21';
const CHECK_VERSION = 'brief-copy-check-v1-2026-10-21';
const MODEL = () => process.env.MAISTRO_STUDIO_MODEL || 'claude-opus-5-5';
const CHECK_MODEL = () => process.env.MAISTRO_VISION_MODEL || 'claude-sonnet-5-5';

// Builder defaults (owner to amend; kb platform_specs organic values are
// unverified). sweetSpotS = [min, max] seconds; the KB overrides when a
// platform document carries organic.sweetSpotS / organic.maxHashtags.
const PLATFORM_DEFAULTS = {
  tiktok: { sweetSpotS: [9, 30], maxHashtags: 5, aspect: '9:16', format: 'TikTok in-feed video' },
  instagram: { sweetSpotS: [7, 15], maxHashtags: 5, aspect: '9:16', format: 'Instagram Reel' },
  instagram_reels: { sweetSpotS: [7, 15], maxHashtags: 5, aspect: '9:16', format: 'Instagram Reel' },
  instagram_feed: { sweetSpotS: [5, 60], maxHashtags: 5, aspect: '4:5', format: 'Instagram feed video' },
  instagram_stories: { sweetSpotS: [5, 15], maxHashtags: 3, aspect: '9:16', format: 'Instagram Story' },
  youtube: { sweetSpotS: [15, 60], maxHashtags: 3, aspect: '16:9', format: 'YouTube Short / video' },
};
const ARABIC_MARKETS = ['UAE', 'KSA', 'Qatar', 'Kuwait', 'Oman', 'Bahrain'];
const REGISTERS = ['gulf_arabic', 'msa', 'english', 'bilingual'];
const LICENSING = ['none', 'cleared', 'unknown'];

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['objective', 'successMetric', 'audience', 'trendHook', 'keyMessage', 'products', 'claims', 'cta', 'tone', 'format', 'languagePlan', 'audio', 'mandatories', 'doNots', 'hashtags', 'caption', 'deadline'],
  properties: {
    objective: { type: 'string' }, successMetric: { type: 'string' },
    audience: { type: 'object', additionalProperties: false, required: ['description', 'markets'], properties: { description: { type: 'string' }, markets: { type: 'array', items: { type: 'string' } } } },
    trendHook: { type: 'object', additionalProperties: false, required: ['mechanic', 'samsungAdaptation'], properties: { mechanic: { type: 'string' }, samsungAdaptation: { type: 'string' } } },
    keyMessage: { type: 'string' },
    products: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'features'], properties: { name: { type: 'string' }, features: { type: 'array', items: { type: 'string' } } } } },
    claims: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['claim', 'approvedWording', 'disclaimer'], properties: { claim: { type: 'string' }, approvedWording: { type: 'string' }, disclaimer: { type: 'string' } } } },
    cta: { type: 'string' }, tone: { type: 'string' },
    format: { type: 'object', additionalProperties: false, required: ['platform', 'format', 'aspectRatio', 'targetDurationS'], properties: { platform: { type: 'string' }, format: { type: 'string' }, aspectRatio: { type: 'string' }, targetDurationS: { type: 'integer' } } },
    languagePlan: { type: 'object', additionalProperties: false, required: ['onScreenText', 'voiceoverOrCaptions', 'register', 'rationale'], properties: { onScreenText: { type: 'string' }, voiceoverOrCaptions: { type: 'string' }, register: { type: 'string', enum: REGISTERS }, rationale: { type: 'string' } } },
    audio: { type: 'object', additionalProperties: false, required: ['direction', 'musicReference', 'licensing'], properties: { direction: { type: 'string' }, musicReference: { type: 'string' }, licensing: { type: 'string', enum: LICENSING } } },
    mandatories: { type: 'array', items: { type: 'string' } }, doNots: { type: 'array', items: { type: 'string' } },
    hashtags: { type: 'object', additionalProperties: false, required: ['en', 'ar'], properties: { en: { type: 'array', items: { type: 'string' } }, ar: { type: 'array', items: { type: 'string' } } } },
    caption: { type: 'object', additionalProperties: false, required: ['en', 'ar'], properties: { en: { type: 'string' }, ar: { type: 'string' } } },
    deadline: { type: 'string' },
  },
};

const SYSTEM = [
  'You are Quill, the brief writer inside MAISTRO (Samsung Gulf social content). You write the BRIEF for one piece: the contract that the storyboard, the video and the QC must honour.',
  'Build ONLY on what you are given: the trend profile and the chosen angle, the APPROVED moodboard direction (and the reviewer\'s selected tiles and notes), the approved thumbnail (its headline is the hook line), the catalog entry, the market context, the platform specs and the brand voice. Never invent product facts.',
  'CLAIMS: a claim is any verifiable statement about the product (a spec, a number, a comparison, "fastest", "best", "all-day battery"). You may only make claims that appear in the APPROVED CLAIMS list, with their exact wording and disclaimer. If that list is empty, claims MUST be an empty array and the key message, caption and CTA must carry no verifiable product claim — express the benefit as an experience, not a specification. Feature names may be mentioned only when the catalog lists them.',
  'AUDIO: name a track only when its licensing is known to be cleared; otherwise describe the audio direction and set musicReference to "" with licensing "none". Never reference a trend sound whose commercial-use status is not cleared.',
  'LANGUAGE: Gulf Arabic for conversational on-screen text and captions, Modern Standard Arabic only for formal claims and disclaimers, English when the market plan says so. Arabic copy must read as native Gulf Arabic, never as a literal translation of the English.',
  'DURATION: pick targetDurationS inside the platform\'s sweet spot you are given. HASHTAGS: at most the platform\'s limit, mixing the trend\'s tag, one Samsung tag and market-relevant tags; ar hashtags in Arabic script.',
  'Deadline: a realistic date within 14 days of today formatted like "12 Oct 2026". Mandatories always include the hero product on screen, the Samsung logo end-frame and cleared audio only. Tone follows the brand voice: conversational yet premium, Refined Wit, never putting down competitors.',
  'Fill every field. Be concrete and culturally specific to the markets, never generic.',
].join('\n');

const CHECK_SYSTEM = [
  'You review a Samsung Gulf social-content BRIEF. Answer three questions with evidence, strictly from the material given:',
  '1. ARABIC FLUENCY: does the Arabic copy (caption, hashtags, on-screen plan) read as native Gulf Arabic a young Gulf audience would write, or as a literal translation of the English? Point to the exact phrases that read as translated. "n/a" when there is no Arabic.',
  '2. MOODBOARD CONSISTENCY: does the brief continue the approved visual direction (setting, palette, lighting, mood, leading principle) or contradict it?',
  '3. TREND MECHANIC: does the brief\'s hook actually use the trend\'s mechanic as described in the trend profile, so the piece will be recognisable as the trend?',
  'Be strict: "partial" when something is only loosely true; never pass copy you cannot verify.',
].join('\n');

const CHECK_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['arabicFluency', 'arabicIssues', 'consistentWithMood', 'moodNotes', 'followsTrendMechanic', 'trendNotes'],
  properties: {
    arabicFluency: { type: 'string', enum: ['native', 'mostly_native', 'literal', 'n/a'] }, arabicIssues: { type: 'array', items: { type: 'string' } },
    consistentWithMood: { type: 'string', enum: ['yes', 'partial', 'no'] }, moodNotes: { type: 'string' },
    followsTrendMechanic: { type: 'string', enum: ['yes', 'partial', 'no'] }, trendNotes: { type: 'string' },
  },
};

const platformKey = (p) => String(p || '').toLowerCase().replace(/\s+/g, '_');
function platformRules(platform, specsDocs) {
  const k = platformKey(platform);
  const base = PLATFORM_DEFAULTS[k] || PLATFORM_DEFAULTS[k.replace(/^instagram$/, 'instagram_reels')] || { sweetSpotS: [5, 30], maxHashtags: 5, aspect: '9:16', format: platform };
  const doc = (specsDocs || []).find((d) => d.key === k || (k === 'instagram' && d.key === 'instagram_reels'));
  const org = doc && doc.content && doc.content.organic ? doc.content.organic : {};
  return { ...base, ...(Array.isArray(org.sweetSpotS) && org.sweetSpotS.length === 2 ? { sweetSpotS: org.sweetSpotS } : {}), ...(Number.isInteger(org.maxHashtags) ? { maxHashtags: org.maxHashtags } : {}), verified: Boolean(org.verified) };
}

/** Schema-level problems (hard failures of the model's answer). */
function validateShape(j) {
  const p = [];
  if (!j || typeof j !== 'object') return ['$: object required'];
  for (const k of SCHEMA.required) if (j[k] === undefined || j[k] === null) p.push(`${k}: required`);
  if (p.length) return p;
  for (const k of ['objective', 'successMetric', 'keyMessage', 'cta', 'tone', 'deadline']) if (typeof j[k] !== 'string' || !j[k].trim()) p.push(`${k}: non-empty string`);
  if (!Array.isArray(j.products) || !j.products.length) p.push('products: at least one');
  if (!Array.isArray(j.claims)) p.push('claims: array');
  if (!Number.isInteger(j.format.targetDurationS) || j.format.targetDurationS <= 0) p.push('format.targetDurationS: positive integer');
  if (!REGISTERS.includes(j.languagePlan.register)) p.push('languagePlan.register: enum');
  if (!LICENSING.includes(j.audio.licensing)) p.push('audio.licensing: enum');
  if (!Array.isArray(j.mandatories) || j.mandatories.length < 3) p.push('mandatories: at least three');
  if (!Array.isArray(j.hashtags.en) || !Array.isArray(j.hashtags.ar)) p.push('hashtags: en[] and ar[]');
  if (typeof j.caption.en !== 'string' || typeof j.caption.ar !== 'string') p.push('caption: en and ar strings');
  if (!/^\d{1,2} [A-Z][a-z]{2} \d{4}$/.test(j.deadline)) p.push('deadline: like "12 Oct 2026"');
  return p;
}

/** The automated checks, computed in code. Each: {code, passed, detail}. */
function codeChecks(b, ctx) {
  const out = [];
  const catalogNames = (ctx.catalogNames || []).map((n) => n.toLowerCase());
  const unresolved = b.products.filter((p) => !catalogNames.includes(String(p.name).toLowerCase())).map((p) => p.name);
  out.push({ code: 'product_in_catalog', passed: unresolved.length === 0, detail: unresolved.length ? `not in the catalog: ${unresolved.join(', ')}` : `${b.products.length} product(s) resolve to the catalog` });
  const approved = (ctx.approvedClaims || []).map((c) => String(c.wording || c).trim().toLowerCase());
  const unmapped = b.claims.filter((c) => !approved.includes(String(c.approvedWording || '').trim().toLowerCase())).map((c) => c.claim);
  out.push({ code: 'claims_approved', passed: unmapped.length === 0, detail: unmapped.length ? `unmapped claim(s): ${unmapped.join(' | ')}` : b.claims.length ? `${b.claims.length} claim(s) match approved wording` : approved.length ? 'no claims made' : 'no claims made (the catalog has no approved claims yet)' });
  const rules = ctx.platformRules || { sweetSpotS: [5, 30], maxHashtags: 5 };
  const [lo, hi] = rules.sweetSpotS; const d = b.format.targetDurationS;
  out.push({ code: 'duration_sweet_spot', passed: d >= lo && d <= hi, detail: `${d} s vs ${lo}–${hi} s for ${b.format.platform}${rules.verified ? '' : ' (builder default, unverified)'}` });
  const hc = Math.max(b.hashtags.en.length, b.hashtags.ar.length);
  out.push({ code: 'hashtag_limit', passed: hc <= rules.maxHashtags && hc > 0, detail: `${b.hashtags.en.length} en / ${b.hashtags.ar.length} ar vs max ${rules.maxHashtags}` });
  const musicNamed = String(b.audio.musicReference || '').trim().length > 0;
  out.push({ code: 'audio_licensed', passed: !musicNamed || b.audio.licensing === 'cleared', detail: musicNamed ? `"${b.audio.musicReference}" — licensing ${b.audio.licensing}` : 'no track referenced' });
  const needsAr = (ctx.markets || []).some((m) => ARABIC_MARKETS.includes(m));
  out.push({ code: 'arabic_copy_present', passed: !needsAr || (b.caption.ar.trim().length > 0 && b.hashtags.ar.length > 0), detail: needsAr ? (b.caption.ar.trim() ? 'Arabic caption and hashtags present' : 'Arabic caption missing for Gulf markets') : 'no Arabic market' });
  const req = ['product on screen', 'logo', 'audio'];
  const text = b.mandatories.join(' ').toLowerCase();
  const missing = req.filter((r) => !(r === 'product on screen' ? /product|device|hero/.test(text) : r === 'logo' ? /logo|end[- ]?frame|end card/.test(text) : /audio|sound|music|track/.test(text)));
  out.push({ code: 'mandatories_complete', passed: missing.length === 0, detail: missing.length ? `mandatories missing: ${missing.join(', ')}` : 'hero product, logo end-frame and audio rule present' });
  const dl = Date.parse(b.deadline);
  out.push({ code: 'deadline_realistic', passed: !Number.isNaN(dl) && dl > ctx.now - 864e5 && dl < ctx.now + 15 * 864e5, detail: b.deadline });
  return out;
}

async function briefContext(piece, legacyId) {
  const docs = await activeDocuments();
  const cat = docs.find((d) => d.kind === 'product_catalog' && d.key.toLowerCase() === String(piece.product || '').toLowerCase());
  const catalogNames = docs.filter((d) => d.kind === 'product_catalog' && !d.key.startsWith('_')).map((d) => d.key);
  const market = (docs.find((d) => d.kind === 'market_context' && d.key === 'gcc') || {}).content || {};
  const specs = docs.filter((d) => d.kind === 'platform_specs');
  const voice = (docs.find((d) => d.kind === 'brand_kb' && d.key === 'voice') || {}).content || {};
  const doDont = (docs.find((d) => d.kind === 'brand_kb' && d.key === 'do_dont') || {}).content || {};
  const mood = await moodContext(piece.id);
  const [thumbStage] = await queryRows('stages', `select=state,current_version_id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.thumb&limit=1`);
  let thumb = null;
  if (thumbStage && thumbStage.current_version_id) { const [v] = await queryRows('artifact_versions', `select=payload&id=eq.${encodeURIComponent(thumbStage.current_version_id)}&limit=1`); if (v) thumb = { approved: thumbStage.state === 'approved', headline: v.payload && v.payload.overlay ? v.payload.overlay.headline : v.payload ? v.payload.title : null, headlineAr: v.payload && v.payload.overlay ? v.payload.overlay.headlineAr : null, note: v.payload ? v.payload.note : null }; }
  let trend = null, judgement = null;
  if (piece.trend_id) {
    const [cache] = await queryRows('trends_cache', 'select=payload&id=eq.board&limit=1').catch(() => []);
    const raw = cache && cache.payload && Array.isArray(cache.payload.raw) ? cache.payload.raw : [];
    trend = raw.find((t) => String(t.trendId || t.id) === String(piece.trend_id)) || null;
    const [sc] = await queryRows('trend_scores', `select=judgement,status,final_score&trend_id=eq.${encodeURIComponent(piece.trend_id)}&judgement=not.is.null&order=at.desc&limit=1`).catch(() => []);
    judgement = sc ? sc.judgement : null;
  }
  const primary = (piece.platforms || [])[0] || 'tiktok';
  return {
    catalog: cat ? cat.content : null, catalogNames, approvedClaims: cat && Array.isArray(cat.content.approvedClaims) ? cat.content.approvedClaims : [],
    market, platformRules: platformRules(primary, specs), platformSpecs: specs.filter((d) => (piece.platforms || []).map(platformKey).some((p) => p === d.key || (p === 'instagram' && d.key === 'instagram_reels'))).map((d) => ({ platform: d.key, organic: d.content.organic })),
    voice, doDont, mood, thumb, trend, judgement, markets: piece.markets || [], now: Date.now(),
  };
}

function userMessage(piece, ctx, userInput) {
  const d = ctx.mood.direction || {};
  return [
    `TODAY: ${new Date(ctx.now).toISOString().slice(0, 10)}`,
    `CAMPAIGN: ${JSON.stringify({ title: piece.title, product: piece.product, keyMessageSoFar: piece.key_message, angle: piece.angle, markets: piece.markets, platforms: piece.platforms, trend: piece.trend_name }, null, 1)}`,
    `TREND PROFILE: ${JSON.stringify(ctx.judgement ? { profile: ctx.judgement.profile, criteria: ctx.judgement.criteria } : ctx.trend ? { name: ctx.trend.name, mechanic: ctx.trend.mechanic, why: ctx.trend.why, fit: ctx.trend.samsungFit, brief: ctx.trend.brief, sound: ctx.trend.sound } : 'not available — build on the campaign angle', null, 1)}`,
    `APPROVED MOODBOARD${ctx.mood.approved ? '' : ' (current version, not yet approved)'}: ${JSON.stringify(ctx.mood.direction ? { leadingPrinciple: d.leadingPrinciple, setting: d.setting, palette: d.palette, lighting: d.lighting, mood: d.mood, styling: d.styling, wardrobe: d.wardrobe, trendAdaptation: d.trendAdaptation, selectedTiles: ctx.mood.tiles.map((t) => t.tag), reviewerAnnotations: ctx.mood.annotations } : { note: ctx.mood.note, prompt: ctx.mood.prompt }, null, 1)}`,
    `APPROVED THUMBNAIL: ${JSON.stringify(ctx.thumb || 'none yet', null, 1)}`,
    `CATALOG ENTRY for ${piece.product}: ${JSON.stringify(ctx.catalog ? { look: ctx.catalog.look, keyFeatures: ctx.catalog.keyFeatures, colors: ctx.catalog.colors, availability: ctx.catalog.availability } : 'NOT IN THE CATALOG — the product cannot be shown or claimed', null, 1)}`,
    `APPROVED CLAIMS (the only claims allowed): ${JSON.stringify(ctx.approvedClaims)}`,
    `MARKET CONTEXT: ${JSON.stringify({ languageRules: ctx.market.languageRules, culturalRules: ctx.market.culturalRules }, null, 1)}`,
    `PLATFORM RULES for ${(piece.platforms || []).join(', ')}: sweet spot ${ctx.platformRules.sweetSpotS[0]}–${ctx.platformRules.sweetSpotS[1]} s, max ${ctx.platformRules.maxHashtags} hashtags, aspect ${ctx.platformRules.aspect}, format "${ctx.platformRules.format}". Specs: ${JSON.stringify(ctx.platformSpecs)}`,
    `BRAND VOICE: ${JSON.stringify({ voice: ctx.voice.text, attributes: ctx.voice.attributes, do: ctx.doDont.do, doNot: ctx.doDont.doNot }, null, 1)}`,
    `WHAT THE USER ASKED FOR: "${String(userInput || '').trim() || '(left to you)'}"`,
  ].join('\n\n');
}

async function writeBrief({ piece, ctx, userInput, client, memberId, legacyId }) {
  const Anthropic = client ? null : require('@anthropic-ai/sdk');
  const c = client || new Anthropic({ timeout: 120000, maxRetries: 1 });
  registerPrompt('studio.brief', VERSION, `SYSTEM:\n${SYSTEM}\n\nUSER: today {{today}} campaign {{campaign}} trend {{trend}} mood {{mood}} thumb {{thumb}} catalog {{catalog}} claims {{approvedClaims}} market {{market}} platform {{platform}} voice {{voice}} ask {{userInput}}`, ['today', 'campaign', 'trend', 'mood', 'thumb', 'catalog', 'approvedClaims', 'market', 'platform', 'voice', 'userInput']);
  const user = userMessage(piece, ctx, userInput);
  const t0 = Date.now();
  const rec = { kind: 'claude', legacyPieceId: legacyId, stage: 'brief', model: MODEL(), promptName: 'studio.brief', promptVersion: VERSION, resolvedPrompt: `${SYSTEM}\n\n${user}`, userPrompt: user, params: { approvedClaims: ctx.approvedClaims.length, moodApproved: ctx.mood.approved }, memberId };
  let response;
  try { response = await c.messages.create({ model: MODEL(), max_tokens: 6000, system: SYSTEM, messages: [{ role: 'user', content: user }], output_config: { format: { type: 'json_schema', schema: SCHEMA } } }); }
  catch (e) { await recordGeneration({ ...rec, status: 'failed', error: e.message, latencyMs: Date.now() - t0 }); throw e; }
  const text = response.content && response.content.find((b) => b.type === 'text');
  let j; try { j = JSON.parse(text ? text.text : ''); } catch (e) { await recordGeneration({ ...rec, status: 'failed', error: 'malformed JSON', latencyMs: Date.now() - t0 }); return { error: 'malformed JSON' }; }
  const problems = validateShape(j);
  if (problems.length) { await recordGeneration({ ...rec, status: 'failed', error: `validation: ${problems.join('; ')}`, latencyMs: Date.now() - t0, usage: response.usage }); return { error: 'brief failed validation', problems }; }
  await recordGeneration({ ...rec, status: 'succeeded', latencyMs: Date.now() - t0, usage: response.usage || null });
  return { brief: j, promptVersion: VERSION, model: MODEL() };
}

async function copyCheck({ brief, ctx, client, legacyId, memberId }) {
  const Anthropic = client ? null : require('@anthropic-ai/sdk');
  const c = client || new Anthropic({ timeout: 90000, maxRetries: 1 });
  registerPrompt('studio.brief.check', CHECK_VERSION, `SYSTEM:\n${CHECK_SYSTEM}\n\nUSER: brief {{brief}} mood {{mood}} trend {{trend}}`, ['brief', 'mood', 'trend']);
  const d = ctx.mood.direction || {};
  const user = `BRIEF: ${JSON.stringify(brief, null, 1)}\n\nAPPROVED MOODBOARD DIRECTION: ${JSON.stringify(ctx.mood.direction ? { leadingPrinciple: d.leadingPrinciple, setting: d.setting, palette: d.palette, lighting: d.lighting, mood: d.mood, styling: d.styling } : ctx.mood.note || 'none', null, 1)}\n\nTREND PROFILE: ${JSON.stringify(ctx.judgement ? ctx.judgement.profile : ctx.trend ? { name: ctx.trend.name, mechanic: ctx.trend.mechanic, why: ctx.trend.why } : 'none', null, 1)}`;
  const t0 = Date.now();
  const rec = { kind: 'claude', legacyPieceId: legacyId, stage: 'brief', model: CHECK_MODEL(), promptName: 'studio.brief.check', promptVersion: CHECK_VERSION, resolvedPrompt: `${CHECK_SYSTEM}\n\n${user}`, userPrompt: user, params: {}, memberId };
  let response;
  try { response = await c.messages.create({ model: CHECK_MODEL(), max_tokens: 4000, system: CHECK_SYSTEM, messages: [{ role: 'user', content: user }], output_config: { format: { type: 'json_schema', schema: CHECK_SCHEMA }, effort: 'low' } }); }
  catch (e) { await recordGeneration({ ...rec, status: 'failed', error: e.message, latencyMs: Date.now() - t0 }); return { error: e.message }; }
  const text = response.content && response.content.find((b) => b.type === 'text');
  let j; try { j = JSON.parse(text ? text.text : ''); } catch (e) { await recordGeneration({ ...rec, status: 'failed', error: 'malformed JSON', latencyMs: Date.now() - t0 }); return { error: 'malformed JSON' }; }
  await recordGeneration({ ...rec, status: 'succeeded', latencyMs: Date.now() - t0, usage: response.usage || null });
  return { copy: j, model: CHECK_MODEL(), promptVersion: CHECK_VERSION };
}

/** Flags for the human from the model's copy check (never a decision). */
function copyFlags(copy) {
  if (!copy) return ['copy check unavailable'];
  const f = [];
  if (copy.arabicFluency === 'literal') f.push('Arabic reads as a literal translation');
  if (copy.arabicFluency === 'mostly_native' && copy.arabicIssues && copy.arabicIssues.length) f.push(`Arabic: ${copy.arabicIssues.length} phrase(s) to polish`);
  if (copy.consistentWithMood === 'no') f.push('contradicts the approved moodboard');
  if (copy.consistentWithMood === 'partial') f.push('only loosely follows the moodboard');
  if (copy.followsTrendMechanic === 'no') f.push('does not use the trend mechanic');
  if (copy.followsTrendMechanic === 'partial') f.push('trend mechanic only partly used');
  return f;
}

/** The stored artifact keeps the legacy page fields (objective, msg, markets, platforms, mandatories, deadline) and adds the structured spec. */
function artifactFrom(brief, piece, meta) {
  return {
    objective: brief.objective, msg: brief.keyMessage, markets: brief.audience.markets.length ? brief.audience.markets : piece.markets || [], platforms: piece.platforms || [brief.format.platform], mandatories: brief.mandatories, deadline: brief.deadline,
    spec: brief, briefVersion: meta.promptVersion || VERSION, moodApproved: Boolean(meta.moodApproved), thumbApproved: Boolean(meta.thumbApproved), ...(meta.editedBy ? { editedBy: meta.editedBy } : {}),
  };
}

module.exports = { VERSION, CHECK_VERSION, SYSTEM, SCHEMA, CHECK_SCHEMA, PLATFORM_DEFAULTS, platformRules, validateShape, codeChecks, briefContext, userMessage, writeBrief, copyCheck, copyFlags, artifactFrom };
