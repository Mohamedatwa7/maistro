// F1X8 adapter (M3, ADR-004): the real engagement-scoring backend (the
// owner's Modal app, contract packages/contracts/openapi/f1x8.yaml). Submit
// downloads the asset server-side (CloudFront/Modal have no CORS) and
// re-uploads it as multipart; status reads /api/job/{id}. Shared by the
// request handler api/_handlers/qc-f1x8.js and the job service.
const { fetchT } = require('../_http.js');

const base = () => process.env.MAISTRO_F1X8_BASE_URL || 'https://mohamedymay7--fixation-api-fastapi-app.modal.run';

// SSRF guard (M1, AUDIT C-14): the asset is fetched server-side, so only the
// hosts that hold generated media are allowed — the Higgsfield CDN
// (CloudFront) and Higgsfield itself, S3, and Maistro's own Supabase storage.
// Extend with QC_ASSET_HOSTS="suffix1,suffix2" when a new provider host appears.
const DEFAULT_ASSET_HOSTS = ['.cloudfront.net', '.higgsfield.ai', '.amazonaws.com'];
function assetHostAllowed(assetUrl) {
  let u;
  try { u = new URL(assetUrl); } catch { return false; }
  if (u.protocol !== 'https:' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  const extra = String(process.env.QC_ASSET_HOSTS || '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
  const supa = (() => { try { return process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).hostname.toLowerCase() : null; } catch { return null; } })();
  if (supa && host === supa) return true;
  return [...DEFAULT_ASSET_HOSTS, ...extra].some((suf) => (suf.startsWith('.') ? host.endsWith(suf) : host === suf));
}

/** Download an allowed media asset → { buf (ArrayBuffer), contentType }. */
async function fetchAsset(assetUrl, maxBytes = 50 * 1024 * 1024) {
  if (!/^https:\/\//.test(String(assetUrl || ''))) throw Object.assign(new Error('assetUrl (https) is required'), { status: 422 });
  if (!assetHostAllowed(assetUrl)) {
    console.warn('[f1x8] refused asset host', (() => { try { return new URL(assetUrl).hostname; } catch { return '?'; } })());
    throw Object.assign(new Error('assetUrl host is not an allowed media host'), { status: 422 });
  }
  const ar = await fetchT(assetUrl, {}, { timeoutMs: 60000 });
  if (!ar.ok) throw Object.assign(new Error(`could not fetch asset (${ar.status})`), { status: 502 });
  const buf = await ar.arrayBuffer();
  if (buf.byteLength > maxBytes) throw Object.assign(new Error('asset too large for analysis'), { status: 413 });
  return { buf, contentType: ar.headers.get('content-type') || null };
}

/** Submit an analysis → { ref: job_id }. */
async function submit({ kind, assetUrl, title, description }) {
  kind = kind === 'video' ? 'video' : 'image';
  const { buf, contentType } = await fetchAsset(assetUrl);
  const ctype = contentType || (kind === 'video' ? 'video/mp4' : 'image/png');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: ctype }), kind === 'video' ? 'final.mp4' : 'asset.png');
  if (title) form.append('title', String(title).slice(0, 200));
  if (description) form.append('description', String(description).slice(0, 4000));
  if (kind === 'image') form.append('format_type', 'social');
  form.append('role', 'creative_director');
  const endpoint = kind === 'video' ? '/api/analyze/video/submit' : '/api/analyze/image/submit';
  const r = await fetchT(base() + endpoint, { method: 'POST', body: form }, { timeoutMs: 120000 });
  const d = await r.json().catch(() => ({}));
  if (d && d.error) throw Object.assign(new Error(d.error), { status: 502 });
  if (!d || !d.job_id) throw Object.assign(new Error(`F1X8 submit failed (${r.status})`), { status: 502 });
  return { ref: d.job_id };
}

/** Status → { status: fetching|analyzing|done|error|not_found, result?, error? }.
 *  The backend reports failures as HTTP 200 {status:'error'}. */
async function status(ref) {
  if (!/^[\w-]{4,80}$/.test(String(ref || ''))) throw Object.assign(new Error('invalid job id'), { status: 400 });
  const r = await fetchT(`${base()}/api/job/${encodeURIComponent(ref)}`, {}, { timeoutMs: 20000, retries: 1 });
  const d = await r.json().catch(() => ({}));
  if (d && d.status === 'error') return { status: 'error', error: d.error || 'F1X8 analysis failed' };
  return d || {};
}

module.exports = { submit, status, fetchAsset, assetHostAllowed, DEFAULT_ASSET_HOSTS };
