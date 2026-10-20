// POST /api/upload — stores a product reference photo in Supabase Storage
// (public bucket "refs") and returns its public URL. The client downsizes the
// image to ≤1600px JPEG before sending, so bodies stay well under limits.
// Body: { data: <base64 (no data: prefix)>, contentType: 'image/jpeg' }
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST, OPTIONS');
    return res.status(405).json({ error: 'method not allowed' });
  }
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return res.status(503).json({ error: 'storage is not configured' });

  try {
    const b = req.body || {};
    const data = String(b.data || '');
    if (!data) return res.status(422).json({ error: 'data (base64) is required' });
    const buf = Buffer.from(data, 'base64');
    if (!buf.length || buf.length > 4 * 1024 * 1024) {
      return res.status(413).json({ error: 'image must be under 4MB — it is resized client-side, try a smaller photo' });
    }
    const contentType = /^image\/(jpeg|png|webp)$/.test(b.contentType) ? b.contentType : 'image/jpeg';
    const ext = contentType === 'image/png' ? 'png' : contentType === 'image/webp' ? 'webp' : 'jpg';
    const path = `products/${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    // Ensure the public bucket exists (409 = already there).
    await fetch(`${base}/storage/v1/bucket`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'refs', name: 'refs', public: true }),
    }).catch(() => {});

    const up = await fetch(`${base}/storage/v1/object/refs/${path}`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': contentType, 'x-upsert': 'true' },
      body: buf,
    });
    if (!up.ok) {
      const t = await up.text().catch(() => '');
      return res.status(502).json({ error: `upload failed (${up.status}) ${t.slice(0, 160)}` });
    }
    return res.status(200).json({ url: `${base}/storage/v1/object/public/refs/${path}` });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'upload failed' });
  }
};
