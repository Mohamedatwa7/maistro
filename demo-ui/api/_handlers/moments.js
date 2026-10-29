// GET /api/moments (session): the big occasions to plan around (api/_trends/moments.js).
//   upcoming: the planned calendar, under way or starting within ~5 months
//   breaking: what is spiking now in the Gulf (Google Trends) and on Wikipedia,
//             brand-checked by Claude; `hidden` lists what was screened out
// ?view=upcoming skips the live sources.
// The breaking read is slow (six feeds, two Wikipedia days, a Claude pass) and costs a
// Claude call, so the hourly cron prepares it and stores it as trends_cache row 'moments';
// a signed-in read serves that row, and only reads live when the row is missing or older
// than 75 minutes (the cron missed a run). A warm instance also keeps its last answer.
// The cron also refreshes each moment's live reference videos (api/_trends/moment-videos.js,
// row 'moment-videos'); reads only attach the stored videos, they never search.
const moments = require('../_trends/moments.js');
const videos = require('../_trends/moment-videos.js');
const { requireSession, isCron } = require('../_auth.js');
const { queryRows, upsertRows } = require('../_supabase.js');

const CACHE_KEY = 'moments', VIDEOS_KEY = 'moment-videos';
// the moments worth live references: under way, inside their production window or within 30 days, and every breaking one
const referenced = (upcoming, breaking) => upcoming.filter((m) => m.status !== 'later' || m.daysUntil <= 30)
  .concat(breaking && breaking.classifiedBy === 'claude' ? breaking.items || [] : []);
const STALE_MS = 75 * 60e3, MEMO_MS = 10 * 60e3, FAILED_MS = 2 * 60e3, KEEP_CHECKED_MS = 24 * 3600e3;
let memo = null; // { at, breaking }

const dbConfigured = () => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
async function readStored() {
  if (!dbConfigured()) return null;
  try {
    const row = (await queryRows('trends_cache', `select=*&id=eq.${CACHE_KEY}&limit=1`))[0];
    return row && row.payload && row.payload.breaking ? { at: new Date(row.fetched_at).getTime(), breaking: row.payload.breaking } : null;
  } catch (e) { console.warn('[moments] cache read failed:', e.message); return null; }
}
async function store(breaking) {
  if (!dbConfigured() || breaking.error) return; // a failed read never replaces a good one
  try { await upsertRows('trends_cache', [{ id: CACHE_KEY, payload: { breaking }, source: 'moments', fetched_at: new Date().toISOString(), error: null }], 'id'); }
  catch (e) { console.warn('[moments] cache write failed:', e.message); }
}
async function readVideos() {
  if (!dbConfigured()) return null;
  try { const row = (await queryRows('trends_cache', `select=*&id=eq.${VIDEOS_KEY}&limit=1`))[0]; return row && row.payload ? row.payload : null; }
  catch (e) { console.warn('[moments] videos read failed:', e.message); return null; }
}
async function storeVideos(payload) {
  if (!dbConfigured()) return;
  try { await upsertRows('trends_cache', [{ id: VIDEOS_KEY, payload, source: 'tikhub', fetched_at: new Date().toISOString(), error: null }], 'id'); }
  catch (e) { console.warn('[moments] videos write failed:', e.message); }
}
const withVideos = (list, byId) => (list || []).map((m) => (byId && byId[m.id] ? { ...m, videos: byId[m.id].videos, videosAt: byId[m.id].at, captionsCheckedBy: byId[m.id].captionsCheckedBy, videosScreenedOut: byId[m.id].screenedOut || 0 } : m));
async function fresh(now) {
  let breaking;
  try { breaking = await moments.fetchBreaking({ now }); }
  catch (e) { breaking = { error: String(e.message || e), items: [], hidden: [], routine: 0, classifiedBy: 'none', errors: [] }; }
  if (breaking.classifiedBy !== 'claude') {
    // the brand check failed (2026-10-29: the Anthropic credit ran out): a checked copy under a day old
    // is better than unchecked searches, so keep serving it and say why the refresh was skipped
    const stored = await readStored();
    if (stored && stored.breaking.classifiedBy === 'claude' && Date.now() - stored.at < KEEP_CHECKED_MS) {
      const kept = { ...stored.breaking, refreshSkipped: (breaking.errors || []).concat(breaking.error ? [breaking.error] : []).join('; ').slice(0, 300) || 'the brand check was unavailable' };
      memo = { at: Date.now(), breaking: kept, keptFrom: stored.at };
      return kept;
    }
  }
  memo = { at: Date.now(), breaking };
  await store(breaking);
  return breaking;
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'GET only' });
  }
  const now = new Date();
  if (isCron(req)) {
    const b = await fresh(now);
    let v = { calls: 0, errors: [] };
    try {
      v = await videos.refresh(referenced(moments.upcoming(now), b), (await readVideos()) || {}, { now: now.getTime() });
      if (v.calls) await storeVideos({ byId: v.byId });
    } catch (e) { v.errors = [String(e.message || e)]; }
    res.setHeader('Cache-Control', 'no-store');
    return res.status(b.error ? 502 : 200).json({ ok: !b.error, videos: { calls: v.calls, captionsCheckedBy: v.captionsCheckedBy || null, errors: v.errors }, kept: Boolean(b.refreshSkipped), refreshSkipped: b.refreshSkipped || null, items: b.items.length, hidden: b.hidden.length, routine: b.routine, classifiedBy: b.classifiedBy, errors: b.errors, error: b.error || null });
  }
  if (!requireSession(req, res)) return;
  const q = req.query || {};
  const vids = ((await readVideos()) || {}).byId || null;
  const upcoming = withVideos(moments.upcoming(now), vids);
  let breaking = null, preparedAt = null;
  if (q.view !== 'upcoming') {
    if (memo && Date.now() - memo.at < (memo.breaking.error ? FAILED_MS : MEMO_MS)) ({ breaking } = memo), preparedAt = memo.at;
    else {
      const stored = await readStored();
      if (stored && Date.now() - stored.at < STALE_MS) { breaking = stored.breaking; preparedAt = stored.at; memo = { at: Date.now(), breaking }; }
      else { breaking = await fresh(now); preparedAt = memo && memo.keptFrom ? memo.keptFrom : Date.now(); }
    }
  }
  res.setHeader('Cache-Control', breaking && breaking.error ? 'private, max-age=60' : 'private, max-age=600');
  return res.status(200).json({ at: now.toISOString(), upcoming, breaking: breaking && { ...breaking, items: withVideos(breaking.items, vids), preparedAt: preparedAt ? new Date(preparedAt).toISOString() : null } });
};
