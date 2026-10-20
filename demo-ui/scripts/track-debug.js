// Diagnose why /api/track matches 0 comments.
const H = { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: 'Bearer ' + process.env.SUPABASE_SERVICE_ROLE_KEY };
const BASE = process.env.SUPABASE_URL;
(async () => {
  const days = 60;
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const posts = await (await fetch(`${BASE}/rest/v1/social_posts?select=external_id,platform,published_at,raw_data&published_at=gte.${since}&order=published_at.desc&limit=1000`, { headers: H })).json();
  const author = (p) => { const r = p.raw_data || {}; return r.ownerUsername || (r.authorMeta && r.authorMeta.name) || (r.author && r.author.userName) || r.pageName || (r.user && r.user.username) || r.authorUsername || r.username || null; };
  const ours = posts.filter((p) => /samsung/i.test(author(p) || ''));
  console.log('posts:', posts.length, '| samsung:', ours.length);
  const ids = new Set(ours.map((p) => String(p.external_id)));
  let matched = 0, nulls = 0, seen = 0, oldest = null, newest = null;
  const floor = new Date(Date.now() - (days + 3) * 864e5).toISOString();
  for (let page = 0; page < 40; page++) {
    const rows = await (await fetch(`${BASE}/rest/v1/social_comments?select=external_post_id,published_at&order=published_at.desc&limit=1000&offset=${page * 1000}`, { headers: H })).json();
    if (!Array.isArray(rows) || !rows.length) { console.log('end at page', page); break; }
    seen += rows.length;
    for (const c of rows) {
      if (!c.published_at) nulls++;
      else { if (!newest) newest = c.published_at; oldest = c.published_at; }
      if (ids.has(String(c.external_post_id))) matched++;
    }
    const last = rows[rows.length - 1].published_at;
    console.log('page', page, '| last published_at:', last, '| matched so far:', matched, '| nulls:', nulls);
    if (last && last < floor) { console.log('floor hit'); break; }
  }
  console.log('TOTAL seen:', seen, 'matched:', matched, 'nulls:', nulls, '| newest:', newest, 'oldest:', oldest);
  // sample: do ANY comments reference one of our recent post ids?
  const sample = [...ids].slice(0, 5);
  for (const id of sample) {
    const r = await (await fetch(`${BASE}/rest/v1/social_comments?select=external_post_id&external_post_id=eq.${id}&limit=3`, { headers: H })).json();
    console.log('direct lookup', id, '→', Array.isArray(r) ? r.length : r);
  }
})();
