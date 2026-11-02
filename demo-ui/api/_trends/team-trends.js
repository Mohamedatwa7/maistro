// Team-added trends: formats the social team spotted themselves (mostly on
// Instagram, which TrendRadar does not scan). GET /api/trends returns them in
// `teamTrends`, separate from the TrendRadar board, so the board's counts,
// curation and filters (and the Hermes ingest contract) are unchanged. They
// carry no measured numbers (views, growth, fit score): none were measured,
// and none are invented here. To add one, append an entry and release.

const ig = (code, kind) => ({
  platform: 'instagram',
  code,
  kind,
  url: `https://www.instagram.com/${kind === 'reel' ? 'reel' : 'p'}/${code}/`,
  handle: null,
  views: null,
});

const RAW = [
  {
    name: 'Running Late / Horizontal GRWM',
    category: 'lifestyle',
    addedAt: '2026-11-02',
    mechanic: 'Female lifestyle trend: the frantic "running late" get-ready-with-me, filmed horizontally as a fast-cut sequence of getting ready and heading out the door.',
    tags: ['runninglate', 'grwm', 'lifestyle'],
    clips: [ig('DcgE1ewo6I5', 'reel'), ig('DcpdoapzrWF', 'reel'), ig('DblAD4Pspxl', 'reel')],
  },
  {
    name: 'Fridge POV',
    category: 'photography',
    addedAt: '2026-11-02',
    mechanic: 'Creative photography trend shot from inside the fridge: the camera sits on the shelf and captures the person opening the door.',
    tags: ['fridgepov', 'pov', 'creativephotography'],
    clips: [ig('De8uVfKMKp7', 'reel'), ig('DefGM8KRUb3', 'reel'), ig('Dez_9UQS9wl', 'post')],
  },
  {
    name: 'Things We Are Ghosting This October',
    category: 'seasonal',
    addedAt: '2026-11-02',
    mechanic: 'Halloween photo and video trend in a bedsheet ghost costume: a list of things you are "ghosting" (leaving behind) this October.',
    tags: ['ghosting', 'halloween', 'ghostcostume'],
    clips: [ig('DePQmmOgYWa', 'post'), ig('Dd9X7eqFS55', 'reel'), ig('DeCp99-Gl2T', 'post'), ig('Del4b4rD3ab', 'post'), ig('DeuMMQ_DMBl', 'post')],
  },
  {
    name: 'My Kind of Trick or Treating',
    category: 'seasonal',
    addedAt: '2026-11-02',
    mechanic: 'Halloween trend: a personal twist on trick or treating, showing your own version of the "treats" you go out for.',
    tags: ['trickortreat', 'halloween', 'mykindoftrickortreating'],
    clips: [ig('DfK83Rwx7NG', 'reel'), ig('De-8uuYBNfR', 'reel'), ig('DfIO_E6v_YA', 'reel')],
  },
];

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

// Same shape as a TrendRadar trend (normalize/normalizeAgent), plus
// team: true, platform and addedAt.
const TEAM_TRENDS = RAW.map((t) => ({
  id: 'team-' + slug(t.name),
  trendId: 'team-' + slug(t.name),
  name: t.name,
  status: 'new',
  region: 'Global',
  lang: null,
  category: t.category,
  samsungFit: { strength: null, score: null, ownableBeat: null, rationale: null, raw: null },
  momentumPerDay: null,
  viewsPerWeek: null,
  avgEngagementPct: null,
  stayingPower: null,
  mechanic: t.mechanic,
  why: null,
  tags: t.tags,
  sound: null,
  clips: t.clips,
  team: true,
  platform: 'instagram',
  addedAt: t.addedAt,
}));

module.exports = { TEAM_TRENDS };
