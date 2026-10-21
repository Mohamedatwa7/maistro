// Higgsfield adapter (M3, ADR-004): submit a render, read its status. No
// polling loops here — the job service decides when to ask again. The
// request handler api/_handlers/higgsfield.js and the job service share
// this code so both paths behave identically.
const { fetchT } = require('../_http.js');

const MODELS = {
  video: 'bytedance/seedance-2.5/text-to-video',
  image: 'higgsfield-ai/soul/v2/standard',
};
const API = 'https://api.higgsfield.ai';
// Soul v1 (used when a product reference photo is attached — image_reference
// makes the model render the REAL product design). v1 wraps input in {params}
// and polls /v1/job-sets/{id} instead of /requests/{id}/status.
const V1_SIZES = { '16:9': '2048x1152', '4:3': '2048x1536', '1:1': '1536x1536', '9:16': '1152x2048', '3:4': '1536x2048' };
const IMAGE_RATIOS = ['9:16', '16:9', '4:3', '3:4', '1:1', '2:3', '3:2'];
const VIDEO_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];

const credentials = () => {
  const c = process.env.HF_CREDENTIALS;
  return c && c.includes(':') ? c : null;
};

/** Normalise a submit request. Throws {status:422} on a bad body. */
function normalizeRequest(b = {}) {
  const kind = b.kind === 'image' ? 'image' : 'video';
  const prompt = String(b.prompt || '').trim();
  if (!prompt) throw Object.assign(new Error('prompt is required'), { status: 422 });
  const resolution = ['480p', '720p', '1080p'].includes(b.resolution) ? b.resolution : '720p';
  const ratios = kind === 'image' ? IMAGE_RATIOS : VIDEO_RATIOS;
  const aspect_ratio = ratios.includes(b.aspect_ratio) ? b.aspect_ratio : '16:9';
  const ref = typeof b.ref === 'string' && /^https:\/\//.test(b.ref) ? b.ref : null;
  const duration = Math.min(30, Math.max(4, parseInt(b.duration, 10) || 5));
  return { kind, prompt, resolution, aspect_ratio, ref, duration };
}

/** Submit. Returns { ref: provider id, v: 0|1, status }. */
async function submit(reqBody) {
  const creds = credentials();
  if (!creds) throw Object.assign(new Error('HF_CREDENTIALS is not configured'), { status: 503 });
  const { kind, prompt, resolution, aspect_ratio, ref, duration } = normalizeRequest(reqBody);

  if (kind === 'image' && ref) {
    // Product reference photo attached → Soul v1 with image_reference so
    // the generated image matches the REAL product design.
    const r = await fetchT(`${API}/v1/text2image/soul`, {
      method: 'POST',
      headers: { Authorization: `Key ${creds}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        params: {
          prompt: 'The device shown MUST be the exact product from the reference image — '
            + 'identical form factor, proportions, cameras, colors and finish; do not invent '
            + 'a different device. ' + prompt,
          width_and_height: V1_SIZES[aspect_ratio] || '2048x1152',
          quality: '1080p',
          batch_size: 1,
          image_reference: { type: 'image_url', image_url: ref },
          enhance_prompt: false,
        },
      }),
    }, { timeoutMs: 30000 });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d.id) throw Object.assign(new Error((d && (d.error || JSON.stringify(d.detail || d))) || `soul v1 submit failed (${r.status})`), { status: 502 });
    return { ref: d.id, v: 1, status: 'queued' };
  }

  const input = kind === 'image'
    ? { prompt, aspect_ratio, resolution: resolution === '480p' ? '720p' : resolution, batch_size: 1 }
    : { prompt, aspect_ratio, resolution, duration };
  const { createHiggsfieldClient } = require('@higgsfield/client/v2');
  const hf = createHiggsfieldClient({ credentials: creds });
  // The SDK call has no timeout of its own; bound it like every other upstream call.
  const out = await Promise.race([
    hf.subscribe(MODELS[kind], { input, withPolling: false }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('higgsfield submit timed out after 30000 ms')), 30000)),
  ]);
  if (!out || !out.request_id) throw Object.assign(new Error('submit failed'), { status: 502, detail: out || null });
  return { ref: out.request_id, v: 0, status: out.status || 'queued' };
}

/** Status of a submitted render → { status, video, images, raw_status }.
 *  status is one of queued | processing | completed | failed | nsfw | canceled. */
async function status(ref, v = 0) {
  const creds = credentials();
  if (!creds) throw Object.assign(new Error('HF_CREDENTIALS is not configured'), { status: 503 });
  if (!/^[\w-]{8,64}$/.test(String(ref || ''))) throw Object.assign(new Error('invalid id'), { status: 400 });
  if (Number(v) === 1) {
    const r = await fetchT(`${API}/v1/job-sets/${ref}`, { headers: { Authorization: `Key ${creds}` } }, { timeoutMs: 10000, retries: 1 });
    if (!r.ok) throw Object.assign(new Error(`job-set check failed (${r.status})`), { status: 502 });
    const d = await r.json();
    const job = (d.jobs || [])[0] || {};
    const map = { completed: 'completed', nsfw: 'nsfw', failed: 'failed', canceled: 'canceled' };
    const st = map[job.status] || 'queued';
    const images = st === 'completed' && job.results ? [job.results.raw && job.results.raw.url].filter(Boolean) : null;
    return { status: st, video: null, images, raw_status: job.status };
  }
  const r = await fetchT(`${API}/requests/${ref}/status`, { headers: { Authorization: `Key ${creds}` } }, { timeoutMs: 10000, retries: 1 });
  if (!r.ok) throw Object.assign(new Error(`status check failed (${r.status})`), { status: 502 });
  const d = await r.json();
  const done = d.status === 'completed';
  const video = done ? (d.video && d.video.url) || (typeof d.video === 'string' ? d.video : null) : null;
  const images = done && Array.isArray(d.images) ? d.images.map((im) => (im && im.url) || (typeof im === 'string' ? im : null)).filter(Boolean) : null;
  return { status: d.status, video, images, raw_status: d.status };
}

module.exports = { submit, status, normalizeRequest, MODELS, API };
