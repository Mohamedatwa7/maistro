// The LLM judgement call for one trend (TREND_FRAMEWORK.md §5): structured
// output against prompts/profile-v1 SCHEMA, validated again on our side so a
// malformed answer is rejected (counted), never passed through.
const prompt = require('./prompts/profile-v1.js');

const MODEL = () => process.env.MAISTRO_TREND_JUDGE_MODEL || 'claude-sonnet-5-5';

const VERDICTS = ['pass', 'veto', 'needsReview'];
const CONF = ['high', 'medium', 'low'];
const CLASSES = ['product-led visual', 'scene / mood', 'character-light', 'performance', 'infeasible'];

/** Our own validation of the model's JSON (independent of the API's schema enforcement). */
function validateJudgement(j) {
  const problems = [];
  const str = (v, p) => { if (typeof v !== 'string') problems.push(`${p}: string required`); };
  const arr = (v, p) => { if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) problems.push(`${p}: string[] required`); };
  if (!j || typeof j !== 'object') return ['$: object required'];
  const pr = j.profile || {};
  ['whatItIs', 'mechanic', 'originAndMeaning', 'whySpreading'].forEach((k) => str(pr[k], `profile.${k}`));
  arr(pr.languages, 'profile.languages'); arr(pr.unknowns, 'profile.unknowns');
  if (!CONF.includes(pr.confidence)) problems.push('profile.confidence: enum');
  for (const k of ['safety', 'culture', 'origin', 'audioExplicit']) {
    const v = j[k] || {};
    if (!VERDICTS.includes(v.verdict)) problems.push(`${k}.verdict: enum`);
    arr(v.evidence, `${k}.evidence`); str(v.rationale, `${k}.rationale`);
    if (v.verdict === 'veto' && (!v.evidence || !v.evidence.length)) problems.push(`${k}: a veto needs evidence`);
  }
  if (!CLASSES.includes(j.feasibilityClass)) problems.push('feasibilityClass: enum');
  const c = j.criteria || {};
  for (const k of ['gulf', 'product', 'brand', 'audience', 'platform', 'saturation']) {
    const v = c[k] || {};
    if (!Number.isInteger(v.score) || v.score < 0 || v.score > 10) problems.push(`criteria.${k}.score: integer 0–10`);
    arr(v.evidence, `criteria.${k}.evidence`); str(v.rationale, `criteria.${k}.rationale`);
    if (!CONF.includes(v.confidence)) problems.push(`criteria.${k}.confidence: enum`);
    if (v.score >= 6 && (!v.evidence || !v.evidence.length)) problems.push(`criteria.${k}: a score ≥ 6 needs evidence`);
  }
  if (c.product && (typeof c.product.product !== 'string' || typeof c.product.feature !== 'string')) problems.push('criteria.product: product and feature required');
  return problems;
}

/** Rules the model may not break are enforced in code after the fact
 *  (TREND_FRAMEWORK.md §2.2, §2.3): Gulf capped without Gulf evidence; a
 *  product not in the catalog caps product fit at 4. */
function enforceCaps(j, { catalog, gulfEvidence }) {
  const notes = [];
  const g = j.criteria.gulf;
  if (!gulfEvidence && g.score > 7) { notes.push(`gulf capped 7 (was ${g.score}): no Gulf evidence in the feed`); g.score = 7; }
  if (!gulfEvidence && g.confidence === 'high') { notes.push('gulf confidence capped at medium'); g.confidence = 'medium'; }
  const p = j.criteria.product;
  const names = new Set((catalog || []).map((x) => x.name.toLowerCase()));
  if (p.product && p.product.toLowerCase() !== 'none' && !names.has(p.product.toLowerCase())) { notes.push(`product "${p.product}" is not a catalog name — fit capped 4`); p.score = Math.min(p.score, 4); p.catalogMatch = false; }
  else p.catalogMatch = p.product && p.product.toLowerCase() !== 'none';
  if (p.product && p.product.toLowerCase() === 'none' && p.score > 3) { notes.push('no product mapped — fit capped 3'); p.score = 3; }
  return notes;
}

/** One judgement. Returns { judgement, usage, model, promptVersion } or
 *  { error, problems } — never throws for a malformed answer. */
async function judgeTrend({ trend, computed, catalog, calendarNote, client }) {
  const Anthropic = client ? null : require('@anthropic-ai/sdk');
  const c = client || new Anthropic({ timeout: 90000, maxRetries: 1 });
  const response = await c.messages.create({
    model: MODEL(),
    max_tokens: 4000,
    system: prompt.SYSTEM,
    messages: [{ role: 'user', content: prompt.userMessage({ trend, computed, catalog, calendarNote }) }],
    output_config: { format: { type: 'json_schema', schema: prompt.SCHEMA } },
  });
  const text = response.content && response.content.find((b) => b.type === 'text');
  if (!text) return { error: `no text block (stop_reason ${response.stop_reason})`, problems: [] };
  let j;
  try { j = JSON.parse(text.text); } catch (e) { return { error: 'malformed JSON', problems: [e.message] }; }
  const problems = validateJudgement(j);
  if (problems.length) return { error: 'judgement failed validation', problems };
  const gulfEvidence = trend.region === 'local' || /^(ar|mixed)$/i.test(String(trend.lang || '')) || /[؀-ۿ]/.test(`${trend.name} ${trend.why || ''}`);
  const capNotes = enforceCaps(j, { catalog, gulfEvidence });
  return { judgement: j, capNotes, usage: response.usage || null, model: MODEL(), promptVersion: prompt.VERSION };
}

module.exports = { judgeTrend, validateJudgement, enforceCaps, MODEL };
