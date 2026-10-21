// Seed content for the knowledge base (Phase 6.1). Every entry carries its
// provenance. Where a field is not known from a source, it is null and
// `gaps` says what the owner must supply — nothing is invented. The brand
// and catalog texts reproduce api/_brand.js (distilled from the Samsung
// Brand Creative Playbook, Global Brand Center, Apr 2026) so that prompts
// built from the knowledge base are identical to today's until the owner
// edits a document.
const { PRODUCT_CATALOG, PRODUCTS_PROMPT, BRAND_PROMPT } = require('../_brand.js');

const PLAYBOOK = 'Samsung Brand Creative Playbook, Global Brand Center, Apr 2026 (docs/brand-playbook.pdf)';

const brand_kb = [
  { key: 'persona', content: { text: 'PERSONA: the Confident Explorer — Open, Bold, Authentic (O.B.A.). Pick one leading principle per piece, support with the others.', principles: ['Openly invite', 'Boldly lead', 'Authentically grounded'] }, source: `${PLAYBOOK} pp. 17–22` },
  { key: 'essence', content: { text: 'CREATIVE ESSENCE — Refined Wit: unexpected in the everyday, re-seeing the familiar, a gentle wink, subtle confidence, rooted in real life. NEVER mechanical/cold, staged, loud, busy/dense, or cutesy.' }, source: `${PLAYBOOK} Creative Foundation` },
  { key: 'colors', content: {
    text: 'COLOR SYSTEM (blue appears in every composition, used intentionally): White and Black dominate; Samsung Blue #1428A0 is the brand throughline; Confident Blue #020DCB is the digital hero blue; Harbor Blue #3C90EF and Morning Sky #EAF8FC add range. Secondary: Clay #A9989E, Stone #DADADA. Supporting: Porcelain #FCF8E6, Celadon #8AE1B8, Persimmon #FFC861, Bloom #F5BAEF. Rare accents: Rosey #FB44A0, Pulse #E91C2F, Sunlight #FCFC63. Gradients: 3-color = refined/product focus, multi-color = bold hero moments.',
    palette: { 'Samsung Blue': '#1428A0', 'Confident Blue': '#020DCB', 'Harbor Blue': '#3C90EF', 'Morning Sky': '#EAF8FC', Clay: '#A9989E', Stone: '#DADADA', Porcelain: '#FCF8E6', Celadon: '#8AE1B8', Persimmon: '#FFC861', Bloom: '#F5BAEF', Rosey: '#FB44A0', Pulse: '#E91C2F', Sunlight: '#FCFC63', White: '#FFFFFF', Black: '#000000' },
    rules: ['Confident Blue is for digital contexts only; print uses Samsung Blue.', 'Do not create gradients with colours that pair unharmoniously.', 'Do not place type or elements over gradients with poor contrast.', 'Do not use multiple gradients within a single layout.'],
  }, source: `${PLAYBOOK} pp. 58–63` },
  { key: 'imagery', content: { text: 'PRODUCT IMAGERY: the product speaks for itself — striking contrast, dynamic angles and crops when leading Bold; natural light, true-to-life scale and tactile texture when leading Authentic; visual simplicity, curiosity-sparking space when leading Open.\nLIFESTYLE IMAGERY: playful but grounded, clever not flashy (Open); hyperreal, theatrical, exaggerated-with-intention (Bold); observational, unposed, candid everyday wink, natural light (Authentic). Always simple enough to read at a glance — never frenetic or cluttered.' }, source: `${PLAYBOOK} Imagery & Video` },
  { key: 'voice', content: {
    text: 'VOICE (for any copy): conversational yet premium, say what we mean, personify the tech ("this fridge talks back"), upend expectations with the ending, never put down competitors, never try too hard.',
    attributes: {
      'Openly invite': 'imaginative and creative, figurative language with purpose and refinement — never overly metaphorical',
      'Boldly lead': 'incisive and confident; say what we mean and take credit for real impact; never put down competitors or brag at the expense of humility',
      'Authentically grounded': 'write how people talk — casual, conversational, simple, friendly; never try too hard to relate, still a premium brand',
    },
    examples: [
      { principle: 'Boldly lead', rule: 'Detail. Detail. Emotion.', doNot: '240Hz Refresh Rate & 0.03ms Response Time.', do: 'Refresh rate: 240Hz. Response time: 0.03ms. Reaction: woah.' },
      { principle: 'Boldly lead', rule: 'Play up contrast.', doNot: 'Smart never felt so small.', do: 'Super small. Supremely smart.' },
      { principle: 'Authentically grounded', rule: 'Write to a friend.', doNot: 'Make laundry day less of a chore.', do: 'Look forward to laundry day.' },
      { principle: 'Authentically grounded', rule: 'Find a tangible benefit.', doNot: 'Know what\'s inside your fridge.', do: 'Never run out of eggs again.' },
      { principle: 'Openly invite', rule: 'Reveal hidden dimensions.', doNot: 'Save space and dry washed clothes without having to transfer them!', do: 'This isn\'t just a laundry machine. It\'s a washer AND a dryer. And a space saver. And a time returner.' },
    ],
  }, source: `${PLAYBOOK} Verbal Identity pp. 20–34` },
  { key: 'do_dont', content: {
    doNot: ['Show competitor devices, logos or watermarks.', 'Render written text inside generated images (overlays only, except the reserved title space on thumbnails).', 'Use discontinued or older product generations.', 'Put down competitors or brag at the expense of humility.', 'Loud, busy, dense, staged, mechanical or cutesy executions.', 'Real identifiable people, celebrities or minors\' likeness in generated media.', 'Unlicensed music.'],
    do: ['Lead with one O.B.A. principle per piece.', 'Blue present and intentional in every composition.', 'The named catalog product is the hero, rendered from its catalog look line or the official reference.', 'Regionally relevant people and places for the target markets.'],
    gaps: ['Mandatory legal disclaimers by claim type and market — not in the playbook text; owner to supply.', 'Logo usage (clear space, minimum size, end-card rules) — not extractable from the text export; owner to supply from the full playbook.', 'Brand typeface for overlays — not extractable from the text export; owner to supply.'],
  }, source: `${PLAYBOOK}; demo-ui/api/_handlers/director.js BRAND FRAME` },
  { key: 'approved_examples', content: { examples: [], gaps: ['Approved example pieces with notes on why they worked — owner to supply (6.1).'] }, source: 'none yet' },
];

// Product catalog: the current lineup (api/_brand.js) with the evidence from
// the brand's own captions on 2026-09-25 → 2026-10-20 (sentiment_posts).
// Per-market names, colours, claims, specs and launch dates are NOT known
// from any source in the repo: null + gaps, never invented.
const CAPTION_EVIDENCE = { 'Galaxy Z Fold8': 31, 'The Frame': 17, 'Bespoke AI Laundry Combo': 6, 'Galaxy Watch9': 4, 'Galaxy S26': 2, 'Galaxy Z Flip8': 3, 'Galaxy Buds4 Pro': 10, 'Galaxy Tab S12': 7, 'Odyssey OLED G9': 4 };
const product_catalog = PRODUCT_CATALOG.map((p) => ({
  key: p.name,
  content: {
    name: p.name, look: p.look, category: categoryOf(p.name),
    namesByMarket: null, referenceImages: [], colors: null, keyFeatures: null, approvedClaims: null, specs: null, availability: null,
    captionMentions30d: CAPTION_EVIDENCE[p.name] || 0,
    gaps: ['official per-market names', 'official reference images (multiple angles)', 'colour names', 'key features', 'approved claims with exact wording', 'specs', 'availability and launch dates per GCC market'],
  },
  source: 'api/_brand.js PRODUCT_CATALOG (2026 lineup); mentions counted in Samsung Gulf captions 2026-09-25 → 2026-10-20',
}));
// Seen in the brand's own hashtags but absent from the catalog — owner to confirm before use.
const catalog_candidates = { key: '_candidates', content: { candidates: [{ name: 'Galaxy Watch Ultra2', evidence: '#galaxywatchultra2 (4 captions)' }, { name: 'Galaxy Z Fold8 Ultra', evidence: '#galaxyzfold8ultra (3 captions)' }, { name: 'Galaxy Tab S12 Ultra', evidence: '#galaxytabs12ultra (7 captions)' }], gaps: ['confirm whether these are catalog entries or campaign hashtags'] }, source: 'Samsung Gulf captions 2026-09-25 → 2026-10-20' };

function categoryOf(name) {
  if (/Fold|Flip|S26|A56/.test(name)) return 'mobile';
  if (/Tab|Book/.test(name)) return 'computing';
  if (/Watch|Ring|Buds/.test(name)) return 'wearables';
  if (/QLED|OLED|Frame/.test(name)) return 'tv-av';
  if (/Bespoke|Jet/.test(name)) return 'appliances';
  if (/Odyssey/.test(name)) return 'monitors';
  return 'other';
}

const market_context = [
  { key: 'gcc', content: {
    markets: ['UAE', 'KSA', 'Qatar', 'Kuwait', 'Oman', 'Bahrain'],
    languageRules: { onScreen: 'English or Gulf Arabic by market; Modern Standard Arabic for formal claims and disclaimers', arabizi: 'allowed only in casual captions when the trend itself uses it; never in overlays', note: 'builder defaults — owner to confirm' },
    culturalRules: ['Modest dress; no revealing or suggestive choreography or posing.', 'No alcohol, gambling, drugs; religion never used as a device.', 'Gender representation balanced and respectful; no mockery of groups.', 'During Ramadan: no music-led formats, no food imagery during fasting hours, no night-club settings; celebratory formats for Eid.', 'Avoid tragedy or crisis-linked trends and dangerous challenges.'],
    calendar: 'see api/_trends/signals.js CALENDAR (Ramadan, Eid, National Days, White Friday, Unpacked windows; moon-sighted dates are estimates)',
    gaps: ['per-market differences (UAE vs KSA vs Qatar vs Kuwait vs Oman vs Bahrain) beyond the general rules — owner to supply', 'Samsung launch windows per year'],
  }, source: 'TREND_FRAMEWORK.md §1 V-CULTURE and §4 (builder defaults, owner to amend)' },
];

// Platform specs: no official page could be fetched (search returned third-party
// guides only); values are those guides' consensus and are marked unverified.
const platform_specs = [
  { key: 'tiktok', content: { aspect: '9:16', resolution: '1080×1920', fps: '30', durationRange: '3 s – 10 min upload', sweetSpot: '9–15 s hook-led; ≤ 30 s', safeZone: 'keep the top ~160 px, bottom ~440 px and ~80 px sides clear of key content (at 720×1280 template scale)', captionLimit: '2200 characters (unverified)', cover: 'frame from the video', audioLoudness: null, verified: false, gaps: ['verify every value on TikTok\'s Business Help Center', 'loudness target'] }, source: 'third-party spec guides 2026 (renderforest, emplifi, postly) — unverified' },
  { key: 'instagram_reels', content: { aspect: '9:16', resolution: '1080×1920', fps: '30', durationRange: '3 s – 3 min in-app (uploads up to 15 min)', sweetSpot: '7–15 s', safeZone: 'centre 1080×1420 area', captionLimit: '2200 characters (unverified)', cover: '1080×1920 (grid crop 1080×1420)', audioLoudness: null, verified: false, gaps: ['verify on Meta\'s Help Center', 'loudness target'] }, source: 'third-party spec guides 2026 — unverified' },
  { key: 'instagram_feed', content: { aspect: '4:5 or 1:1', resolution: '1080×1350 / 1080×1080', fps: '30', durationRange: 'up to 60 s video', sweetSpot: null, safeZone: null, captionLimit: '2200 characters (unverified)', verified: false, gaps: ['verify on Meta\'s Help Center'] }, source: 'third-party spec guides 2026 — unverified' },
  { key: 'instagram_stories', content: { aspect: '9:16', resolution: '1080×1920', durationRange: '≤ 60 s per story', safeZone: 'top 250 px and bottom 250 px clear (unverified)', verified: false, gaps: ['verify on Meta\'s Help Center'] }, source: 'third-party spec guides 2026 — unverified' },
];

// Structured rejection reasons per stage (6.1 item 8): fixed codes + free text.
const rejection_taxonomy = [
  { key: 'v1', content: {
    common: ['wrong_product', 'wrong_color', 'off_brand_tone', 'cultural_issue', 'claim_not_approved', 'text_error', 'artifact', 'off_trend', 'weak_hook', 'too_long', 'other'],
    byStage: {
      plan: ['wrong_product', 'off_trend', 'weak_hook', 'wrong_market', 'other'],
      mood: ['wrong_product', 'wrong_color', 'off_brand_tone', 'cultural_issue', 'poor_composition', 'competitor_visible', 'real_person', 'other'],
      thumb: ['wrong_product', 'wrong_color', 'text_error', 'safe_zone', 'poor_composition', 'inconsistent_with_mood', 'other'],
      brief: ['claim_not_approved', 'wrong_market', 'language_fluency', 'too_long', 'missing_mandatory', 'other'],
      board: ['missing_hook', 'missing_feature', 'inconsistent_shots', 'wrong_product', 'too_long', 'other'],
      draft: ['product_morphing', 'artifact', 'caption_sync', 'safe_zone', 'audio_problem', 'inconsistent_with_keyframe', 'other'],
      qc: ['risk_unresolved', 'score_too_low', 'other'],
      final: ['fix_not_applied', 'regression', 'spec_mismatch', 'other'],
    },
    labels: { wrong_product: 'Wrong product', wrong_color: 'Wrong colour', off_brand_tone: 'Off-brand tone', cultural_issue: 'Cultural issue', claim_not_approved: 'Claim not approved', text_error: 'Text error', artifact: 'Visual artefact', off_trend: 'Off-trend', weak_hook: 'Weak hook', too_long: 'Too long', wrong_market: 'Wrong market', poor_composition: 'Poor composition', competitor_visible: 'Competitor visible', real_person: 'Real identifiable person', safe_zone: 'Safe zone violated', inconsistent_with_mood: 'Inconsistent with moodboard', language_fluency: 'Arabic not fluent', missing_mandatory: 'Missing mandatory element', missing_hook: 'Missing hook', missing_feature: 'Feature not shown', inconsistent_shots: 'Shots inconsistent', product_morphing: 'Product morphs between frames', caption_sync: 'Captions out of sync', audio_problem: 'Audio problem', inconsistent_with_keyframe: 'Inconsistent with keyframe', risk_unresolved: 'QC risk unresolved', score_too_low: 'Score too low', fix_not_applied: 'Fix not applied', regression: 'Regression vs draft', spec_mismatch: 'Platform spec mismatch', other: 'Other' },
  }, source: 'mandate 6.1 item 8 (builder\'s initial taxonomy)' },
];

/** Build the exact prompt texts today's handlers use from the knowledge base
 *  documents, so a seeded database changes nothing until the owner edits. */
function buildPrompts(docs) {
  const get = (kind, key) => (docs.find((d) => d.kind === kind && d.key === key) || {}).content;
  const products = docs.filter((d) => d.kind === 'product_catalog' && !d.key.startsWith('_')).map((d) => d.content);
  const productsPrompt = products.length
    ? 'CURRENT SAMSUNG PRODUCT CATALOG (2026) — campaigns may ONLY feature these, exactly by these names:\n'
      + products.map((p) => `- ${p.name}: ${p.look}`).join('\n')
      + '\nNEVER use discontinued or older generations (no Galaxy Z Flip7/Fold7 or earlier, no S25 or earlier, '
      + 'no Watch8 or earlier, no Buds3 or earlier, no Tab S11 or earlier). If an older product is mentioned '
      + 'anywhere upstream, silently upgrade it to its current 2026 equivalent from this catalog '
      + '(e.g. "Flip 7" → "Galaxy Z Flip8", "Watch8" → "Galaxy Watch9", "Buds3 Pro" → "Galaxy Buds4 Pro").'
    : PRODUCTS_PROMPT;
  const b = ['persona', 'essence', 'colors', 'imagery', 'voice'].map((k) => get('brand_kb', k)).filter(Boolean);
  const brandPrompt = b.length === 5
    ? 'SAMSUNG BRAND CREATIVE PLAYBOOK (Global Brand Center, Apr 2026) — mandatory for all creative:\n' + b.map((c) => c.text).join('\n')
    : BRAND_PROMPT;
  return { PRODUCTS_PROMPT: productsPrompt, BRAND_PROMPT: brandPrompt };
}

function seedDocuments() {
  const out = [];
  const push = (kind, items) => items.forEach((it) => out.push({ kind, key: it.key, version: 1, content: it.content, source: it.source, note: 'seed' }));
  push('brand_kb', brand_kb); push('product_catalog', product_catalog); push('product_catalog', [catalog_candidates]);
  push('market_context', market_context); push('platform_specs', platform_specs); push('rejection_taxonomy', rejection_taxonomy);
  return out;
}

module.exports = { seedDocuments, buildPrompts, categoryOf };
