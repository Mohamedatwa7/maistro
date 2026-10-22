// Phase 7.4 — comment themes (PERFORMANCE_INSIGHTS.md §4). Counted in code from tested, word-bounded EN / AR /
// Arabizi patterns; no model estimates any count. A theme is added only with its patterns and its false-positive
// tests (tests/perf/themes.test.js). Versioned: a change to a pattern is a change to every count.
//
// Rules (settled with the checker 2026-10-22):
// - A comment can carry several themes. "Question" is a flag on a theme (a purchase question, an issue question);
//   a question matching no theme is "other question", so the "?" in giveaway answers is not the biggest bucket.
// - Purchase intent needs a price or availability object (price, سعر, درهم, ريال, available, متى ينزل …): "how much
//   I love it" and "كم حلو" are not purchase intent.
// - Product issues and complaints carry the post's product, mapped from its caption (labelled so); a caption naming
//   no product gives "product unknown".
// - On giveaway posts the comments are counted as giveaway entries, not as praise; complaints, issues and
//   purchase intent on those posts still count (people post complaints wherever the brand is listening).
// - Shares per product only at n ≥ 20; counts below.
const THEMES_VERSION = 'themes-v3-2026-10-22';
const MIN_N = 20;
const { isGiveawayCaption } = require('./benchmarks.js');

const R = (s) => new RegExp(s, 'iu');
const THEMES = [
  // product issues (v2: display/line synonyms, inner-screen damage, battery drain, "software upgrade")
  { id: 'issue_battery', group: 'product_issue', label: 'Battery / swelling', re: [R(String.raw`\bbatter(?:y|ies)\b.{0,40}\b(?:swell\w*|swollen|drain\w*|dies|dying|bad|issue|problem|bulg\w*|trash|terrible|weak)|\bswollen batter|\b(?:abnormal|fast|quick) battery drain|\bdrain\w* (?:the |my )?batter|\bbattery degrad\w*`), R('انتفاخ (?:ال)?بطاري|بطاري(?:ة|ه|ات).{0,25}(?:انتفخ|منتفخ|تخلص بسرعة|ضعيف|مشكل)')] },
  { id: 'issue_screen', group: 'product_issue', label: 'Screen / display lines', re: [R(String.raw`\b(?:pink|green|white|red|purple) ?lines?\b|#\w*lineissue|\bdead pixels?\b|\bdisplay (?:lines?|issue|problem|defect)|\blines? on (?:the |my )?(?:screen|display)|\b(?:screens?|displays?|panel)\b.{0,40}\b(?:crack(?:ed)?|broke(?:n)?|flicker\w*|lines?|died|black|burn-?in|defect\w*|damaged|fragile|fail\w*)\b|\bfold(?:ing)? line\b|\bcrease\b|\btela (?:interna|quebr\w*)`), R('شاش(?:ة|ه).{0,25}(?:خط|خطوط|كسر|انكسر|تعطل|خربت|مكملتش)|خطوط (?:وردي|خضراء|خضرا)')] },
  { id: 'issue_fingerprint', group: 'product_issue', label: 'Fingerprint sensor', re: [R(String.raw`\bfingerprint\b.{0,40}\b(?:not|doesn|fail\w*|stopp\w*|defect\w*|issue|problem)|\bdefective fingerprint`), R('البصم(?:ة|ه).{0,25}(?:لا|ما|مشكل|عطل|خرب)')] },
  { id: 'issue_heat', group: 'product_issue', label: 'Overheating', re: [R(String.raw`\boverheat\w*|\bheats? up\b|\bgets? (?:very |so |too )?hot\b`), R('يسخن|سخونة|حرار(?:ة|ه) (?:عالي|شديد)')] },
  { id: 'issue_update', group: 'product_issue', label: 'Broken by an update', re: [R(String.raw`\b(?:after|due to|since) (?:the |a |an )?(?:latest |recent )?(?:software |system )?(?:update|upgrade)\b|\b(?:software |latest |recent )?update (?:has )?(?:broke|ruined|killed|bricked|caused)\b|\bpushed an update\b|\bupdate mistake\b`), R('بعد التحديث|التحديث (?:خرب|بوظ|عطل)')] },
  // complaints (v2: general brand complaints split from customer service)
  { id: 'complaint_service', group: 'complaint', label: 'Customer service', re: [R(String.raw`\bcustomer (?:service|care|support)\b|\bservice cent(?:er|re)\b|\bafter[- ]?sales?\b|\bsupport team\b|\bno (?:response|resolution|reply)\b|\bworst (?:service|support)\b|\b(?:poor|bad|very bad|terrible) (?:service|support)\b|\bwhere(?:'s| is) my (?:order|phone|device)\b`), R('خدم(?:ة|ه) (?:ال)?عملاء|مركز (?:ال)?صيان|ما ?بعد البيع|موظف')] },
  { id: 'complaint_general', group: 'complaint', label: 'Brand complaint / don’t buy', re: [R(String.raw`\b(?:do ?n[o']?t|never|pls dont|please don'?t|not to) (?:buy|purchase)\b(?! (?:ios|iphone|apple))|\bstay away from samsung\b|\bcaution before purchasing\b|\blost (?:all |complete |completely )?(?:my )?confidence\b|\bpoor quality\b|\bworst (?:brand|company|experience|phone)\b|\bboycott\b|\bscam\w*\b|\bfraud\b|\bwaste of (?:time and )?money\b|(?<!(?:won['’]?t|not|doesn['’]?t|don['’]?t|never) (?:be )?)\b(?:extremely |very )?disappoint\w*\b|\bunacceptable\b|\b(?:formally )?complain\w*\b`), R('أسوأ|اسوأ|أسوء|اسوء|فاشل(?:ة|ه)?|محتال(?:ة|ه)?|لا تشتر|عدم شراء|بلاش سامسونج|حسبي الله')] },
  { id: 'complaint_repair', group: 'complaint', label: 'Repair / warranty / refund', re: [R(String.raw`\brepair\w*\b|\bwar+ant+(?:y|ies)\b|\brefund\w*\b|\bmoney back\b|\breplacement\b`), R('صيان(?:ة|ه)|الضمان|ضمان |تصليح|استبدال|استرجاع|استرداد|تغي?ير (?:ال)?شاش|ما ?تصلح')] },
  // purchase intent (needs a price / availability / buying object; v2: first-person intent, affordability)
  { id: 'purchase_price', group: 'purchase', label: 'Price / affordability', re: [R(String.raw`\bprices?\b|\bhow much (?:is|does|for|will)\b|^\s*how much\s*[?!.]*\s*$|\bcost(?:s)?\b|\b(?:aed|sar|dhs?|dirhams?|riyals?|kwd|qar|omr|bhd)\b|\b(?:can'?t|cannot|not able to|not capable to) (?:afford|buy)\b|\btoo expensive\b|\bdon'?t have (?:the )?money\b`), R('السعر|سعر(?:ه|ها)?\b|بكم|على كم|كم سعر|ريال|درهم|دينار|غالي')] },
  { id: 'purchase_availability', group: 'purchase', label: 'Availability / launch', re: [R(String.raw`\bavailab\w+\b|\bin stock\b|\bwhere (?:can i|to|do i) (?:buy|get|find)\b|\bwhen (?:will|is|does) (?:it|the \w+|this) (?:be )?(?:release|launch|available|come|out)\w*|\brelease date\b|\bpre-?order\w*\b`), R('متى (?:ينزل|يتوفر|ينطلق|نزول)|متوفر|وين (?:احصل|القاه|اشتري)|من وين اشتري|حجز مسبق|طلب مسبق')] },
  { id: 'purchase_buy', group: 'purchase', label: 'Wants to buy / switch', re: [R(String.raw`\b(?:i(?:'ll| will| would|'d| am going to|'m going to| plan(?:ning)? to| want to| chose to| choose to)|gonna|planning to) (?:buy|purchase|order|get|upgrade to|switch to)\b|\bwhat i would buy\b|\bwhen i (?:acquire|buy|get) one\b|\bswitched to\b|\bupgrading to\b|\btake my money\b`), R('(?:راح |ناوي |ابي |ودي )اشتري|بشتري|راح اطلب')] },
  // requests for a free device (not purchase intent)
  { id: 'request_free', group: 'request', label: 'Asks for a free device', re: [R(String.raw`\bgive me (?:a |an |one|some|pls|please|free|the s\d|s\d|galaxy)|\b(?:pls |please |just )?gift me\b|\bif i (?:hit|get|reach)\b.{0,20}\blikes?\b|\bhow many likes?\b|\bfree (?:phone|ssd|gift|device)\b|\bsend me\b`), R('اعطني|اعطوني|عطوني|هدي(?:ة|ه)|تنطني|كم لايك|أريد هاتف|اريد هاتف|أرجوك')] },
  // praise (v2: camera needs camera words, not any "photo")
  { id: 'praise_design', group: 'praise', label: 'Design / colour', re: [R(String.raw`\b(?:colou?rs?|design|sleek|stylish|gorgeous|beautiful|pink|mint|cream|elegant)\b`), R('(?:ال)?لون|(?:ال)?ألوان|(?:ال)?الوان|تصميم|أنيق|انيق|جميل|كريمي')] },
  { id: 'praise_camera', group: 'praise', label: 'Camera', re: [R(String.raw`\bcameras?\b|\bzoom\b|\bselfies?\b|\b(?:clear|sharp|bright|great|good|amazing|stunning) (?:pics|photos?|pictures?|shots?)\b|\b(?:photo|picture|picture) quality\b|\b\d{2,3} ?mp\b`), R('كاميرا|الكاميرا|تصوير')] },
  { id: 'praise_ecosystem', group: 'praise', label: 'Ecosystem / combo', re: [R(String.raw`\bcombo\b|\becosystem\b|\bpaired with\b|\bbuds\w*\b.{0,30}\bwatch\w*\b|\bwatch\w*\b.{0,30}\bbuds\w*\b`), R('اقتران|كومبو|مزيج|سماعات.{0,20}ساع|ساع.{0,20}سماعات')] },
  { id: 'praise_multitask', group: 'praise', label: 'Multitasking / big screen', re: [R(String.raw`\bmulti-?task\w*\b|\bsplit[- ]screen\b|\b(?:three|3) apps\b|\bdex\b|\bbig (?:inner )?screen\b`), R('تعدد المهام|الشاشة الكبيرة|شاشة كبيرة')] },
  // noise
  { id: 'spam', group: 'spam', label: 'Spam / off-topic', re: [R(String.raw`\bfollow me\b|\bcheck my (?:page|profile|channel)\b|\bdm me\b|\bcrypto\b|\bbitcoin\b|\bsuper ?ai\b|\bbequeath\w*\b|#seat28g\b|\bprophecy eternal\b`)] },
];
// Measured precision / recall per theme (tests/perf/themes.test.js recomputes these from
// tests/fixtures/theme-audit-*-2026-10-22.json and fails if they differ: a pattern change needs a re-measure).
const AUDIT = {"issue_battery":{"basis":"every distinct candidate text (adjudicated)","tp":5,"fp":0,"fn":0,"precision":1,"recall":1,"pCI":[0.566,1],"rCI":[0.566,1]},"issue_screen":{"basis":"every distinct candidate text (adjudicated)","tp":31,"fp":0,"fn":1,"precision":1,"recall":0.969,"pCI":[0.89,1],"rCI":[0.843,0.994]},"issue_fingerprint":{"basis":"every distinct candidate text (adjudicated)","tp":1,"fp":0,"fn":0,"precision":1,"recall":1,"pCI":[0.207,1],"rCI":[0.207,1]},"issue_heat":{"basis":"every distinct candidate text (adjudicated)","tp":1,"fp":0,"fn":0,"precision":1,"recall":1,"pCI":[0.207,1],"rCI":[0.207,1]},"issue_update":{"basis":"every distinct candidate text (adjudicated)","tp":5,"fp":0,"fn":0,"precision":1,"recall":1,"pCI":[0.566,1],"rCI":[0.566,1]},"complaint_service":{"basis":"every distinct candidate text (adjudicated)","tp":22,"fp":6,"fn":1,"precision":0.786,"recall":0.957,"pCI":[0.605,0.898],"rCI":[0.79,0.992]},"complaint_general":{"basis":"every distinct candidate text (adjudicated)","tp":50,"fp":0,"fn":2,"precision":1,"recall":0.962,"pCI":[0.929,1],"rCI":[0.87,0.989]},"complaint_repair":{"basis":"every distinct candidate text (adjudicated)","tp":32,"fp":1,"fn":1,"precision":0.97,"recall":0.97,"pCI":[0.847,0.995],"rCI":[0.847,0.995]},"purchase_price":{"basis":"seeded sample","tp":7,"fp":4,"fn":2,"precision":0.636,"recall":0.778,"pCI":[0.354,0.848],"rCI":[0.453,0.937]},"purchase_availability":{"basis":"seeded sample","tp":2,"fp":0,"fn":0,"precision":1,"recall":1,"pCI":[0.342,1],"rCI":[0.342,1]},"purchase_buy":{"basis":"seeded sample","tp":5,"fp":0,"fn":1,"precision":1,"recall":0.833,"pCI":[0.566,1],"rCI":[0.436,0.97]},"request_free":{"basis":"seeded sample","tp":13,"fp":0,"fn":10,"precision":1,"recall":0.565,"pCI":[0.772,1],"rCI":[0.368,0.744]},"praise_design":{"basis":"seeded sample","tp":18,"fp":8,"fn":7,"precision":0.692,"recall":0.72,"pCI":[0.5,0.835],"rCI":[0.524,0.857]},"praise_camera":{"basis":"seeded sample","tp":5,"fp":1,"fn":8,"precision":0.833,"recall":0.385,"pCI":[0.436,0.97],"rCI":[0.177,0.645]},"praise_ecosystem":{"basis":"seeded sample","tp":24,"fp":3,"fn":9,"precision":0.889,"recall":0.727,"pCI":[0.719,0.961],"rCI":[0.558,0.849]},"praise_multitask":{"basis":"seeded sample","tp":26,"fp":1,"fn":3,"precision":0.963,"recall":0.897,"pCI":[0.817,0.993],"rCI":[0.736,0.964]},"spam":{"basis":"seeded sample","tp":7,"fp":0,"fn":2,"precision":1,"recall":0.778,"pCI":[0.646,1],"rCI":[0.453,0.937]}};
const QUESTION = [/[?؟]/u, R(String.raw`^\s*(?:(?:what|when|where|how|why|which) (?:is|are|do|does|did|can|will|would|should|much (?:is|does|for)|many)|(?:can|could|is|are|does|do|will|would) (?:i|you|it|we|they|this|the|there))\b`), R('^\\s*(?:متى|وين|كيف|ليش|ليه|هل|ايش|شو|إيش)\\b')];

// caption → product, labelled "mapped from caption text"
const PRODUCTS = [
  ['Galaxy Z Fold8 Ultra', /fold\s?8\s?ultra/i], ['Galaxy Z Fold8', /fold\s?8|فولد\s?8/i], ['Galaxy Z Flip8', /flip\s?8|فليب\s?8/i],
  ['Galaxy S26 Ultra', /s26\s?ultra/i], ['Galaxy S26 FE', /s26\s?fe/i], ['Galaxy S26', /\bs26\b/i], ['Galaxy Watch9', /watch\s?9/i],
  ['Galaxy Buds4 Pro', /buds\s?4/i], ['Galaxy Tab S12', /tab\s?s12/i], ['TV / appliances', /\b(?:oled|neo qled|the frame|bespoke|tv)\b/i],
];
const productOf = (caption) => { const c = String(caption || ''); const hit = PRODUCTS.find(([, re]) => re.test(c)); return hit ? hit[0] : null; };
// a device named in the comment itself wins over the post's: complaints about an S23 arrive under Fold8 posts
const MODEL_IN_TEXT = /\b(?:galaxy\s?)?(?:(?:z\s?)?(?:fold|flip)\s?\d{1,2}(?:\s?ultra)?\b|[sam]\d{2}(?:\+|\s?(?:ultra|fe|plus)\b|\b)|note\s?\d{1,2}(?:\s?ultra)?\b|tab\s?s\d{1,2}\b|watch\s?\d{1,2}\b|buds\s?\d\b)/i;
// one name per device however it is typed: "z fold 8 ultra", "ZFold8Ultra" → "Galaxy Z Fold8 Ultra"; "s25ultra" → "Galaxy S25 Ultra"
function canonicalModel(raw) {
  const s = String(raw).toLowerCase().replace(/galaxy/g, '').replace(/\s+/g, '');
  let m;
  if ((m = s.match(/^z?(fold|flip)(\d{1,2})(ultra)?$/))) return `Galaxy Z ${m[1] === 'fold' ? 'Fold' : 'Flip'}${m[2]}${m[3] ? ' Ultra' : ''}`;
  if ((m = s.match(/^([sam])(\d{2})(ultra|fe|plus|\+)?$/))) return `Galaxy ${m[1].toUpperCase()}${m[2]}${m[3] ? ({ ultra: ' Ultra', fe: ' FE', plus: '+', '+': '+' })[m[3]] : ''}`;
  if ((m = s.match(/^(note|watch|buds)(\d{1,2})(ultra)?$/))) return `Galaxy ${m[1][0].toUpperCase() + m[1].slice(1)}${m[2]}${m[3] ? ' Ultra' : ''}`;
  if ((m = s.match(/^tabs(\d{1,2})$/))) return `Galaxy Tab S${m[1]}`;
  return raw.trim();
}
function productFor(text, caption) {
  const m = String(text || '').match(MODEL_IN_TEXT);
  if (m) return { product: canonicalModel(m[0]), productFrom: 'comment' };
  const c = productOf(caption);
  return c ? { product: c, productFrom: 'post caption' } : { product: 'product unknown', productFrom: null };
}
// the brand's own reply accounts: Instagram/TikTok/X "samsunggulf", the Facebook page replies as "Samsung"
const norm = (a) => String(a || '').trim().toLowerCase().replace(/^@/, '').replace(/\s+/g, '');
const OWNED = new Set(String(process.env.MAISTRO_BRAND_AUTHORS || 'samsunggulf,samsung').split(',').map(norm).filter(Boolean));
const isBrand = (author) => OWNED.has(norm(author));
const strip = (t) => String(t || '').replace(/https?:\/\/\S+/g, ' ');

/** themes of one comment's text (ids) and whether it is a question */
function classify(text) {
  const t = strip(text);
  let ids = THEMES.filter((th) => th.re.some((re) => re.test(t))).map((th) => th.id);
  if (ids.includes('spam')) ids = ['spam']; // a spam wall of words ("… SUES, EXTORTIONS …") is not a complaint
  const question = QUESTION.some((re) => re.test(t));
  return { ids, question };
}

function seeded(seed) { let h = 2166136261; for (const ch of String(seed)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619); return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** posts: /api/track posts (deduped comments). Returns counts, sentiment mix (tracker-analysed only), products
 *  for issues and complaints, examples (top 3 by likes + 3 seeded random), coverage. */
function themes(posts, { seed = '', examples = 3 } = {}) {
  const rnd = seeded(seed);
  const byId = Object.fromEntries(THEMES.map((th) => [th.id, { id: th.id, group: th.group, label: th.label, n: 0, questions: 0, sentiment: { pos: 0, neu: 0, neg: 0, notAnalysed: 0 }, products: {}, items: [] }]));
  const extra = { giveaway_entry: { id: 'giveaway_entry', group: 'giveaway', label: 'Giveaway entries', n: 0, questions: 0, sentiment: { pos: 0, neu: 0, neg: 0, notAnalysed: 0 }, products: {}, items: [] }, other_question: { id: 'other_question', group: 'question', label: 'Other questions', n: 0, questions: 0, sentiment: { pos: 0, neu: 0, neg: 0, notAnalysed: 0 }, products: {}, items: [] } };
  let total = 0, themed = 0, brandReplies = 0;
  for (const p of posts) {
    const gw = isGiveawayCaption(p.caption);
    for (const c of p.comments || []) {
      // the brand's own replies (offers, raffle notices) are not customer comments
      if (isBrand(c.author)) { brandReplies++; continue; }
      total++;
      const { product, productFrom } = productFor(c.text, p.caption);
      const { ids, question } = classify(c.text);
      // praise words inside a complaint or an issue report ("pink lines") are not praise
      const negative = ids.some((id) => byId[id].group === 'product_issue' || byId[id].group === 'complaint');
      const keep = ids.filter((id) => !((gw || negative) && byId[id].group === 'praise'));
      const hits = keep.map((id) => byId[id]);
      if (gw && !hits.some((h) => h.group !== 'praise')) hits.push(extra.giveaway_entry);
      if (question && !hits.length) hits.push(extra.other_question);
      if (hits.length && !(hits.length === 1 && hits[0] === extra.other_question)) themed++;
      for (const h of hits) {
        h.n++; if (question) h.questions++;
        const s = c.sentiment === 'pos' || c.sentiment === 'neu' || c.sentiment === 'neg' ? c.sentiment : 'notAnalysed';
        h.sentiment[s]++;
        if (h.group === 'product_issue' || h.group === 'complaint' || h.group === 'purchase') h.products[product] = (h.products[product] || 0) + 1;
        h.items.push({ postId: p.postId, platform: p.platform, author: c.author || null, text: c.text || '', at: c.at || null, likes: c.likes ?? null, sentiment: c.sentiment || null, product, productFrom, question });
      }
    }
  }
  const out = [...Object.values(byId), ...Object.values(extra)].map((h) => {
    const top = h.items.slice().sort((a, b) => (b.likes || 0) - (a.likes || 0)).slice(0, examples);
    const rest = h.items.filter((x) => !top.includes(x));
    for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
    const prodTot = Object.values(h.products).reduce((a, b) => a + b, 0);
    const products = Object.entries(h.products).sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n, ...(prodTot >= MIN_N ? { share: Math.round((n / prodTot) * 1000) / 1000 } : {}) }));
    // confidence from the measured audit: precision < 0.8 → low; complaints / issues with recall < 0.7 → may be
    // undercounted (a missed complaint is the costly error); fewer than 5 matched in the audit → not measured enough
    const a = AUDIT[h.id];
    const confidence = !a ? null : (a.tp + a.fp < 5 ? 'not enough audited examples' : a.precision < 0.8 ? 'low' : 'ok');
    const undercounted = Boolean(a && (h.group === 'product_issue' || h.group === 'complaint') && a.recall != null && a.recall < 0.7);
    return { id: h.id, group: h.group, label: h.label, n: h.n, confidence, ...(a ? { audit: { precision: a.precision, recall: a.recall, basis: a.basis } } : {}), ...(undercounted ? { mayBeUndercounted: true } : {}), share: total ? Math.round((h.n / total) * 1000) / 1000 : null, questions: h.questions, sentiment: h.sentiment, products, productsMappedFrom: 'a device named in the comment, else the post caption', examples: [...top, ...rest.slice(0, examples)] };
  }).sort((a, b) => b.n - a.n);
  return { version: THEMES_VERSION, total, themed, unthemed: total - themed, unthemedShare: total ? Math.round(((total - themed) / total) * 1000) / 1000 : null, minN: MIN_N, brandRepliesExcluded: brandReplies, themes: out };
}

module.exports = { themes, classify, productOf, productFor, THEMES, THEMES_VERSION, AUDIT };
