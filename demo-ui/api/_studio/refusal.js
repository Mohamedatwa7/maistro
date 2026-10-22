// Phase 6.9 — policy refusals: when Higgsfield moderates a render (`nsfw`,
// never charged), explain what most likely tripped it and propose a compliant
// rewrite that keeps the creative intent. The human decides whether to use it;
// nothing is resubmitted automatically.
const { registerPrompt, recordGeneration } = require('../_records.js');

const VERSION = 'refusal-rewrite-v1-2026-10-22';
const MODEL = () => process.env.MAISTRO_VISION_MODEL || 'claude-sonnet-5-5';
const SYSTEM = [
  'A text-to-image or image-to-video prompt for a Samsung Gulf social piece was refused by the provider\'s content moderation (nothing was generated). Explain in one sentence which words or ideas most likely triggered it (body focus, minors, violence, weapons, intimacy, real people, drugs, alcohol, gore, ambiguous phrasing) and write a compliant rewrite that keeps the same scene, product, camera and mood.',
  'The rewrite must stay under 130 words, keep the product description unchanged, and never add people, claims or text. Gulf cultural rules apply: modest dress, no alcohol, no suggestive posing.',
].join('\n');
const SCHEMA = { type: 'object', additionalProperties: false, required: ['reason', 'rewrite'], properties: { reason: { type: 'string' }, rewrite: { type: 'string' } } };

async function suggestRewrite({ prompt, stage, legacyId, memberId, client }) {
  if (!prompt || (!process.env.ANTHROPIC_API_KEY && !client)) return null;
  const Anthropic = client ? null : require('@anthropic-ai/sdk');
  const c = client || new Anthropic({ timeout: 45000, maxRetries: 1 });
  registerPrompt('studio.refusal.rewrite', VERSION, `SYSTEM:\n${SYSTEM}\n\nUSER: refused prompt {{prompt}}`, ['prompt']);
  const user = `REFUSED PROMPT (stage ${stage}): ${String(prompt).slice(0, 4000)}`;
  const t0 = Date.now();
  const rec = { kind: 'claude', legacyPieceId: legacyId, stage, model: MODEL(), promptName: 'studio.refusal.rewrite', promptVersion: VERSION, resolvedPrompt: `${SYSTEM}\n\n${user}`, userPrompt: user, params: {}, memberId };
  try {
    const r = await c.messages.create({ model: MODEL(), max_tokens: 2000, system: SYSTEM, messages: [{ role: 'user', content: user }], output_config: { format: { type: 'json_schema', schema: SCHEMA }, effort: 'low' } });
    const text = r.content && r.content.find((b) => b.type === 'text');
    const j = JSON.parse(text ? text.text : '');
    if (!j || !j.rewrite) throw new Error('no rewrite');
    await recordGeneration({ ...rec, status: 'succeeded', latencyMs: Date.now() - t0, usage: r.usage || null });
    return { reason: String(j.reason).slice(0, 400), rewrite: String(j.rewrite).slice(0, 1500), promptVersion: VERSION };
  } catch (e) { await recordGeneration({ ...rec, status: 'failed', error: e.message, latencyMs: Date.now() - t0 }); return null; }
}

module.exports = { VERSION, SYSTEM, suggestRewrite };
