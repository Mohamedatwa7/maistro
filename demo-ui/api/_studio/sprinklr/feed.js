// What the owned accounts have posted and have lined up in Sprinklr, for the Calendar (read-only). One reporting
// query on the OUTBOUND_MESSAGE engine (time field: schedule date) lists the accounts' feed posts — MESSAGE_TYPE 2,
// "Update"; DMs, comments and replies are other types — with their status; the post and draft endpoints then give
// the text, permalink and media. Cached per instance for 10 minutes: the query and the detail calls take seconds.
const sprinklr = require('./client.js');

// Sprinklr account id per platform (the Samsung Gulf accounts in the Samsung workspace)
const DEFAULT_ACCOUNTS = 'facebook:6625,instagram:53027,tiktok:1776286,x:7952,youtube:7953';
const STATUS = { SENT: 'posted', SCHEDULED: 'scheduled', APPROVAL: 'in_approval', DRAFT: 'draft', FAILED: 'failed' };
const UPDATE = '2';
const PAGE = 200, MAX_PAGES = 15, TTL_MS = 10 * 60 * 1000;
let cache = null;

function feedAccounts() {
  const out = {};
  for (const x of String(process.env.SPRINKLR_FEED_ACCOUNTS || DEFAULT_ACCOUNTS).split(',')) {
    const [p, id] = x.trim().split(':');
    if (p && /^\d+$/.test(id || '')) out[id] = p.toLowerCase() === 'twitter' ? 'x' : p.toLowerCase();
  }
  return out;
}
const dim = (n) => ({ heading: n, dimensionName: n, groupType: 'FIELD' });

/** feed rows in [from, to): { id, kind: 'post'|'draft', accountId, status, at } — one per message. The past and
 *  the future are separate queries so a busy fortnight of posts cannot page the scheduled ones out. */
async function rows(from, to, now) {
  const out = new Map();
  for (const [a, b] of [[Math.max(from, now), to], [from, Math.min(to, now)]]) if (a < b) await window(a, b, out);
  return [...out.values()];
}
async function window(from, to, out) {
  const accounts = Object.keys(feedAccounts());
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await sprinklr.report({
      reportingEngine: 'OUTBOUND_MESSAGE', report: 'OUTBOUND_MESSAGE', timeZone: 'Asia/Dubai', skipResolve: true, page, pageSize: PAGE,
      startTime: from, endTime: to,
      filters: [{ dimensionName: 'ACCOUNT_ID', filterType: 'IN', values: accounts }, { dimensionName: 'MESSAGE_TYPE', filterType: 'IN', values: [UPDATE] }],
      // no PUBLISHED_TIME group: a group on a dimension a row lacks drops the row, and scheduled posts have none
      groupBys: ['UNIQUE_MESSAGE_ID', 'ACCOUNT_ID', 'OUTBOUND_STATUS', 'SCHEDULE_DATE'].map(dim),
      projections: [{ heading: 'n', measurementName: 'OUTBOUND_MESSAGE_COUNT12829', aggregateFunction: 'SUM' }],
    });
    for (const x of r.rows) {
      const m = /^(POST|MESSAGE)_(\d+)$/.exec(String(x.UNIQUE_MESSAGE_ID || ''));
      const status = STATUS[x.OUTBOUND_STATUS];
      // a post is the real item; its MESSAGE_ parent only matters while it is still a draft or in approval
      if (!m || !status || (m[1] === 'MESSAGE' && !['draft', 'in_approval'].includes(status))) continue;
      const at = Number(x.SCHEDULE_DATE); // a posted item's publish time is within seconds of it
      out.set(m[2], { id: m[2], kind: m[1] === 'POST' ? 'post' : 'draft', accountId: String(x.ACCOUNT_ID), status, at: Number.isFinite(at) ? new Date(at).toISOString() : null });
    }
    if (!r.hasMore) break;
  }
}

/** text, permalink and media for the rows, 50 ids per call */
async function details(list) {
  const by = new Map();
  for (const [kind, get] of [['post', sprinklr.getPosts], ['draft', sprinklr.getDrafts]]) {
    const ids = list.filter((r) => r.kind === kind).map((r) => r.id);
    for (let i = 0; i < ids.length; i += 50) for (const d of await get(ids.slice(i, i + 50))) if (d && d.id != null) by.set(String(d.id), d);
  }
  return by;
}

/** { items, from, to, fetchedAt } — items newest first; cached 10 minutes for the same window */
async function feed({ from, to, now = Date.now() } = {}) {
  const f = Number.isFinite(from) ? from : now - 14 * 864e5, t = Number.isFinite(to) ? to : now + 45 * 864e5;
  const key = `${Math.floor(f / 36e5)}:${Math.floor(t / 36e5)}:${process.env.SPRINKLR_FEED_ACCOUNTS || ''}`;
  if (cache && cache.key === key && now - cache.at < TTL_MS) return cache.value;
  const accounts = feedAccounts();
  const list = await rows(f, t, now);
  const by = await details(list);
  const items = list.map((r) => {
    const d = by.get(r.id) || {};
    const c = d.content || {}, a = c.attachment || {};
    return { id: r.id, platform: accounts[r.accountId] || null, accountId: r.accountId, status: r.status, at: r.at, text: String(c.text || c.title || '').slice(0, 280), permalink: d.permalink || null, media: a.type || null };
  }).filter((x) => x.platform).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const value = { items, from: new Date(f).toISOString(), to: new Date(t).toISOString(), fetchedAt: new Date(now).toISOString() };
  cache = { key, at: now, value };
  return value;
}

module.exports = { feed, feedAccounts, STATUS };
