const { fetchT } = require('../_http.js');
const { requireSession } = require('../_auth.js');
// POST /api/translate — same mechanism as samsungtrack's translate route:
// the free Google Translate gtx endpoint, auto-detect → English.
// Body: { text, targetLang? } → { translatedText, detectedLanguage }
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'method not allowed' });
  }
  if (!requireSession(req, res)) return;
  try {
    const b = req.body || {};
    const text = String(b.text || '').slice(0, 1500);
    if (!text.trim()) return res.status(422).json({ error: 'text is required' });
    const target = /^[a-z]{2}$/i.test(b.targetLang || '') ? b.targetLang : 'en';
    const r = await fetchT(
      `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${target}&dt=t&q=${encodeURIComponent(text)}`,
      { headers: { 'user-agent': 'Mozilla/5.0 (compatible; MaistroDemo/1.0)' } },
      { timeoutMs: 10000, retries: 1 },
    );
    if (!r.ok) return res.status(502).json({ error: `translation service responded ${r.status}` });
    const data = await r.json();
    let translatedText = '';
    if (data && data[0]) {
      translatedText = data[0].filter((it) => it && it[0]).map((it) => it[0]).join('');
    }
    res.setHeader('Cache-Control', 's-maxage=86400');
    return res.status(200).json({
      translatedText: translatedText || text,
      detectedLanguage: (data && data[2]) || 'unknown',
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'translation failed' });
  }
};
