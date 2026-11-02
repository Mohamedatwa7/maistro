#!/usr/bin/env node
// TEST MODE dry run of the whole Hermes pipeline on a zz… test campaign, through the real gateway
// (docs/hermes-integration.md): brief → moodboard → storyboard → thumbnail → video → organizer review.
// Every run carries the TEST MODE instruction (--dry-run only) and max_credits 1, below the cost of any image,
// so nothing is spent even if a bot ignored the instruction.
//
//   node scripts/hermes-dryrun.js [path/to/env-file] [--only=brief,mood,board,thumb,video,review] [--wait-min=8]
//                                 [--product="Galaxy Z Fold8"] [--colour=Cream] [--campaign=zztest01]
//
// Keys come from the environment, or from the env file (only HERMES_* lines are read). They are never printed;
// requests are printed redacted (Authorization masked, signed-URL tokens cut).
//
// The video starts on the storyboard's keyframe (first_frame_url). In TEST MODE the storyboard bot answers
// "dry-run" instead of an image, so the clip request carries the product's official front image as a labelled
// stand-in first frame: the field is always sent and the wiring is exercised end to end.
const fs = require('fs');
const H = require('../api/_adapters/hermes.js');
const C = require('../api/_studio/hermes-contract.js');

const STEPS = ['brief', 'mood', 'board', 'thumb', 'video', 'review'];
const isHttps = (u) => typeof u === 'string' && /^https:\/\//.test(u);

function storyboard() {
  const shots = [
    { n: 1, beat: 'opening', act: 'Act 1 — setup', durationS: 3, type: 'close_up', camera: 'low angle, slow push-in', angle: 'low angle', lens: '35mm', move: 'slow push-in', action: 'A hand lifts the closed phone off a sunlit majlis table', devicePose: 'closed, cover screen to camera', product: { visible: true, feature: 'cover screen' }, transition: 'match_cut' },
    { n: 2, beat: 'closing', act: 'Act 2 — the unfold', durationS: 4, type: 'medium', camera: 'eye level, handheld', angle: 'eye level', lens: '50mm', move: 'handheld', action: 'She unfolds it and the Dubai skyline fills the big inner screen', devicePose: 'opening to the inner screen, screen to camera', product: { visible: true, feature: 'inner screen' }, transition: 'cut' },
    { n: 3, beat: 'end_card', act: 'Act 3 — resolution', durationS: 3, type: 'end_card', camera: 'static', angle: 'front', lens: '', move: 'static', action: 'Clean plate end card, Samsung Blue', devicePose: 'not in frame', product: { visible: false, feature: '' }, transition: 'none' },
  ];
  const story = { logline: 'A night out in Dubai opens up — literally', product_truth: 'The Galaxy Z Fold8 unfolds from phone to big screen in one move', emotional_arc: 'anticipation → reveal → delight', acts: ['setup at golden hour', 'the unfold onto the skyline', 'end card'] };
  return { shots, story };
}

/** Run the pipeline. `say(title, obj)` prints; returns { order: [profile…], requests: {step: input}, results: {step: status} }. */
async function runPipeline({ campaign = 'zztest01', product: family = 'Galaxy Z Fold8', colour = '', only = STEPS, waitMin = 8, pollMs = 10000, say = () => {} } = {}) {
  if (!/^zz[A-Za-z0-9]*$/.test(campaign)) throw new Error(`dry runs use a zz… test campaign id, not "${campaign}"`);
  const product = C.productSpec({ family, colour });
  const productImages = C.productImages(product, null, []);
  const base = { testMode: true, productSpec: product, productImages };
  const { shots, story } = storyboard();
  const out = { order: [], requests: {}, results: {}, product, productImages };

  async function run(step, role, body, session) {
    const input = (() => { try { return JSON.parse(body.input); } catch (e) { return body.input; } })();
    out.order.push(H.PROFILES[role]); out.requests[step] = input;
    say(`${step}: request (POST /p/${H.PROFILES[role]}/v1/runs)`, { session_id: session, input, instructions: body.instructions });
    let sub;
    try { sub = await H.submit(role, body, { sessionId: session, idempotencyKey: `${campaign}-${step}-${Date.now()}` }); }
    catch (e) { out.results[step] = { status: 'submit_failed', error: String(e.message), code: e.code || null }; say(`${step}: submit failed`, out.results[step]); return null; }
    const until = Date.now() + waitMin * 60000;
    for (;;) {
      let st;
      try { st = await H.status(sub.ref); } catch (e) { st = { status: 'error', error: String(e.message) }; }
      if (st.status !== 'running' && st.status !== 'waiting') { out.results[step] = st; say(`${step}: parsed response (${sub.ref})`, st); return st; }
      if (Date.now() > until) { out.results[step] = { status: 'still_running', ref: sub.ref }; say(`${step}: still running after ${waitMin} min`, { ref: sub.ref }); return null; }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  if (only.includes('brief')) await run('brief', 'brief', H.briefRun({ ...base, system: 'You write Samsung Gulf social briefs.', context: `CAMPAIGN: ${campaign} — integration dry run. Market UAE, platform TikTok, 10 s. Product moment: the unfold.`, schema: { type: 'object', properties: { keyMessage: { type: 'string' } } } }), C.sessionId(campaign, 'brief'));
  if (only.includes('mood')) await run('mood', 'mood', H.renderRun({ ...base, stage: 'mood', prompt: 'Golden-hour Dubai rooftop, warm sand and Samsung Blue accents, matte textures; the device half unfolded on a travertine ledge', aspect_ratio: '4:3', resolution: '1080p', batch: 2 }, 'mood'), C.sessionId(campaign, 'mood'));
  let keyframe = null;
  if (only.includes('board')) {
    const sc = { shot_index: 2, shot_count: shots.length, story, shot_list: shots.map(C.botShot) };
    const st = await run('board', 'board', H.renderRun({ ...base, stage: 'board', prompt: 'medium shot, eye level, handheld. She unfolds the phone and the skyline fills the inner screen', aspect_ratio: '9:16', resolution: '1080p', shotContext: sc, previousKeyframeUrls: [] }, 'board'), C.sessionId(campaign, 'board'));
    keyframe = st && Array.isArray(st.images) && isHttps(st.images[0]) ? st.images[0] : null;
  }
  if (only.includes('thumb')) await run('thumb', 'thumb', H.renderRun({ ...base, stage: 'thumb', prompt: 'The phone half unfolded on a travertine ledge at golden hour, space on the left for a headline', aspect_ratio: '9:16', resolution: '1080p' }, 'thumb'), C.sessionId(campaign, 'thumb'));
  if (only.includes('video')) {
    // the clip starts on the storyboard keyframe; in TEST MODE (no real image) the official front image stands in
    const firstFrame = keyframe || productImages[0] || null;
    out.firstFrame = { url: firstFrame, standIn: !keyframe };
    await run('video', 'video', H.renderRun({ ...base, stage: 'draft', prompt: 'eye level, handheld. She unfolds the phone; the device stays exactly as in the first frame.', duration: 4, resolution: '720p', aspect_ratio: '9:16', ...(firstFrame ? { imageUrl: firstFrame } : {}) }, 'video'), C.sessionId(campaign, 'video'));
  }
  if (only.includes('review')) {
    const st = await run('review', 'organizer', H.reviewRun(campaign, { testMode: true }), C.reviewSessionId(campaign));
    if (st && st.parsed) { out.review = C.reviewResult(st.parsed); say('review: display shape (reviewResult)', out.review); }
  }
  return out;
}

module.exports = { runPipeline, STEPS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (k) => { const a = args.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
  const envFile = args.find((a) => !a.startsWith('--'));
  if (envFile) {
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const m = /^\s*(HERMES_[A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/\\n$/, '');
    }
  }
  if (!process.env.HERMES_API_URL) process.env.HERMES_API_URL = 'https://hermes.maistro-agents.com';
  const say = (title, obj) => console.log(`\n=== ${title} ===\n${JSON.stringify(C.redact(obj), null, 2)}`);
  const only = (opt('only') || STEPS.join(',')).split(',');
  runPipeline({ campaign: opt('campaign') || 'zztest01', product: opt('product') || 'Galaxy Z Fold8', colour: opt('colour') || '', only, waitMin: Number(opt('wait-min')) || 8, say })
    .then((o) => {
      console.log(`\nProduct: ${C.productLine(o.product)} · product_image_urls: ${o.productImages.length}`);
      console.log(`Order: ${o.order.join(' → ')}`);
      if (o.firstFrame) console.log(`Video first_frame_url: ${o.firstFrame.url}${o.firstFrame.standIn ? ' (stand-in: the storyboard bot returned no image in TEST MODE)' : ' (the storyboard keyframe)'}`);
      console.log('Summary:', JSON.stringify(Object.fromEntries(Object.entries(o.results).map(([k, v]) => [k, `${v.status}${v.raw_status ? ` (${v.raw_status})` : ''}`]))));
    })
    .catch((e) => { console.error('dry run failed:', e.message); process.exit(1); });
}
