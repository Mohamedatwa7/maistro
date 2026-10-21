// POST /api/hermes — the Hermes agent chain behind the Maistro demo.
// The client sends one trend (from TrendRadar via /api/trends) plus the stage
// to produce; Claude generates that stage's artifact as strict JSON matching
// the shapes the Studio UI renders. The client calls this once per stage
// (plan → mood → thumb → brief → board → final → qc) so artifacts land in the
// UI one by one, exactly like the real agent chain would deliver them.

const Anthropic = require('@anthropic-ai/sdk');
const { requireSession } = require('../_auth.js');
const { brandPrompts } = require('../_kb/index.js'); // Phase 6.1: catalog and playbook come from the knowledge base (seed = today's text)
const { registerPrompt, recordGeneration } = require('../_records.js');
const PROMPT_VERSION = 'hermes-v1-2026-10-21'; // bump when SYSTEM or a stage instruction changes
const { validate, HERMES_BODY } = require('../_schemas.js');

const MODEL = 'claude-opus-4-8';

const HEX = { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' };
const STR = { type: 'string' };
const strArr = { type: 'array', items: STR };
const PLATFORM = { type: 'string', enum: ['tiktok', 'instagram', 'youtube', 'x'] };

function obj(properties) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

// One entry per pipeline stage: which agent persona speaks, what JSON it must
// return, and how the raw schema output maps onto the UI's artifact shape.
const STAGES = {
  plan: {
    agent: 'Hermes',
    instruction:
      'Plan the campaign project for this trend. Pick ONE Samsung product STRICTLY from the CURRENT SAMSUNG PRODUCT CATALOG (2026) in the system prompt — never an older generation — that fits the trend\'s ownable beat, a short campaign title (2-3 words, punchy, not the trend name verbatim), a one-line key message, the creative angle, target markets from the trend data, 1-2 best-fit platforms, and a dark-UI theme gradient: two dark-to-mid hex colors that evoke the trend\'s mood (first darker, both muted/deep — this sits on a near-black interface).',
    schema: obj({
      title: STR,
      product: { ...STR, description: 'EXACTLY one product name from the CURRENT SAMSUNG PRODUCT CATALOG (2026) in the system prompt — never an older generation' },
      msg: { ...STR, description: 'Key campaign message, max 6 words' },
      angle: { ...STR, description: 'One sentence: how the trend format becomes a product showcase' },
      markets: strArr,
      platforms: { type: 'array', items: PLATFORM },
      themeDark: HEX,
      themeAccent: HEX,
    }),
    map: (r) => ({
      title: r.title, product: r.product, msg: r.msg, angle: r.angle,
      markets: r.markets, platforms: r.platforms, th: [r.themeDark, r.themeAccent],
    }),
  },
  mood: {
    agent: 'Muse',
    instruction:
      'Create the moodboard: a 2-3 sentence art-direction note (palette, texture, light, cultural cues for the target markets) and exactly 6 palette tiles. Each tile has two hex colors forming a gradient (dark to lighter, all cohesive with the project theme) and a short evocative 1-3 word label.',
    schema: obj({
      note: STR,
      tiles: {
        type: 'array',
        items: obj({ from: HEX, to: HEX, label: STR }),
      },
    }),
    map: (r) => ({ note: r.note, tiles: r.tiles.slice(0, 6).map((t) => [t.from, t.to, t.label]) }),
  },
  thumb: {
    agent: 'Pixel',
    instruction:
      'Create the key-visual thumbnail: a short ALL-CAPS-friendly headline (2-5 words), a sub-line "product · hook" style (max 6 words), and a two-color gradient matching the project theme.',
    schema: obj({ title: STR, sub: STR, gFrom: HEX, gTo: HEX }),
    map: (r) => ({ title: r.title, sub: r.sub, g: [r.gFrom, r.gTo] }),
  },
  brief: {
    agent: 'Quill',
    instruction:
      'Write the detailed brief: a 1-2 sentence objective (why now, tied to the trend\'s momentum), the key message, markets, platforms, a realistic deadline within 2 weeks of today formatted like "12 Oct 2026", and 3-5 mandatories (hero product on screen, logo end-frame, cleared audio only, etc.).',
    schema: obj({
      objective: STR, msg: STR, markets: strArr,
      platforms: { type: 'array', items: PLATFORM },
      deadline: STR, mandatories: strArr,
    }),
    map: (r) => r,
  },
  board: {
    agent: 'Frame',
    instruction:
      'Create the storyboard: 4-6 beat-mapped frames. Each frame has a timecode like "0:00"/"0:03", a one-line shot description that follows the trend\'s native format while landing the product moment, and a two-color gradient for the frame art consistent with the moodboard.',
    schema: obj({
      frames: { type: 'array', items: obj({ tc: STR, d: STR, gFrom: HEX, gTo: HEX }) },
    }),
    map: (r) => r.frames.slice(0, 6).map((f) => ({ tc: f.tc, d: f.d, g: [f.gFrom, f.gTo] })),
  },
  final: {
    agent: 'Forge',
    instruction:
      'Describe the final rendered cut: version tag (e.g. "v1"), duration like "0:15", one line on the audio used (name a plausible cleared track or native sound consistent with the trend, with a licence-style note), and 3-4 delivery variants: aspect ("9:16"/"16:9"/"1:1"), language code ("EN"/"AR"/"TR"), kind ("original"/"subtitles"/"voiceover"), status "ready" or "rendering".',
    schema: obj({
      version: STR, dur: STR, audio: STR,
      variants: {
        type: 'array',
        items: obj({
          a: { type: 'string', enum: ['9:16', '16:9', '1:1'] },
          l: STR,
          k: { type: 'string', enum: ['original', 'subtitles', 'voiceover'] },
          st: { type: 'string', enum: ['ready', 'rendering'] },
        }),
      },
    }),
    map: (r) => r,
  },
  qc: {
    agent: 'Sentinel',
    instruction:
      'Run a pre-flight quality read of the written plan (no rendered asset exists yet, so this is an estimate, not an F1X8 result): score the concept on exactly these four dimensions — "Technical & craft quality", "Message effectiveness", "Audience fit", "Platform performance potential" — each 0-100, honestly, and write a one-line composite note naming the biggest risk. Do not invent any person, reviewer or sign-off.',
    schema: obj({
      f1x8: { type: 'array', items: obj({ n: STR, s: { type: 'integer' } }) },
      f1x8Note: STR,
    }),
    // AUDIT B-02 / ADR-007: the dispatch QC is a Claude estimate until the
    // piece has a rendered draft for the real F1X8 run; it carries no human
    // name — the human check is the Production Center approval itself.
    map: (r) => ({ f1x8: r.f1x8, f1x8Note: r.f1x8Note, simulated: true, human: null, humanNote: null }),
  },
};

const systemPrompt = ({ PRODUCTS_PROMPT, BRAND_PROMPT }) => `You are the agent chain of Maistro, Samsung Gulf's A-to-Z content creation platform for MENA social media (markets: KSA, UAE, Egypt, Türkiye and the wider region). Trends arrive from TrendRadar already gated for Samsung relevance; your job is to turn one trend into production-ready campaign artifacts, one pipeline stage at a time.

You will be told which agent you are for this stage (Hermes plans, Muse does moodboards, Pixel thumbnails, Quill briefs, Frame storyboards, Forge final cuts, Sentinel QC). Ground everything in the specific trend data provided — its ownable beat, momentum, markets and creator clips — and in any artifacts from earlier stages, so the campaign stays coherent end to end. Be concrete and culturally specific to the markets; never generic. All colors are for a dark near-black UI, so keep gradients deep and muted. Respond with the requested JSON only.

${PRODUCTS_PROMPT}

${BRAND_PROMPT}`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  if (!requireSession(req, res)) return;
  const { stage, trend, project } = req.body || {};
  const spec = STAGES[stage];
  if (!spec) {
    res.status(400).json({ error: `unknown stage "${stage}" — expected one of ${Object.keys(STAGES).join(', ')}` });
    return;
  }
  if (!trend || !trend.name) {
    res.status(400).json({ error: 'missing trend' });
    return;
  }
  const problems = validate(HERMES_BODY, req.body || {});
  if (problems.length) {
    res.status(400).json({ error: `invalid request: ${problems.slice(0, 3).join('; ')}`, problems });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured on the server' });
    return;
  }

  try {
    const client = new Anthropic({ timeout: 110000, maxRetries: 1 }); // under the 120 s function limit
    const system = systemPrompt(await brandPrompts());
    const user =
      `You are ${spec.agent}. Today is ${new Date().toDateString()}.\n\n` +
      `TREND (from TrendRadar):\n${JSON.stringify(trend, null, 2)}\n\n` +
      (project ? `PROJECT SO FAR (earlier stage artifacts):\n${JSON.stringify(project, null, 2)}\n\n` : '') +
      `TASK: ${spec.instruction}`;
    registerPrompt(`hermes.${stage}`, PROMPT_VERSION, `SYSTEM:\n${systemPrompt({ PRODUCTS_PROMPT: '{{PRODUCTS_PROMPT}}', BRAND_PROMPT: '{{BRAND_PROMPT}}' })}\n\nUSER:\n{{agent}} {{date}} {{trend}} {{project}} TASK: ${spec.instruction}`, ['PRODUCTS_PROMPT', 'BRAND_PROMPT', 'agent', 'date', 'trend', 'project']);
    const t0 = Date.now();
    const rec = { kind: 'claude', legacyPieceId: (project && project.id) || null, stage, model: MODEL, promptName: `hermes.${stage}`, promptVersion: PROMPT_VERSION, resolvedPrompt: `${system}\n\n${user}`, params: { max_tokens: 8000, thinking: 'adaptive' }, memberId: req.member ? req.member.id : null };
    let response;
    try {
      response = await client.messages.create({
        model: MODEL,
        max_tokens: 8000,
        thinking: { type: 'adaptive' },
        system,
        messages: [{ role: 'user', content: user }],
        output_config: { format: { type: 'json_schema', schema: spec.schema } },
      });
    } catch (e) { await recordGeneration({ ...rec, status: /timed out|timeout/i.test(String(e && e.message)) ? 'timed_out' : 'failed', error: e && e.message, latencyMs: Date.now() - t0 }); throw e; }

    const text = response.content.find((b) => b.type === 'text');
    if (!text) { await recordGeneration({ ...rec, status: 'failed', error: `no text block (stop_reason ${response.stop_reason})`, latencyMs: Date.now() - t0, usage: response.usage }); throw new Error(`no text block in response (stop_reason: ${response.stop_reason})`); }
    const artifact = spec.map(JSON.parse(text.text));
    await recordGeneration({ ...rec, status: 'succeeded', latencyMs: Date.now() - t0, usage: response.usage || null, outputAssets: [{ type: 'artifact', stage }] });

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ stage, agent: spec.agent, artifact });
  } catch (err) {
    res.setHeader('Cache-Control', 'no-store');
    res.status(502).json({ error: String((err && err.message) || err) });
  }
};
