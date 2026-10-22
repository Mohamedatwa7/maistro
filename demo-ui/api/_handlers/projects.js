// GET /api/projects — aggregated view of every campaign the external Hermes
// agent has pushed via /api/ingest. The Maistro website polls this and renders
// each campaign's stages as they arrive.

const { listEvents } = require('../_supabase.js');
const { requireSession, bearerMatches } = require('../_auth.js');

const STAGE_ORDER = ['mood', 'thumb', 'brief', 'board', 'final', 'qc'];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  // Phase 11 (F-B): campaign content is for signed-in users only; it was open to anyone with CORS *
  // an outside reader (none today) uses the ingest key, like /api/sentiment
  if (!bearerMatches((req.headers || {}).authorization, process.env.MAISTRO_INGEST_KEY) && !requireSession(req, res)) return;
  try {
    // newest first — "latest event per stage wins" is a simple first-write
    const events = await listEvents(1000);

    const byProject = new Map();
    for (const ev of events) {
      if (!byProject.has(ev.project_id)) byProject.set(ev.project_id, {});
      const slot = byProject.get(ev.project_id);
      if (!slot[ev.stage]) slot[ev.stage] = ev;
    }

    const projects = [];
    for (const [id, stages] of byProject) {
      const plan = stages.plan;
      if (!plan) continue; // a campaign without a plan can't be rendered
      const a = plan.artifact;
      // stage pointer = the furthest stage with an artifact (UI renders <= stage)
      let stageNum = 1;
      STAGE_ORDER.forEach((s, i) => { if (stages[s]) stageNum = Math.min(i + 1, 6); });
      if (stages.qc) stageNum = 6;

      const project = {
        id,
        external: true,
        title: a.title,
        product: a.product,
        markets: a.markets,
        platforms: a.platforms,
        th: a.th,
        map: { product: a.product, msg: a.msg, angle: a.angle || '' },
        trend: (plan.trend && plan.trend.name) || a.title,
        trendId: (plan.trend && plan.trend.id) || null,
        stage: stageNum,
        pushedAt: plan.at,
        agents: {},
      };
      for (const s of STAGE_ORDER) {
        if (stages[s]) {
          project[s] = stages[s].artifact;
          project.agents[s] = { agent: stages[s].agent, at: stages[s].at };
        }
      }
      projects.push(project);
    }
    projects.sort((x, y) => new Date(y.pushedAt) - new Date(x.pushedAt));

    res.status(200).json({ count: projects.length, projects });
  } catch (err) {
    res.status(502).json({ error: String((err && err.message) || err) });
  }
};
