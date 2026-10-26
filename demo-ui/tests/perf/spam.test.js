const test = require('node:test');
const assert = require('node:assert/strict');
const { filterSpam, spamReason } = require('../../api/_perf/spam.js');
const { themes, productFor } = require('../../api/_perf/themes.js');

const INDIA_WALL = 'SAMSUNG MEGA OFFER! 🚨 Buy a Samsung S series today and get a ✨ FREE GREEN LINE ✨ exactly after 1 year! (100% Guaranteed!) 🟢📱 Feeling lucky? You might even get a Red Line combo! 🔴 Warranty support after 1 year? Absolutely ZERO! 🚫 Bought the phone outside India? Congratulations, you just purchased a very expensive piece of electronic waste! 🗑️👏 Thank you Samsung, for turning our premium displays into colorful barcodes! 🤣👇Absolutely unacceptable from @SamsungIndia! My Galaxy S23 (bought in UAE) got the infamous #RedLine hardware defect with ZERO physical damage. CEO desk rejected the free replacement and demands ₹12kfor YOUR manufacturing flaw! Is this your "Global Brand" promise';

test('spam: the reported @SamsungIndia campaign wall is spam; a Gulf green-line complaint is not', () => {
  assert.ok(spamReason(INDIA_WALL));
  assert.ok(spamReason('Absolutely unacceptable from @SamsungIndia! demands ₹12k'));
  assert.equal(spamReason('My S26 Ultra got green lines after the update and the service center in Dubai did nothing'), null);
  assert.equal(spamReason('How much is the Fold8 in AED?'), null);
  assert.equal(spamReason('follow me for giveaways'), 'bait');
});

test('spam: a long message pasted by 3+ accounts is removed; one person repeating is not', () => {
  const msg = 'This brand ignores every customer with a broken display and nobody answers the support line ever again';
  const posts = [
    { postId: '1', comments: [{ author: 'a', text: msg }, { author: 'z', text: 'love it' }] },
    { postId: '2', comments: [{ author: 'b', text: msg + '!!' }] },
    { postId: '3', comments: [{ author: 'c', text: '@x ' + msg }, { author: 'q', text: INDIA_WALL }] },
  ];
  const r = filterSpam(posts);
  assert.equal(r.removed, 4);
  assert.deepEqual(r.byReason, { copy_paste: 3, other_market: 1 });
  assert.deepEqual(r.posts[0].comments.map((c) => c.text), ['love it']);
  assert.equal(r.posts[0].spamRemoved, 1);
  assert.equal(filterSpam(r.posts).removed, 0, 'idempotent');
  const solo = filterSpam([{ comments: [{ author: 'a', text: msg }] }, { comments: [{ author: 'a', text: msg }] }, { comments: [{ author: 'a', text: msg }] }]);
  assert.equal(solo.removed, 0);
});

test('products: devices older than the 2026 lineup count as "Older models", never as their own product', () => {
  assert.deepEqual(productFor('my galaxy s23 got red line', ''), { product: 'Older models (pre-2026)', productFrom: 'comment', device: 'Galaxy S23' });
  assert.equal(productFor('fold7 hinge broke', '').product, 'Older models (pre-2026)');
  assert.equal(productFor('S26 ultra screen lines', '').product, 'Galaxy S26 Ultra');
  assert.equal(productFor('z fold 8 crease', '').product, 'Galaxy Z Fold8');
  assert.equal(productFor('screen lines', 'Meet the Galaxy S26').product, 'Galaxy S26');
});

test('theme examples link to the post they came from', () => {
  const d = themes([{ postId: 'p1', platform: 'instagram', url: 'https://www.instagram.com/p/ABC/', caption: 'Galaxy S26', comments: [{ author: 'u', text: 'my S23 has pink lines on the screen', sentiment: 'neg' }] }]);
  const t = d.themes.find((x) => x.id === 'issue_screen');
  assert.equal(t.examples[0].postUrl, 'https://www.instagram.com/p/ABC/');
  assert.equal(t.examples[0].device, 'Galaxy S23');
  assert.ok(!t.products.some((p) => /S23/.test(p.name)));
});
