// Trend profile + judgement prompt, version 1 (TREND_FRAMEWORK.md §5).
// Changing the wording or the schema bumps VERSION; scores store it.
const VERSION = 'profile-v1.2-2026-10-22'; // v1.1: integer bounds moved out of the API schema (the API rejects minimum/maximum on integers); v1.2: audioExplicit needsReview only on a concrete cue (the feed never carries lyrics)

const SYSTEM = [
  'You judge social-media trends for MAISTRO, Samsung Gulf\'s content platform (markets: UAE, KSA, Qatar, Kuwait, Oman, Bahrain).',
  'You receive ONE trend as evidence from Trend Radar (a TikTok-first radar; it carries no Gulf engagement data, no creator counts and no lyrics). All numbers (views, growth, days on board, post-by date) were computed in code and are read-only facts — never invent, estimate or restate numbers that are not in the evidence.',
  'Rules: ground every statement in a quoted evidence field; if the evidence does not support a claim, say "unknown" and lower confidence; ambiguous meaning is NEVER safe — mark needsReview, but only when a concrete cue in the evidence makes it ambiguous (quote it); the mere absence of information is not a cue — say so in the rationale and lower confidence instead. Arabic, Gulf-dialect and Arabizi text stays verbatim as evidence.',
  'audioExplicit: Trend Radar NEVER carries lyrics, so missing lyrics alone is not grounds for needsReview. Answer "pass" (confidence low, rationale "lyrics not in the feed") unless the sound title, the trend name, the brief or the clip captions contain a concrete cue of explicit, sexual, violent or drug content — then needsReview (or veto when the cue is unambiguous), quoting the cue. Commercial-use clearance is decided in code, not here.',
  'Scoring anchors for every 0–10 criterion: 0–2 contradicted by evidence; 3–4 weak or forced; 5 unknown or neutral (say why); 6–7 clear fit with a stated caveat; 8–10 evidence-backed and specific. Confidence: high = multiple evidence fields agree; medium = one field; low = inference without a field.',
  'Gulf relevance: without Gulf evidence (scope "local", Arabic or Gulf creators in the clips, Gulf text in the name/why) the score may not exceed 7 and confidence may not exceed medium.',
  'Product fit: the mapping MUST name a product from the catalog exactly as written; a forced mapping scores at most 4.',
  'Brand fit: the Samsung persona is the Confident Explorer (Open, Bold, Authentic) with Refined Wit — never loud, mechanical, cutesy or putting down competitors.',
  'Production feasibility classes (pick exactly one): "product-led visual" (product reveal, unboxing, before/after, on-screen-text or caption-reveal formats), "scene / mood" (aesthetic montage, setting-based humour, no recurring face), "character-light" (a person appears but no identity continuity across shots), "performance" (dance, lip-sync, choreography, stunts, a specific creator\'s face), "infeasible" (requires a real person\'s likeness, a live event or licensed footage).',
].join('\n');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['profile', 'safety', 'culture', 'origin', 'audioExplicit', 'feasibilityClass', 'criteria'],
  properties: {
    profile: {
      type: 'object', additionalProperties: false,
      required: ['whatItIs', 'mechanic', 'originAndMeaning', 'whySpreading', 'languages', 'confidence', 'unknowns'],
      properties: {
        whatItIs: { type: 'string' }, mechanic: { type: 'string' }, originAndMeaning: { type: 'string' }, whySpreading: { type: 'string' },
        languages: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        unknowns: { type: 'array', items: { type: 'string' } },
      },
    },
    safety: { $ref: '#/$defs/veto' },
    culture: { $ref: '#/$defs/veto' },
    origin: { $ref: '#/$defs/veto' },
    audioExplicit: { $ref: '#/$defs/veto' },
    feasibilityClass: { type: 'string', enum: ['product-led visual', 'scene / mood', 'character-light', 'performance', 'infeasible'] },
    criteria: {
      type: 'object', additionalProperties: false,
      required: ['gulf', 'product', 'brand', 'audience', 'platform', 'saturation'],
      properties: {
        gulf: { $ref: '#/$defs/criterion' }, product: { $ref: '#/$defs/productCriterion' }, brand: { $ref: '#/$defs/criterion' },
        audience: { $ref: '#/$defs/criterion' }, platform: { $ref: '#/$defs/criterion' }, saturation: { $ref: '#/$defs/criterion' },
      },
    },
  },
  $defs: {
    veto: {
      type: 'object', additionalProperties: false, required: ['verdict', 'evidence', 'rationale'],
      properties: {
        verdict: { type: 'string', enum: ['pass', 'veto', 'needsReview'] },
        evidence: { type: 'array', items: { type: 'string' }, description: 'quoted evidence fields' },
        rationale: { type: 'string' },
      },
    },
    criterion: {
      type: 'object', additionalProperties: false, required: ['score', 'evidence', 'rationale', 'confidence'],
      properties: {
        score: { type: 'integer', description: '0 to 10 per the anchors' },
        evidence: { type: 'array', items: { type: 'string' } },
        rationale: { type: 'string' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
      },
    },
    productCriterion: {
      type: 'object', additionalProperties: false, required: ['score', 'evidence', 'rationale', 'confidence', 'product', 'feature'],
      properties: {
        score: { type: 'integer', description: '0 to 10 per the anchors' },
        evidence: { type: 'array', items: { type: 'string' } },
        rationale: { type: 'string' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        product: { type: 'string', description: 'exact catalog name, or "none"' },
        feature: { type: 'string' },
      },
    },
  },
};

/** The user turn: the evidence, with the computed numbers labelled as such. */
function userMessage({ trend, computed, catalog, calendarNote }) {
  const evidence = {
    name: trend.name, trendId: trend.trendId || trend.id, category: trend.category, kind: trend.kind || null, scope: trend.region, lang: trend.lang,
    why: trend.why, mechanic: trend.mechanic, tags: trend.tags, brief: trend.brief, products: trend.products,
    sound: trend.sound ? { title: trend.sound.title, author: trend.sound.author, cue: trend.sound.cue, commercialUseCleared: trend.sound.cleared, clearedCheckedAt: trend.sound.clearedCheckedAt } : null,
    clips: (trend.clips || []).map((c) => ({ handle: c.handle, views: c.views, sound: c.sound })),
    upstreamFit: trend.samsungFit ? { score: trend.samsungFit.score, beat: trend.samsungFit.ownableBeat, reason: trend.samsungFit.rationale } : null,
    upstreamOnBrand: trend.onBrand,
  };
  return [
    'EVIDENCE (from Trend Radar; null = not measured):',
    JSON.stringify(evidence, null, 1),
    '',
    'COMPUTED IN CODE (read-only facts):',
    JSON.stringify(computed, null, 1),
    '',
    'SAMSUNG PRODUCT CATALOG (use these exact names):',
    catalog.map((p) => `- ${p.name}: ${p.look}`).join('\n'),
    '',
    calendarNote ? `CALENDAR: ${calendarNote}` : '',
    'Produce the trend profile, the four veto verdicts (safety, culture, origin, audioExplicit), the feasibility class, and the six judgement criteria with evidence, rationale and confidence.',
  ].join('\n');
}

module.exports = { VERSION, SYSTEM, SCHEMA, userMessage };
