// Smoke test: eval the page script with DOM stubs, render key pages.
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
const m = html.match(/<script>([\s\S]*)<\/script>/);
if (!m) { console.error('FAIL: no script block'); process.exit(1); }

const noop = () => {};
const ctxStub = new Proxy({}, { get: (t, k) => {
  if (k === 'canvas') return { width: 1200, height: 800 };
  return noop;
}, set: () => true });
const elStub = () => ({
  classList: { add: noop, remove: noop, toggle: noop, contains: () => true },
  addEventListener: noop, appendChild: noop, style: {}, dataset: {},
  getContext: () => ctxStub, innerHTML: '', textContent: '', value: '',
  width: 0, height: 0, clientWidth: 1200, clientHeight: 800,
  querySelectorAll: () => [], querySelector: () => null, focus: noop,
  getBoundingClientRect: () => ({ width: 1200, height: 800 }),
  parentElement: { getBoundingClientRect: () => ({ width: 1200, height: 800 }), clientHeight: 800 },
});
global.document = {
  querySelector: () => elStub(), querySelectorAll: () => [],
  getElementById: () => null, createElement: elStub,
  addEventListener: noop, body: { classList: { add: noop, remove: noop, toggle: noop, contains: () => true } },
  head: { appendChild: noop },
};
global.window = global;
global.location = { hash: '', href: '' };
global.history = { replaceState: noop };
global.addEventListener = noop;
global.removeEventListener = noop;
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = noop;
global.Image = class { constructor(){ this.complete = false; } addEventListener(){} };
global.IntersectionObserver = class { observe(){} unobserve(){} disconnect(){} };
global.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
global.fetch = () => new Promise(() => {});
global.innerHeight = 800; global.scrollY = 0;
global.scrollTo = noop; global.setInterval = () => 0; global.clearInterval = noop;

try {
  eval(m[1] + "\n;global.__x={CAL,rHome,rCalendar,rTrends,rStudio,rPerformance,startAscii,rCopilot,cpAction,cpSend,cpFromTrend,BOT,STATE,TRENDS,PROJECTS,DELIVS,STAGES,SENTI,cpPayloadFromText,genBox,stageArtifact,delivTitle,GEN,ssGone:typeof startSlideshow==='undefined'&&typeof SS_SLIDES==='undefined'};");
} catch (e) { console.error('FAIL eval:', e.message); process.exit(1); }
const X = global.__x;

let fails = 0;
const check = (name, cond) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + name); if (!cond) fails++; };

// Landing
const home = X.rHome();
check('rHome renders ascii canvas', home.includes('al-cv'));
check('rHome wordmark matches site logo (gold Ai)', home.includes('M<span class="ai">Ai</span>STRO'));
check('rHome has enter link', home.includes('#/trends'));
check('startAscii defined', typeof X.startAscii === 'function');
check('slideshow removed', X.ssGone);

// Calendar (8b, ADR-008): manual mode, no simulated events, no claimed Sprinklr connection
check('simulated calendar retired', X.CAL.length === 0);
const cal = X.rCalendar();
check('rCalendar states manual mode', /NOT CONNECTED — MANUAL MODE|not connected — manual mode/i.test(cal));
check('rCalendar claims no Sprinklr connection', !/SPRINKLR API · CONNECTED|Post now via Sprinklr|Publish via Sprinklr/.test(cal));

// Other routes still render
check('rTrends renders', typeof X.rTrends() === 'string');
check('rPerformance renders', typeof X.rPerformance() === 'string');

// samsungtrack-enriched performance
X.SENTI.posts.push({postId:'p1',platform:'tiktok',account:'@SamsungGulf',caption:'Galaxy Z Flip8 camera test with Galaxy AI',
 postedAt:new Date().toISOString(),metrics:{views:1000,likes:50,comments:2,er:0.05},
 comments:[{author:'@a',text:'I want a refund, this is not working',sentiment:'neg',likes:1},
           {author:'@b',text:'love the camera',sentiment:'pos',likes:3}]});
// the page is four tabs over one filter bar (2026-10-26 redesign): render each
const tabHtml = (t) => { X.STATE.pfTab = t; return X.rPerformance(); };
const perf = tabHtml('overview');
check('performance has a filter bar and four tabs', ['All platforms','ALL PRODUCTS','Search posts','24h','60 days'].every(x=>perf.includes(x)) && ['Overview','Comments','Posts','Insights'].every(x=>perf.includes(`pfTab('${x.toLowerCase()}')`)));
check('overview KPI row', perf.includes('Total positive rate') && perf.includes('Median engagement') && perf.includes('Total views'));
check('overview: week-on-week trend', perf.includes('week on week'));
check('overview: critical alerts', perf.includes('Critical alerts') && perf.includes('TO HANDLE') && perf.includes('REFUND REQUEST'));
check('overview: top posts + topics', perf.includes('Top posts') && perf.includes('What people are talking about'));
check('KPIs are clickable drills', perf.includes("kpiDrill('posrate')") && perf.includes("kpiDrill('posts')"));
const cm = tabHtml('comments');
check('comments tab: chips, flags, post context', cm.includes('Needs attention') && cm.includes('Not analysed') && cm.includes('TECHNICAL ISSUE') && cm.includes('on: Galaxy Z Flip8'));
const po = tabHtml('posts');
check('posts tab: dept badge, folded comments, feature + sort', po.includes('MX · GALAXY Z FLIP') && po.includes('Show comments') && po.includes('ALL FEATURES') && po.includes('SORT ·') && !po.includes('love the camera'));
const ins = tabHtml('insights');
check('insights tab: decisions, products, foldables', ins.includes('data-decisions') && ins.includes('comments by model') && ins.includes('GALAXY Z FLIP') && ins.includes('Fold8 vs Flip8'));
X.SENTI.posts.push({postId:'p2',platform:'instagram',account:'@samsunggulf',caption:'جهاز رائع',
 postedAt:new Date().toISOString(),metrics:{views:10,er:0.1},
 comments:[{author:'@ar',text:'أحب هذا الهاتف كثيرا',sentiment:'pos',likes:9}]});
const perf2 = tabHtml('comments');
check('arabic comments get translate button', perf2.includes('🌐 TRANSLATE') && perf2.includes('trDo('));
X.STATE.pfTab = 'overview';
X.SENTI.posts.length = 0;

// Studio — two pathways + copilot
const st = X.rStudio();
check('studio pathway 01 (Hermes)', st.includes('Pathway 01') && st.includes('/api/ingest'));
check('studio pathway 02 (Studio Copilot)', st.includes('Pathway 02') && st.includes('cpOpen()'));
check('studio mentions Seedance', st.includes('Seedance'));
check('copilot panel rendered', st.includes('id="copilot"') && st.includes('cp-in-field'));
check('no old placeholder campaigns', X.PROJECTS.length === 0 && X.DELIVS.length === 0);

// Copilot flow (greet + custom payload shape)
X.STATE.copilot = true;
const payload = X.cpPayloadFromText('Galaxy Watch8 Ramadan wellness series');
check('custom payload has name/desc', payload.name.includes('Watch8') && payload.desc.includes('wellness'));
check('BOT starts at concept step', X.BOT.step === 'concept');

// Trend card → copilot: ask-first flow
check('trend card has copilot button', html.includes("cpFromTrend('${t.id}')"));
X.TRENDS.push({ id: 't-test', name: 'Test Trend', type: 'format', markets: ['UAE'], platform: 'tiktok', vel: 12, status: 'rising', desc: 'a test', clips: [] });
X.cpFromTrend('t-test');
check('cpFromTrend seeds direction step', X.BOT.step === 'direction');
check('cpFromTrend stores trend payload', X.BOT.pendingPayload && X.BOT.pendingPayload.name === 'Test Trend');
check('cpFromTrend opens copilot', X.STATE.copilot === true);
check('direction offers plan-for-me chip', X.BOT.chips.some(c => c.a === 'plango'));
check('draft campaign appears instantly', X.PROJECTS[0] && X.PROJECTS[0].planning === true);
const draftStudio = X.rStudio();
check('draft shows full stage pipeline', draftStudio.includes('Moodboard') && draftStudio.includes('Quality Check') && draftStudio.includes('Storyboard'));
check('draft box has in-place plan form', draftStudio.includes('Set the campaign plan first') && draftStudio.includes("planNow('"));
check('plan form has plain-words input', draftStudio.includes('plan-in'));

// Generate-in-place pipeline for a studio campaign
const sp = { id: 'gen-test', generated: true, studio: true, stage: 1, title: 'Test Campaign',
  trend: 'Test Trend', product: 'Galaxy S26 Ultra', markets: ['UAE'], platforms: ['tiktok'],
  th: ['#111111', '#333333'], src: X.cpPayloadFromText('test'), map: { product: 'Galaxy S26 Ultra', msg: 'msg', angle: 'angle' } };
X.PROJECTS.unshift(sp); X.STATE.proj = 'gen-test';
const moodPanel = X.stageArtifact(sp, 1);
check('empty mood stage shows generate box', moodPanel.includes('genbox') && moodPanel.includes("stageGen('gen-test','mood')"));
check('gen box mentions AI Creative Director', moodPanel.includes('AI Creative Director'));
const draftPanel = X.stageArtifact(sp, 5);
check('stage 5 is First Draft with format selects', draftPanel.includes('gen-ar-draft') && draftPanel.includes('First Draft'));
const finalLocked = X.stageArtifact(sp, 7);
check('Final Content locked before QC', finalLocked.includes('Unlocks after the Quality Check'));
sp.draft = { version: 'v1', dur: '5s', audio: 'x', variants: [{ a: '16:9', l: '720p', k: 'seedance', st: 'ready' }], videoUrl: 'https://x/d.mp4', prompt: 'draft prompt', note: 'n' };
sp.qc = { real: true, avg: 6.8, runs: { draft: { score: 6.8, funnel_stage: 'upper', kpis: {}, verdict: { summary: 'ok',
  strengths: [], risks: [{ rank: 1, issue: 'Hook lands late', suggested_fix: 'Open on the punchline setup', confidence: 'high' }],
  revision_brief: { objective: 'Front-load the hook' } } } } };
const finalReady = X.stageArtifact(sp, 7);
check('Final Content shows F1X8 fixes to implement', finalReady.includes('Implement F1X8') && finalReady.includes('Hook lands late') && finalReady.includes('Front-load the hook'));
check('Final Content has render button', finalReady.includes("stageGen('gen-test','final')"));
delete sp.qc; delete sp.draft;
sp.mood = { imageUrl: 'https://x/m.png', prompt: 'a board', note: 'warm golds' };
const moodDone = X.stageArtifact(sp, 1);
check('generated image fills the placeholder', moodDone.includes('https://x/m.png') && moodDone.includes('gen-media'));
check('director note shown under image', moodDone.includes('warm golds'));
check('delivTitle handles generated mood', X.delivTitle('mood', sp.mood).includes('generated'));
sp.board = { imageUrl: 'https://x/b.png', prompt: 'sheet', note: 'six panels' };
check('delivTitle handles generated board', X.delivTitle('board', sp.board).includes('6-panel'));
const thumbPanel = X.stageArtifact(sp, 2);
check('thumb gen box hints continuity', thumbPanel.includes('already made'));

// Regen chat under generated pieces + ref photo control
const moodDone2 = X.stageArtifact(sp, 1);
check('regen chat under generated mood', moodDone2.includes("stageRegen('gen-test','mood')") && moodDone2.includes('Regenerate'));
const studioHtml = X.rStudio();
check('product photo control in header', studioHtml.includes('ADD REAL PRODUCT PHOTOS') && studioHtml.includes("refUpload('gen-test'"));
check('upload accepts multiple files', studioHtml.includes('multiple'));
sp.refImages = ['https://x/closed.jpg', 'https://x/open.jpg'];
sp.refImage = 'https://x/open.jpg';
const studioHtml2 = X.rStudio();
check('photo library renders thumbnails', studioHtml2.includes('https://x/closed.jpg') && studioHtml2.includes('https://x/open.jpg'));
check('active photo highlighted + selectable', studioHtml2.includes("refSelect('gen-test',0)") && studioHtml2.includes('GOLD = USED ON THUMBNAIL'));
check('photos removable', studioHtml2.includes("refRemove('gen-test',1)"));
delete sp.refImage; delete sp.refImages;

// F1X8 QC console
const qcEmpty = X.stageArtifact(sp, 6);
check('qc console offers full F1X8 run', qcEmpty.includes('Run the full F1X8 check') && qcEmpty.includes("qcRunAll('gen-test')"));
check('qc console lists available assets', qcEmpty.includes('Moodboard') && qcEmpty.includes('Storyboard'));
sp.qc = { real: true, avg: 7.3, runs: { thumb: { score: 7.3, funnel_stage: 'upper', product_tier: 'premium',
  context_score: 8.1, kpis: { attention_capture: { score: 7.5, label: 'strong', methodology: 'CV blend' } },
  verdict: { summary: 'Solid hook.', strengths: ['Clean hierarchy'], risks: [{ rank: 1, issue: 'CTA weak', suggested_fix: 'Bigger title space', confidence: 'high' }],
  revision_brief: { objective: 'Sharpen the punchline' } } } } };
const qcDone = X.stageArtifact(sp, 6);
check('qc report renders real score', qcDone.includes('7.3') && qcDone.includes('REAL ANALYSIS'));
check('qc report renders KPIs + risks + revision brief', qcDone.includes('ATTENTION CAPTURE') && qcDone.includes('CTA weak') && qcDone.includes('Sharpen the punchline'));
check('qc report shows brief fit', qcDone.includes('BRIEF FIT 8.1/10'));
check('delivTitle handles real qc', X.delivTitle('qc', sp.qc).includes('real analysis'));
X.PROJECTS.shift(); X.STATE.proj = null;

process.exit(fails ? 1 : 0);
