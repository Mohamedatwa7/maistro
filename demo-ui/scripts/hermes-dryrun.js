#!/usr/bin/env node
// TEST MODE dry run of the whole Hermes pipeline on the test campaign zztest01, through the real gateway
// (docs/hermes-integration.md). Every run carries the TEST MODE instruction (--dry-run only) and max_credits 1,
// below the cost of any image, so nothing is spent even if a bot ignored the instruction.
//
//   node scripts/hermes-dryrun.js [path/to/env-file] [--only=brief,mood,board,thumb,video,review] [--wait-min=8]
//
// Keys come from the environment, or from the env file (only HERMES_* lines are read). They are never printed;
// requests are printed redacted (Authorization masked, signed-URL tokens cut).
const fs = require('fs');
const H = require('../api/_adapters/hermes.js');
const C = require('../api/_studio/hermes-contract.js');

const args = process.argv.slice(2);
const envFile = args.find((a) => !a.startsWith('--'));
if (envFile) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(HERMES_[A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/\\n$/, '');
  }
}
const only = ((args.find((a) => a.startsWith('--only=')) || '').split('=')[1] || 'brief,mood,board,thumb,video,review').split(',');
const waitMin = Number((args.find((a) => a.startsWith('--wait-min=')) || '').split('=')[1]) || 8;
process.env.MAISTRO_HERMES_TEST_MODE = '1';
if (!process.env.HERMES_API_URL) process.env.HERMES_API_URL = 'https://hermes.maistro-agents.com';

const CAMPAIGN = 'zztest01';
const product = C.productSpec({ family: 'Galaxy S26 Ultra', colour: 'Sky Blue' });
const productImages = []; // official images are not in the catalog yet (docs: remaining gaps)
const base = { testMode: true, productSpec: product, productImages };
const shots = [
  { n: 1, beat: 'opening', act: 'Act 1 — setup', durationS: 3, type: 'close_up', camera: 'low angle, slow push-in', angle: 'low angle', lens: '35mm', move: 'slow push-in', action: 'A hand lifts the phone off a sunlit majlis table', devicePose: 'held in the right hand, back to camera', product: { visible: true, feature: 'camera array' }, transition: 'match_cut' },
  { n: 2, beat: 'story', act: 'Act 2 — the problem solved', durationS: 4, type: 'medium', camera: 'eye level, handheld', angle: 'eye level', lens: '50mm', move: 'handheld', action: 'She shoots the skyline at dusk, the screen shows a crisp zoom', devicePose: 'held up, screen to camera', product: { visible: true, feature: 'zoom' }, transition: 'cut' },
  { n: 3, beat: 'end_card', act: 'Act 3 — resolution', durationS: 3, type: 'end_card', camera: 'static', angle: 'front', lens: '', move: 'static', action: 'Clean plate end card, Samsung Blue', devicePose: 'not in frame', product: { visible: false, feature: '' }, transition: 'none' },
];
const story = { logline: 'A night out in Dubai, captured without compromise', product_truth: 'Galaxy S26 Ultra zoom keeps detail at night', emotional_arc: 'anticipation → delight', acts: ['setup at golden hour', 'the skyline shot', 'end card'] };

function show(title, obj) { console.log(`\n=== ${title} ===\n${JSON.stringify(C.redact(obj), null, 2)}`); }

async function run(role, body, session, label) {
  const req = { profile: H.PROFILES[role], session_id: session, input: (() => { try { return JSON.parse(body.input); } catch (e) { return body.input; } })(), instructions: body.instructions };
  show(`${label}: request (POST /p/${H.PROFILES[role]}/v1/runs)`, req);
  let sub;
  try { sub = await H.submit(role, body, { sessionId: session, idempotencyKey: `${CAMPAIGN}-${label.replace(/[^A-Za-z0-9-]/g, '')}-${Date.now()}` }); }
  catch (e) { show(`${label}: submit failed`, { status: e.status || null, code: e.code || null, error: String(e.message) }); return null; }
  console.log(`${label}: submitted ${sub.ref} (${sub.bot}), polling…`);
  const until = Date.now() + waitMin * 60000;
  for (;;) {
    let st;
    try { st = await H.status(sub.ref); } catch (e) { st = { status: 'error', error: String(e.message) }; }
    if (st.status !== 'running' && st.status !== 'waiting') { show(`${label}: parsed response`, st); return st; }
    if (Date.now() > until) { show(`${label}: still running after ${waitMin} min`, { ref: sub.ref }); return null; }
    await new Promise((r) => setTimeout(r, 10000));
  }
}

(async () => {
  console.log(`TEST MODE dry run on ${CAMPAIGN} via ${process.env.HERMES_API_URL} — product ${C.productLine(product)}`);
  const out = {};
  if (only.includes('brief')) out.brief = await run('brief', H.briefRun({ ...base, system: 'You write Samsung Gulf social briefs.', context: 'CAMPAIGN: zztest01 — integration dry run. Market UAE, platform TikTok, 10 s.', schema: { type: 'object', properties: { keyMessage: { type: 'string' } } } }), C.sessionId(CAMPAIGN, 'brief'), 'brief');
  if (only.includes('mood')) out.mood = await run('mood', H.renderRun({ ...base, stage: 'mood', prompt: 'Golden-hour Dubai rooftop, warm sand and Samsung Blue accents, matte textures', aspect_ratio: '4:3', resolution: '1080p', batch: 2 }, 'mood'), C.sessionId(CAMPAIGN, 'mood'), 'mood');
  if (only.includes('board')) {
    const sc = { shot_index: 2, shot_count: shots.length, story, shot_list: shots.map(C.botShot) };
    out.board = await run('board', H.renderRun({ ...base, stage: 'board', prompt: 'medium shot, eye level, handheld. She shoots the skyline at dusk', aspect_ratio: '9:16', resolution: '1080p', shotContext: sc, previousKeyframeUrls: [] }, 'board'), C.sessionId(CAMPAIGN, 'board'), 'board (keyframe 2/3)');
  }
  if (only.includes('thumb')) out.thumb = await run('thumb', H.renderRun({ ...base, stage: 'thumb', prompt: 'The phone on a majlis cushion at golden hour, space on the left for a headline', aspect_ratio: '9:16', resolution: '1080p' }, 'thumb'), C.sessionId(CAMPAIGN, 'thumb'), 'thumb');
  if (only.includes('video')) {
    const ff = out.board && out.board.images && out.board.images[0];
    out.video = await run('video', H.renderRun({ ...base, stage: 'draft', prompt: 'eye level, handheld. She raises the phone and shoots the skyline; the device stays exactly as in the first frame.', duration: 4, resolution: '720p', aspect_ratio: '9:16', ...(ff ? { imageUrl: ff } : {}) }, 'video'), C.sessionId(CAMPAIGN, 'video'), 'video');
  }
  if (only.includes('review')) out.review = await run('organizer', H.reviewRun(CAMPAIGN, { testMode: true }), C.reviewSessionId(CAMPAIGN), 'review');
  if (out.review && out.review.parsed) show('review: display shape (reviewResult)', C.reviewResult(out.review.parsed));
  console.log('\nSummary:', JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v ? `${v.status}${v.raw_status ? ` (${v.raw_status})` : ''}` : 'no result']))));
})().catch((e) => { console.error('dry run failed:', e.message); process.exit(1); });
