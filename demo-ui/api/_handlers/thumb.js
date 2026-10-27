const { fetchT } = require('../_http.js');
const { requireSession } = require('../_auth.js');
// GET /api/thumb?vid=<tiktok video id> — a fresh cover image for a TikTok clip.
// Why: the cover URLs stored by TrendRadar and samsungtrack are signed tiktokcdn links that
// expire (x-expires) within days, so cards showed blank or broken thumbnails. This reads the
// current cover off TikTok's public embed page and streams the image; the CDN keeps it for
// 12 h, well inside the ~2-day signature window.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const CDN = /^https:\/\/[a-z0-9.-]+\.(?:tiktokcdn\.com|tiktokcdn-us\.com|tiktokcdn-eu\.com)\//;

function coverFrom(html) {
  const m = /"covers":\["([^"]+)"/.exec(html || '');
  if (!m) return null;
  const url = m[1].replace(/\\u0026/g, '&').replace(/\\u002F/g, '/').replace(/\\\//g, '/');
  return CDN.test(url) ? url : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!requireSession(req, res)) return;
  const vid = String((req.query && req.query.vid) || '');
  if (!/^\d{8,25}$/.test(vid)) return res.status(422).json({ error: 'vid must be a TikTok video id' });
  const miss = (why) => { res.setHeader('Cache-Control', 'public, s-maxage=600'); return res.status(404).json({ error: why }); };
  try {
    const page = await fetchT(`https://www.tiktok.com/embed/v2/${vid}`, { headers: { 'user-agent': UA, 'accept-language': 'en' } }, { timeoutMs: 8000, retries: 1 });
    if (!page.ok) return miss(`tiktok embed responded ${page.status}`);
    const cover = coverFrom(await page.text());
    if (!cover) return miss('no cover on the embed page');
    const img = await fetchT(cover, { headers: { 'user-agent': UA } }, { timeoutMs: 8000, retries: 1 });
    const type = img.headers.get('content-type') || '';
    if (!img.ok || !/^image\//.test(type)) return miss(`cover responded ${img.status}`);
    const buf = Buffer.from(await img.arrayBuffer());
    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=43200');
    return res.status(200).end(buf);
  } catch (e) {
    return miss(e.message || 'cover fetch failed');
  }
};

module.exports.coverFrom = coverFrom;
