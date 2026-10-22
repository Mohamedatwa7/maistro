// Higgsfield adapter (M3, ADR-004): submit a render, read its status. No
// polling loops here — the job service decides when to ask again. The
// request handler api/_handlers/higgsfield.js and the job service share
// this code so both paths behave identically.
const { fetchT } = require('../_http.js');

const MODELS = {
  video: 'bytedance/seedance-2.5/text-to-video',
  imageVideo: 'bytedance/seedance-2.5/image-to-video', // 6.6: a storyboard keyframe → a clip (HIGGSFIELD.md §2.2: image_url sets the framing; no aspect_ratio)
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
  const batch = kind === 'image' && Number(b.batch) === 4 ? 4 : 1; // SOUL V2 batch_size is 1 or 4
  const seed = kind === 'image' && Number.isInteger(b.seed) && b.seed >= 1 && b.seed <= 1000000 ? b.seed : null; // SOUL V2 seed range (docs)
  const imageUrl = kind === 'video' && typeof b.imageUrl === 'string' && /^https:\/\//.test(b.imageUrl) ? b.imageUrl : null;
  const endImageUrl = imageUrl && typeof b.endImageUrl === 'string' && /^https:\/\//.test(b.endImageUrl) ? b.endImageUrl : null;
  const generateAudio = b.generateAudio === undefined ? true : Boolean(b.generateAudio);
  return { kind, prompt, resolution, aspect_ratio, ref, duration, batch, seed, imageUrl, endImageUrl, generateAudio };
}

// Error classification from the documented status codes (HIGGSFIELD.md §1):
// a concurrency-limit 400, 423 (model blocked) and 503 (model disabled) are
// "retry later"; 403 is insufficient credits (owner action); 401/404/422 and
// other 400s are permanent. The job service reads `retryable`.
function classify(status, detail) {
  const text = Array.isArray(detail) ? JSON.stringify(detail) : String(detail || '');
  if (status === 400 && /concurrent/i.test(text)) return { retryable: true, code: 'concurrency', message: `Higgsfield concurrency limit reached — will retry (${text.slice(0, 120)})` };
  // The docs warn against deciding on the wording of `detail`. A 400 whose
  // detail is a plain string (concurrency, transient rejection) is retried
  // within the submit cap under the same Idempotency-Key — it costs nothing;
  // only a validation list (field errors) is treated as permanent.
  if (status === 400 && !Array.isArray(detail)) return { retryable: true, code: 'rejected', message: `Higgsfield 400: ${text.slice(0, 160) || 'request rejected'} — will retry` };
  if (status === 423 || status === 503 || status === 500 || status === 502 || status === 504) return { retryable: true, code: 'provider_unavailable', message: `Higgsfield ${status}: ${text.slice(0, 160) || 'temporarily unavailable'} — will retry` };
  if (status === 403) return { retryable: false, code: 'insufficient_credits', message: `Higgsfield refused: insufficient credits (${text.slice(0, 120) || '403'}) — top up the account` };
  if (status === 401) return { retryable: false, code: 'auth', message: 'Higgsfield rejected the credentials (401)' };
  if (status === 422) return { retryable: false, code: 'validation', message: `Higgsfield validation failed: ${text.slice(0, 200)}` };
  return { retryable: false, code: 'bad_request', message: `Higgsfield ${status}: ${text.slice(0, 200) || 'request rejected'}` };
}
function providerError(r, body) {
  const detail = body && (body.detail || body.error || body.message);
  const c = classify(r.status, detail);
  return Object.assign(new Error(c.message), { status: r.status, retryable: c.retryable, code: c.code, correlationId: r.headers && r.headers.get ? r.headers.get('x-correlation-id') : null });
}

/** The endpoint and body a (non-reference) submit sends — shared with the estimate so the price is
 *  for exactly what is generated. Returns null for the v1 reference path (no estimate endpoint). */
function buildRequest(reqBody) {
  const { kind, prompt, resolution, aspect_ratio, ref, duration, batch, seed, imageUrl, endImageUrl, generateAudio } = normalizeRequest(reqBody);
  if (kind === 'image' && ref) return null;
  const input = kind === 'image'
    ? { prompt, aspect_ratio, resolution: resolution === '480p' ? '720p' : resolution, batch_size: batch, ...(seed != null ? { seed } : {}) }
    : imageUrl
      ? { image_url: imageUrl, prompt, duration, resolution, generate_audio: generateAudio, bitrate_mode: 'high', ...(endImageUrl ? { end_image_url: endImageUrl } : {}) }
      : { prompt, aspect_ratio, resolution, duration, generate_audio: generateAudio };
  return { endpoint: kind === 'video' && imageUrl ? MODELS.imageVideo : MODELS[kind], input };
}

/** Price a submit before it is made: { usd, credits } or null when the path has no estimate (v1 reference). */
async function estimateRequest(reqBody) {
  const b = buildRequest(reqBody);
  return b ? estimate(b.endpoint, b.input) : null;
}

/** Submit. Returns { ref: provider id, v: 0|1, status, correlationId }.
 *  opts.idempotencyKey (the job id) makes a retried submit replay the
 *  original request instead of generating — and charging — twice. */
async function submit(reqBody, opts = {}) {
  const creds = credentials();
  if (!creds) throw Object.assign(new Error('HF_CREDENTIALS is not configured'), { status: 503 });
  const { kind, prompt, resolution, aspect_ratio, ref, duration, batch, seed, imageUrl, endImageUrl, generateAudio } = normalizeRequest(reqBody);
  const idem = opts.idempotencyKey ? { 'Idempotency-Key': String(opts.idempotencyKey).slice(0, 255) } : {};

  if (kind === 'image' && ref) {
    // Product reference photo attached → Soul v1 with image_reference so
    // the generated image matches the REAL product design.
    const r = await fetchT(`${API}/v1/text2image/soul`, {
      method: 'POST',
      headers: { Authorization: `Key ${creds}`, 'Content-Type': 'application/json', ...idem },
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
    if (!r.ok) throw providerError(r, d);
    if (!d.id) throw Object.assign(new Error(`soul v1 submit returned no id (${r.status})`), { status: 502, retryable: true });
    return { ref: d.id, v: 1, status: 'queued', correlationId: r.headers.get('x-correlation-id') };
  }

  // Current REST API (docs/concepts/requests): POST /<endpoint-id> with the
  // documented body; the SDK's subscribe() is not used so that timeouts,
  // retries and headers are ours and the path is testable with recordings.
  const { endpoint, input } = buildRequest(reqBody);
  const r = await fetchT(`${API}/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Key ${creds}`, 'Content-Type': 'application/json', 'User-Agent': 'MaistroDemo/1.0', ...idem },
    body: JSON.stringify(input),
  }, { timeoutMs: 30000 });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw providerError(r, d);
  if (!d.request_id) throw Object.assign(new Error(`submit returned no request_id (${r.status})`), { status: 502, retryable: true });
  return { ref: d.request_id, v: 0, status: d.status || 'queued', correlationId: r.headers.get('x-correlation-id') };
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

/** Cost before generating (HIGGSFIELD.md H-8): POST /estimate/<endpoint-id> with the same body → { credits, usd }. */
async function estimate(endpoint, body) {
  const creds = credentials();
  if (!creds) throw Object.assign(new Error('HF_CREDENTIALS is not configured'), { status: 503 });
  if (!/^[a-z0-9-]+\/[a-z0-9.\/-]+$/i.test(String(endpoint || ''))) throw Object.assign(new Error('invalid endpoint id'), { status: 400 });
  const r = await fetchT(`${API}/estimate/${endpoint}`, { method: 'POST', headers: { Authorization: `Key ${creds}`, 'Content-Type': 'application/json', 'User-Agent': 'MaistroDemo/1.0' }, body: JSON.stringify(body || {}) }, { timeoutMs: 15000, retries: 1 });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw providerError(r, d);
  // the documented shape is { credits, usd }; video endpoints answered without a top-level usd on
  // 2026-10-22, so look one level down before giving up, and name the keys (never values) when it fails
  const pick = (o, k) => (o && typeof o === 'object' ? o[k] : undefined);
  const cands = [d, pick(d, 'estimate'), pick(d, 'cost'), pick(d, 'price'), pick(d, 'data'), pick(d, 'result')];
  const num = (k) => { for (const o of cands) { const v = pick(o, k); if (v !== undefined && v !== null && v !== '' && Number.isFinite(Number(v))) return Number(v); } return null; };
  const usd = num('usd'), credits = num('credits');
  if (usd == null) {
    const shape = Object.entries(d || {}).map(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? `${k}{${Object.keys(v).join(',')}}` : k)).join(',');
    throw Object.assign(new Error(`estimate returned no usd (keys: ${shape || 'none'})`), { status: 502, credits });
  }
  return { usd, credits };
}

module.exports = { submit, status, estimate, estimateRequest, buildRequest, normalizeRequest, classify, MODELS, API };
