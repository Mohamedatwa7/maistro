// Samsung brand knowledge shared by the generation endpoints.
// Source: Samsung Brand Creative Playbook, Global Brand Center, Apr 2026
// (D:\MAISTRO\docs\brand-playbook.pdf) + the current 2026 product lineup.
// Fed to /api/hermes (campaign planning) and /api/director (prompt crafting)
// so generated content only ever features CURRENT products and stays on-brand.

const PRODUCT_CATALOG = [
  // Mobile
  { name: 'Galaxy S26 Ultra', look: '2026 flagship bar phone, titanium frame, boxy flat edges, large camera array' },
  { name: 'Galaxy S26', look: '2026 flagship bar phone, slim flat-edged design' },
  { name: 'Galaxy Z Fold8', look: '2026 book-style foldable, opens into a tablet, near-invisible crease, ultra-thin' },
  { name: 'Galaxy Z Flip8', look: '2026 clamshell flip foldable, large FlexWindow cover screen when closed' },
  { name: 'Galaxy A56 5G', look: 'mid-range 2026 bar phone, clean minimal design' },
  { name: 'Galaxy Tab S12', look: '2026 flagship tablet, large edge-to-edge display, S Pen included, 23h battery' },
  { name: 'Galaxy Watch9', look: '2026 smartwatch, cushion-round case, bright AMOLED face' },
  { name: 'Galaxy Ring', look: 'slim titanium smart ring for sleep and health tracking' },
  { name: 'Galaxy Buds4 Pro', look: 'blade-stem wireless earbuds with LED blade lights, pebble case, studio-grade ANC' },
  // TV / AV
  { name: 'Neo QLED 8K', look: 'near-bezel-less flagship 8K TV, Infinity Air design' },
  { name: 'OLED S95F', look: 'flagship OLED TV, glare-free matte screen, razor-thin' },
  { name: 'The Frame', look: 'TV that hangs flat like framed artwork with matte art display and bezel options' },
  { name: 'Music Frame', look: 'wireless speaker shaped like a small picture frame' },
  // Appliances
  { name: 'Bespoke AI Fridge', look: 'minimal flat-panel refrigerator with AI Family Hub touchscreen' },
  { name: 'Bespoke AI Oven', look: 'built-in smart oven with internal camera and display' },
  { name: 'Bespoke AI Laundry Combo', look: 'all-in-one washer-dryer with large round door and AI display dial' },
  { name: 'Jet Bot Combo AI', look: 'white premium robot vacuum-mop with AI object recognition' },
  { name: 'Bespoke Jet AI', look: 'premium cordless stick vacuum with all-in-one clean station' },
  // Computing / monitors
  { name: 'Galaxy Book5 Pro', look: 'thin premium laptop, AMOLED touchscreen' },
  { name: 'Odyssey OLED G9', look: 'super-ultrawide curved gaming monitor' },
];

const PRODUCTS_PROMPT =
  'CURRENT SAMSUNG PRODUCT CATALOG (2026) — campaigns may ONLY feature these, exactly by these names:\n' +
  PRODUCT_CATALOG.map((p) => `- ${p.name}: ${p.look}`).join('\n') +
  '\nNEVER use discontinued or older generations (no Galaxy Z Flip7/Fold7 or earlier, no S25 or earlier, ' +
  'no Watch8 or earlier, no Buds3 or earlier, no Tab S11 or earlier). If an older product is mentioned ' +
  'anywhere upstream, silently upgrade it to its current 2026 equivalent from this catalog ' +
  '(e.g. "Flip 7" → "Galaxy Z Flip8", "Watch8" → "Galaxy Watch9", "Buds3 Pro" → "Galaxy Buds4 Pro").';

const BRAND_PROMPT =
  'SAMSUNG BRAND CREATIVE PLAYBOOK (Global Brand Center, Apr 2026) — mandatory for all creative:\n' +
  'PERSONA: the Confident Explorer — Open, Bold, Authentic (O.B.A.). Pick one leading principle per ' +
  'piece, support with the others.\n' +
  'CREATIVE ESSENCE — Refined Wit: unexpected in the everyday, re-seeing the familiar, a gentle wink, ' +
  'subtle confidence, rooted in real life. NEVER mechanical/cold, staged, loud, busy/dense, or cutesy.\n' +
  'COLOR SYSTEM (blue appears in every composition, used intentionally): White and Black dominate; ' +
  'Samsung Blue #1428A0 is the brand throughline; Confident Blue #020DCB is the digital hero blue; ' +
  'Harbor Blue #3C90EF and Morning Sky #EAF8FC add range. Secondary: Clay #A9989E, Stone #DADADA. ' +
  'Supporting: Porcelain #FCF8E6, Celadon #8AE1B8, Persimmon #FFC861, Bloom #F5BAEF. Rare accents: ' +
  'Rosey #FB44A0, Pulse #E91C2F, Sunlight #FCFC63. Gradients: 3-color = refined/product focus, ' +
  'multi-color = bold hero moments.\n' +
  'PRODUCT IMAGERY: the product speaks for itself — striking contrast, dynamic angles and crops when ' +
  'leading Bold; natural light, true-to-life scale and tactile texture when leading Authentic; visual ' +
  'simplicity, curiosity-sparking space when leading Open.\n' +
  'LIFESTYLE IMAGERY: playful but grounded, clever not flashy (Open); hyperreal, theatrical, ' +
  'exaggerated-with-intention (Bold); observational, unposed, candid everyday wink, natural light ' +
  '(Authentic). Always simple enough to read at a glance — never frenetic or cluttered.\n' +
  'VOICE (for any copy): conversational yet premium, say what we mean, personify the tech ' +
  '("this fridge talks back"), upend expectations with the ending, never put down competitors, ' +
  'never try too hard.';

module.exports = { PRODUCT_CATALOG, PRODUCTS_PROMPT, BRAND_PROMPT };
