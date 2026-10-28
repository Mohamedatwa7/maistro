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

test('month view: a grid for the month with Sprinklr posts and Maistro slots by Gulf day; platform chips filter; any month can be opened', async () => {
  const feed = { configured: true, from: '2026-09-30T20:00:00.000Z', to: '2026-10-31T20:00:00.000Z', fetchedAt: '2026-10-21T09:58:00.000Z', items: [
    { id: '501', platform: 'instagram', status: 'scheduled', at: '2026-10-28T07:30:00.000Z', text: 'Meet the new Galaxy Z Fold8', permalink: null, media: 'VIDEO' },
    { id: '600', platform: 'tiktok', status: 'draft', at: '2026-10-30T10:00:00.000Z', text: 'draft copy', permalink: null, media: null },
    { id: '401', platform: 'tiktok', status: 'posted', at: '2026-10-20T21:00:03.000Z', text: '#QuickShare + AirDrop', permalink: 'https://www.tiktok.com/@samsunggulf/video/1', media: 'VIDEO' }] };
  const asked = [];
  const X = loadPage({ fetchImpl: async (u) => { asked.push(String(u)); return String(u).includes('calendar=1') ? json(cal({ slots: [slot({ id: 9, slotAt: '2026-10-25T12:00:00.000Z', platform: 'tiktok', title: 'Deadpan' })] })) : String(u).includes('sprinklr=feed') ? json(feed) : new Promise(() => {}); }, hash: '#/calendar' });
  try {
    X.rCalendar(); await new Promise((r) => setTimeout(r, 30));
    X.rCalendar(); await new Promise((r) => setTimeout(r, 30)); // the second render starts the month's feed load
    let html = X.rCalendar();
    assert.match(html, /<h3[^>]*>October 2026<\/h3>/);
    assert.ok(asked.some((u) => /sprinklr=feed&from=2026-09-30T20%3A00%3A00\.000Z&to=2026-10-31T20%3A00%3A00\.000Z/.test(u)), 'the feed is asked for the Gulf month');
    assert.match(html, /<div class="days">/); assert.match(html, /TODAY/);
    assert.match(html, /ev-seasonal[^"]*" onclick="calSelect\('f:501'\)"[^>]*><span class="tm">11:30<\/span><span class="ti">IG · Meet the new Galaxy Z Fold8/, 'scheduled, at Gulf time');
    assert.match(html, /ev-live[^"]*" onclick="calSelect\('f:401'\)"[^>]*><span class="tm">01:00<\/span>/, 'posted 21:00 UTC is 01:00 GST the next day');
    assert.match(html, /ev-priority[^"]*" onclick="calSelect\('s:9'\)"/, 'a Maistro planned post');
    assert.match(html, /All platforms · 4/); assert.match(html, /TikTok · 3/); assert.match(html, /Instagram · 1/); assert.match(html, /Facebook · 0/); assert.match(html, /YouTube · 0/); assert.match(html, />X · 0/);
    const day21 = html.split('calDay(\'2026-10-21\')')[1].split('class="day')[0];
    assert.match(day21, /calSelect\('f:401'\)/, 'grouped by the Gulf day');
    X.calPlat('instagram'); html = X.rCalendar();
    assert.ok(html.includes("calSelect('f:501')") && !html.includes("calSelect('f:401')") && !html.includes("calSelect('s:9')"), 'the chip filters Sprinklr and Maistro posts alike');
    assert.ok(!/Post now|Publish via Sprinklr/.test(html));
    // a day's list on the right is styled like the grid (readable), a post opens from it, and Back returns to the day, then the month
    X.calPlat('all'); X.calDay('2026-10-21'); html = X.rCalendar();
    assert.match(html, /<button class="calback" onclick="calBack\(\)">← Back to the month/); assert.match(html, /<div class="evlist"><button class="ev ev-live" onclick="calSelect\('f:401'\)">/);
    X.calSelect('f:401'); html = X.rCalendar();
    assert.match(html, /← Back to the day/); assert.match(html, /Open the post ↗/);
    X.calBack(); html = X.rCalendar(); assert.match(html, /class="evlist"/, 'back to the day list');
    X.calBack(); html = X.rCalendar(); assert.ok(!html.includes('calback'), 'back to the month overview');
    X.calSelect('f:501'); X.calSelect('f:501'); assert.ok(!X.rCalendar().includes('Back to the'), 'clicking the open post again closes it');
    // the month picker is the site's own popover, not the browser's native month input
    assert.ok(!/type="month"/.test(html)); X.calPickToggle(); html = X.rCalendar();
    assert.match(html, /class="mpick-pop"/); assert.match(html, /<button class="on [^"]*" onclick="calPick\('2026-10'\)">OCT<\/button>/);
    X.calPickYear(1); assert.match(X.rCalendar(), /calPick\('2027-01'\)/);
    X.calPick('2026-11'); html = X.rCalendar(); assert.ok(!html.includes('mpick-pop'), 'picking a month closes the picker');
    assert.match(html, /<h3[^>]*>November 2026<\/h3>/);
    X.calGo(-2); html = X.rCalendar();
    assert.match(html, /<h3[^>]*>September 2026<\/h3>/);
  } finally { X.restore(); }
  const html = await render(cal({ sprinklr: { configured: false, drafts: false, livePublishing: false } }));
  assert.match(html, /SPRINKLR NOT CONNECTED — MAISTRO POSTS ONLY/);
});

test('composer: "+ Add Maistro post" opens the original post layout for an approved final; Add to calendar plans the slot, push also creates the Sprinklr draft; a Maistro slot opens with its push', async () => {
  const sent = [];
  const data = cal({ unscheduled: [{ pieceId: 'gen-p1', title: 'Deadpan', product: 'Galaxy Z Flip8', platforms: ['tiktok'], markets: ['UAE'], postBy: null, media: { videoUrl: 'https://sb.test/final.mp4', thumbUrl: 'https://sb.test/t.png' } }], sprinklr: { configured: true, drafts: true, livePublishing: false }, owned: { tiktok: ['samsunggulf'], instagram: ['samsunggulf'] } });
  const X = loadPage({ fetchImpl: async (u, init) => { if (init && init.method === 'POST') { const b = JSON.parse(init.body); sent.push(b); return json(b.action === 'slot-plan' ? { ok: true, slot: { id: 41 } } : { ok: true, sprinklr: { draftId: 'D-1' } }); } return String(u).includes('calendar=1') ? json(data) : new Promise(() => {}); }, hash: '#/calendar' });
  try {
    const modal = { innerHTML: '' }; const q0 = X.document.querySelector; // one modal element; the form fields are read from CALC
    X.document.querySelector = (sel) => (sel === '#modal' ? modal : /^#cc-/.test(sel) ? null : q0(sel));
    X.rCalendar(); await new Promise((r) => setTimeout(r, 30));
    assert.match(X.rCalendar(), /onclick="calCompose\(\)">\+ Add Maistro post/); assert.match(X.rCalendar(), /onclick="calCompose\('gen-p1'\)">Add to calendar →/);
    X.calCompose(null, null, '2026-10-30');
    let m = modal.innerHTML;
    assert.match(m, /Post preview/); assert.match(m, /class="cc-phone"/); assert.match(m, /<video src="https:\/\/sb\.test\/final\.mp4"/, 'the real final plays in the preview');
    assert.match(m, /cc-plat on/); assert.match(m, /@samsunggulf/); assert.match(m, /value="2026-10-30T18:00"/); assert.match(m, /Add &amp; push draft to Sprinklr/);
    X.calComposePlat('instagram'); m = modal.innerHTML; assert.match(m, /class="cc-feed"/, 'Instagram shows the feed layout');
    X.CALC.cap = ''; await X.calSave(false); assert.match(modal.innerHTML, /Write the caption/); assert.equal(sent.length, 0);
    X.CALC.cap = 'Wait for it'; await X.calSave(true);
    assert.deepEqual(sent.map((b) => b.action), ['slot-plan', 'slot-export']);
    assert.deepEqual([sent[0].pieceId, sent[0].platform, sent[0].account, sent[0].slotAt, sent[0].caption], ['gen-p1', 'instagram', 'samsunggulf', '2026-10-30T14:00:00.000Z', 'Wait for it']); assert.equal(sent[1].id, 41);
    await new Promise((r) => setTimeout(r, 30)); // the calendar reloads after the save
    X.CALV.data.sprinklr.drafts = false; X.calCompose('gen-p1'); m = modal.innerHTML;
    assert.match(m, /<button class="btn btn-ai btn-sm" disabled onclick="calSave\(true\)">/, 'push is off while Sprinklr drafts are off'); assert.match(m, /SPRINKLR_DRAFTS/);
    X.CALV.data.sprinklr.drafts = true; X.CALV.data.slots = [{ id: 7, pieceId: 'gen-p1', title: 'Deadpan', platform: 'tiktok', account: 'samsunggulf', slotAt: '2026-10-25T12:00:00.000Z', caption: 'c', status: 'planned', media: null }];
    X.calCompose(null, 7); m = modal.innerHTML;
    assert.match(m, /▶ Push draft to Sprinklr/); assert.match(m, /Cancel post/);
  } finally { X.restore(); }
});
