const { fetchT } = require('./_http.js');
const { requireSession } = require('./_auth.js');
// Studio Create — Higgsfield generation proxy.
// POST {kind:'video'|'image', prompt, ...} → submits a generation, returns
//   {request_id, status} immediately (no long polling in a lambda).
//   kind 'video' → Seedance 2.5 text-to-video; kind 'image' → Soul v2 standard.
// GET ?id=<request_id> → proxies the status check; on completed returns the
//   video URL and/or image URLs. Credentials stay server-side in
//   HF_CREDENTIALS (key-id:key-secret).
const MODELS = {
  video: 'bytedance/seedance-2.5/text-to-video',
  image: 'higgsfield-ai/soul/v2/standard',
};
const API = 'https://api.higgsfield.ai';
// Soul v1 (used when a product reference photo is attached — image_reference
// makes the model render the REAL product design). v1 wraps input in {params}
// and polls /v1/job-sets/{id} instead of /requests/{id}/status.
const V1_SIZES = { '16:9': '2048x1152', '4:3': '2048x1536', '1:1': '1536x1536', '9:16': '1152x2048', '3:4': '1536x2048' };

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!requireSession(req, res)) return;

  const creds = process.env.HF_CREDENTIALS;
  if (!creds || !creds.includes(':')) {
    return res.status(503).json({ error: 'HF_CREDENTIALS is not configured' });
  }

  try {
    if (req.method === 'GET') {
      const id = (req.query && req.query.id) || '';
      if (!/^[\w-]{8,64}$/.test(id)) return res.status(400).json({ error: 'invalid id' });
      if ((req.query && req.query.v) === '1') {
        // v1 job-set polling (reference-image generations)
        const r = await fetchT(`${API}/v1/job-sets/${id}`, { headers: { Authorization: `Key ${creds}` } }, { timeoutMs: 10000, retries: 1 });
        if (!r.ok) return res.status(502).json({ error: `job-set check failed (${r.status})` });
        const d = await r.json();
        const job = (d.jobs || [])[0] || {};
        const map = { completed: 'completed', nsfw: 'nsfw', failed: 'failed', canceled: 'canceled' };
        const status = map[job.status] || 'queued';
        const images = status === 'completed' && job.results
          ? [job.results.raw && job.results.raw.url].filter(Boolean) : null;
        return res.status(200).json({ status, video: null, images, raw_status: job.status });
      }
      const r = await fetchT(`${API}/requests/${id}/status`, {
        headers: { Authorization: `Key ${creds}` },
      }, { timeoutMs: 10000, retries: 1 });
      if (!r.ok) return res.status(502).json({ error: `status check failed (${r.status})` });
      const d = await r.json();
      const done = d.status === 'completed';
      const video = done ? (d.video && d.video.url) || (typeof d.video === 'string' ? d.video : null) : null;
      const images = done && Array.isArray(d.images)
        ? d.images.map((im) => (im && im.url) || (typeof im === 'string' ? im : null)).filter(Boolean)
        : null;
      return res.status(200).json({ status: d.status, video, images, raw_status: d.status });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const kind = b.kind === 'image' ? 'image' : 'video';
      const prompt = String(b.prompt || '').trim();
      if (!prompt) return res.status(422).json({ error: 'prompt is required' });
      const resolution = ['480p', '720p', '1080p'].includes(b.resolution) ? b.resolution : '720p';
      const ratios = kind === 'image'
        ? ['9:16', '16:9', '4:3', '3:4', '1:1', '2:3', '3:2']
        : ['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'];
      const aspect_ratio = ratios.includes(b.aspect_ratio) ? b.aspect_ratio : '16:9';
      const ref = typeof b.ref === 'string' && /^https:\/\//.test(b.ref) ? b.ref : null;

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
        if (!r.ok || !d.id) {
          return res.status(502).json({ error: (d && (d.error || JSON.stringify(d.detail || d))) || `soul v1 submit failed (${r.status})` });
        }
        return res.status(200).json({ request_id: d.id, status: 'queued', v: 1 });
      }

      const input = kind === 'image'
        ? { prompt, aspect_ratio, resolution: resolution === '480p' ? '720p' : resolution, batch_size: 1 }
        : { prompt, aspect_ratio, resolution, duration: Math.min(30, Math.max(4, parseInt(b.duration, 10) || 5)) };

      const { createHiggsfieldClient } = require('@higgsfield/client/v2');
      const hf = createHiggsfieldClient({ credentials: creds });
      // The SDK call has no timeout of its own; bound it like every other upstream call.
      const out = await Promise.race([
        hf.subscribe(MODELS[kind], { input, withPolling: false }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('higgsfield submit timed out after 30000 ms')), 30000)),
      ]);
      if (!out || !out.request_id) {
        return res.status(502).json({ error: 'submit failed', detail: out || null });
      }
      return res.status(200).json({ request_id: out.request_id, status: out.status || 'queued' });
    }

    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'higgsfield request failed' });
  }
};
