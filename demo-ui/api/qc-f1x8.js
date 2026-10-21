const { fetchT } = require('./_http.js');
// Quality Check — real F1X8 integration (the user's Modal-hosted engagement
// scoring backend, contract: packages/contracts/openapi/f1x8.yaml).
//
// POST {kind:'image'|'video', assetUrl, title, description}
//   → downloads the generated asset server-side (no CORS on CloudFront/Modal),
//     re-uploads it as multipart to F1X8's async submit endpoint, returns
//     {job_id}. `description` carries the campaign brief so the response
//     includes context_score (brief-fit) per the adapter policy.
// GET ?job=<job_id>
//   → proxies /api/job/{id}: {status: fetching|analyzing|done|error|not_found,
//     result?: full AnalysisResult (score/10, funnel KPIs, verdict with ranked
//     risks + revision_brief, heatmap, context_score, video percentile)}.
//
// The backend returns errors as HTTP 200 {error, trace} — mapped to 502 here.
const BASE = process.env.MAISTRO_F1X8_BASE_URL
  || 'https://mohamedymay7--fixation-api-fastapi-app.modal.run';

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  try {
    if (req.method === 'GET') {
      const id = (req.query && req.query.job) || '';
      if (!/^[\w-]{4,80}$/.test(id)) return res.status(400).json({ error: 'invalid job id' });
      const r = await fetchT(`${BASE}/api/job/${encodeURIComponent(id)}`, {}, { timeoutMs: 20000, retries: 1 });
      const d = await r.json().catch(() => ({}));
      if (d && d.status === 'error') {
        return res.status(200).json({ status: 'error', error: d.error || 'F1X8 analysis failed' });
      }
      return res.status(200).json(d);
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const kind = b.kind === 'video' ? 'video' : 'image';
      const assetUrl = String(b.assetUrl || '');
      if (!/^https:\/\//.test(assetUrl)) return res.status(422).json({ error: 'assetUrl (https) is required' });

      const ar = await fetchT(assetUrl, {}, { timeoutMs: 60000 });
      if (!ar.ok) return res.status(502).json({ error: `could not fetch asset (${ar.status})` });
      const buf = await ar.arrayBuffer();
      if (buf.byteLength > 50 * 1024 * 1024) return res.status(413).json({ error: 'asset too large for analysis' });
      const ctype = ar.headers.get('content-type') || (kind === 'video' ? 'video/mp4' : 'image/png');

      const form = new FormData();
      form.append('file', new Blob([buf], { type: ctype }), kind === 'video' ? 'final.mp4' : 'asset.png');
      if (b.title) form.append('title', String(b.title).slice(0, 200));
      if (b.description) form.append('description', String(b.description).slice(0, 4000));
      if (kind === 'image') form.append('format_type', 'social');
      form.append('role', 'creative_director');

      const endpoint = kind === 'video' ? '/api/analyze/video/submit' : '/api/analyze/image/submit';
      const r = await fetchT(BASE + endpoint, { method: 'POST', body: form }, { timeoutMs: 120000 });
      const d = await r.json().catch(() => ({}));
      if (d && d.error) return res.status(502).json({ error: d.error });
      if (!d || !d.job_id) return res.status(502).json({ error: `F1X8 submit failed (${r.status})` });
      return res.status(200).json({ job_id: d.job_id });
    }

    res.setHeader('Allow', 'GET, POST, OPTIONS');
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'F1X8 proxy failed' });
  }
};
