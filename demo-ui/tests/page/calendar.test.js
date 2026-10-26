// Calendar (8b, ADR-008): manual mode keeps its "post by hand" hint; Sprinklr drafts mode shows each slot's draft,
// its status and the Check / Preview actions, a failed draft in red, and never offers to post from Maistro.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadPage, json } = require('../helpers');

const slot = (o) => ({ id: 7, pieceId: 'gen-p1', title: 'Deadpan', platform: 'tiktok', account: 'samsunggulf', slotAt: '2026-10-25T12:00:00.000Z', caption: 'Wait for it…', mode: 'sprinklr', status: 'exported', sprinklrDraftId: null, sprinklrStatus: null, sprinklrCheckedAt: null, sprinklrError: null, ...o });
const cal = (o) => ({ mode: 'sprinklr', connected: false, label: 'Sprinklr: drafts only — export creates the Sprinklr draft; schedule it in Sprinklr (Maistro never posts)', sprinklr: { configured: true, drafts: true, livePublishing: false }, owned: { tiktok: ['samsunggulf'] }, unscheduled: [], slots: [], ...o });
function render(data) {
  const X = loadPage({ fetchImpl: async (u) => (String(u).includes('calendar=1') ? json(data) : new Promise(() => {})), hash: '#/calendar' });
  X.rCalendar(); // the first render starts the load
  return new Promise((r) => setTimeout(r, 30)).then(() => { try { return X.rCalendar(); } finally { X.restore(); } });
}

test('drafts mode: the slot shows its Sprinklr draft and status with Check draft and Preview; nothing posts', async () => {
  const html = await render(cal({ slots: [slot({ sprinklrDraftId: 'dr-1', sprinklrStatus: 'APPROVAL', sprinklrCheckedAt: '2026-10-21T09:00:00.000Z' })] }));
  assert.match(html, /SPRINKLR: DRAFTS ONLY|Sprinklr: drafts only/);
  assert.match(html, /SPRINKLR DRAFT dr-1 · APPROVAL/);
  assert.match(html, /calDraftCheck\('gen-p1',7\)/); assert.match(html, /calPreview\('gen-p1',7\)/);
  assert.match(html, /schedule it in Sprinklr, then link the post/);
  assert.ok(!/Post now|Publish via Sprinklr|SPRINKLR API · CONNECTED/.test(html));
});

test('drafts mode: a draft that failed shows the reason in red; manual mode keeps the post-by-hand hint and no draft actions', async () => {
  let html = await render(cal({ slots: [slot({ sprinklrError: 'sprinklr_account_unmapped: no Sprinklr account group for tiktok:samsunggulf' })] }));
  assert.match(html, /Sprinklr draft not created: sprinklr_account_unmapped/);
  html = await render(cal({ mode: 'manual_export', label: 'Sprinklr: not connected — manual mode (export the package, post by hand, then link the published post)', sprinklr: { configured: false, drafts: false, livePublishing: false }, slots: [slot({ mode: 'manual_export', status: 'planned' })] }));
  assert.match(html, /after posting, link the post on the final/);
  assert.ok(!/calDraftCheck|calPreview|SPRINKLR DRAFT/.test(html));
});
