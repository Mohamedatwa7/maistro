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
const cache = new Map(); // window → { at, value }; a few months at most

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

/** { items, from, to, fetchedAt } — items newest first; cached 10 minutes per window */
async function feed({ from, to, now = Date.now() } = {}) {
  const f = Number.isFinite(from) ? from : now - 14 * 864e5, t = Number.isFinite(to) ? to : now + 45 * 864e5;
  const key = `${Math.floor(f / 36e5)}:${Math.floor(t / 36e5)}:${process.env.SPRINKLR_FEED_ACCOUNTS || ''}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.value;
  const accounts = feedAccounts();
  const list = await rows(f, t, now);
  const by = await details(list);
  const items = list.map((r) => {
    const d = by.get(r.id) || {};
    const c = d.content || {}, a = c.attachment || {};
    const tx = d.taxonomy || {};
    return { id: r.id, platform: accounts[r.accountId] || null, accountId: r.accountId, status: r.status, at: r.at, text: String(c.text || c.title || '').slice(0, 280), permalink: d.permalink || null, media: a.type || null, campaignId: tx.campaignId ? String(tx.campaignId) : null, accountGroupId: d.accountGroupId != null ? String(d.accountGroupId) : null };
  }).filter((x) => x.platform).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const value = { items, from: new Date(f).toISOString(), to: new Date(t).toISOString(), fetchedAt: new Date(now).toISOString() };
  cache.set(key, { at: now, value });
  if (cache.size > 12) cache.delete(cache.keys().next().value);
  return value;
}

/** The campaigns the owned accounts' posts were filed under (the spec has no campaign list): ids from each post's
 *  taxonomy over the window, with counts and an example, plus Sprinklr's resolved names when its report gives them. */
async function campaigns({ days = 90, now = Date.now() } = {}) {
  const f = await feed({ from: now - days * 864e5, to: now + 45 * 864e5, now });
  const by = new Map();
  for (const i of f.items) {
    if (!i.campaignId) continue;
    const c = by.get(i.campaignId) || { id: i.campaignId, name: null, posts: 0, lastAt: null, platforms: new Set(), example: null };
    c.posts++; c.platforms.add(i.platform);
    if (!c.lastAt || String(i.at) > c.lastAt) { c.lastAt = i.at; c.example = i.text || c.example; }
    by.set(i.campaignId, c);
  }
  let names = null;
  try {
    const r = await sprinklr.report({
      reportingEngine: 'OUTBOUND_MESSAGE', report: 'OUTBOUND_MESSAGE', timeZone: 'Asia/Dubai', page: 0, pageSize: 200, startTime: now - days * 864e5, endTime: now + 45 * 864e5,
      filters: [{ dimensionName: 'ACCOUNT_ID', filterType: 'IN', values: Object.keys(feedAccounts()) }],
      groupBys: [dim('CAMPAIGN_ID')], projections: [{ heading: 'n', measurementName: 'OUTBOUND_MESSAGE_COUNT12829', aggregateFunction: 'SUM' }],
    });
    names = r.rows.slice(0, 200);
    for (const x of names) {
      const id = String(x.CAMPAIGN_ID && typeof x.CAMPAIGN_ID === 'object' ? x.CAMPAIGN_ID.id || '' : x.CAMPAIGN_ID || '');
      const name = x.CAMPAIGN_ID && typeof x.CAMPAIGN_ID === 'object' ? x.CAMPAIGN_ID.name || x.CAMPAIGN_ID.displayName || null : null;
      if (id && by.has(id) && name) by.get(id).name = name;
    }
  } catch (e) { names = { error: String(e.message || e).slice(0, 300) }; }
  // the account group each owned account posts through (SPRINKLR_ACCOUNT_GROUPS needs one per account)
  const groups = new Map();
  for (const i of f.items) {
    if (!i.accountGroupId) continue;
    const k = `${i.platform}:${i.accountGroupId}`;
    const g = groups.get(k) || { platform: i.platform, accountId: i.accountId, accountGroupId: i.accountGroupId, posts: 0 };
    g.posts++; groups.set(k, g);
  }
  const list = [...by.values()].map((c) => ({ ...c, platforms: [...c.platforms] })).sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  return { days, campaigns: list, accountGroups: [...groups.values()].sort((a, b) => a.platform.localeCompare(b.platform) || b.posts - a.posts), postsWithoutCampaign: f.items.filter((i) => !i.campaignId).length, report: names, fetchedAt: f.fetchedAt };
}

module.exports = { feed, feedAccounts, campaigns, STATUS };
