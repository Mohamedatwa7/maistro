// POST /api/ingest — the inbound door for the external Hermes agent.
// Hermes pulls trends from GET /api/trends, generates each pipeline artifact
// itself, and pushes them here one by one. Each push is stored as an immutable
// event blob; GET /api/projects aggregates them for the Maistro website.
//
// Auth: Authorization: Bearer <MAISTRO_INGEST_KEY>
//
// Body: {
//   projectId?: string,   // omit on "plan" — one is created and returned
//   stage: "plan" | "mood" | "thumb" | "brief" | "board" | "final" | "qc",
//   agent?: string,       // e.g. "Muse" — defaults to the stage's agent
//   trend?: { id?, name? },  // recommended on "plan": which trend this campaign rides
//   artifact: { ... }     // stage-shaped payload, see API.md
// }

const { insertEvent, queryRows } = require('./_supabase.js');

// Idempotency (M1, AUDIT C-11): an agent that retries a push must not create
// a second event. Without a schema change the key is the content itself —
// if the latest stored event for (projectId, stage) carries an identical
// artifact, the push is acknowledged as a duplicate and nothing is written.
// (GET /api/projects already lets the NEWEST event per stage win, so a
// corrected re-push supersedes the old one; only exact repeats are folded.)
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const { bearerMatches } = require('./_auth.js');

const STAGE_AGENTS = {
  plan: 'Hermes', mood: 'Muse', thumb: 'Pixel', brief: 'Quill',
  board: 'Frame', final: 'Forge', qc: 'Sentinel',
};

// Minimal shape validation so a malformed push fails loudly at the door
// instead of breaking the website renderer later.
const REQUIRED_KEYS = {
  plan: ['title', 'product', 'msg', 'markets', 'platforms', 'th'],
  mood: ['note', 'tiles'],
  thumb: ['title', 'sub', 'g'],
  brief: ['objective', 'msg', 'markets', 'platforms', 'deadline', 'mandatories'],
  board: null, // artifact itself is the frames array
  final: ['version', 'dur', 'audio', 'variants'],
  qc: ['f1x8', 'f1x8Note', 'human', 'humanNote'],
};

function validate(stage, artifact) {
  if (stage === 'board') {
    if (!Array.isArray(artifact) || !artifact.length || !artifact[0].tc) {
      return 'board artifact must be a non-empty array of {tc, d, g:[hex,hex]} frames';
    }
    return null;
  }
  if (typeof artifact !== 'object' || artifact === null || Array.isArray(artifact)) {
    return `${stage} artifact must be an object`;
  }
  const missing = REQUIRED_KEYS[stage].filter((k) => artifact[k] == null);
  return missing.length ? `${stage} artifact is missing: ${missing.join(', ')}` : null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  const key = process.env.MAISTRO_INGEST_KEY;
  const auth = req.headers.authorization || '';
  if (!key) {
    res.status(503).json({ error: 'MAISTRO_INGEST_KEY is not configured on the server' });
    return;
  }
  if (!bearerMatches(auth, key)) {
    res.status(401).json({ error: 'missing or invalid Authorization bearer token' });
    return;
  }

  const { stage, artifact, trend, agent } = req.body || {};
  let { projectId } = req.body || {};

  if (!STAGE_AGENTS[stage]) {
    res.status(400).json({ error: `unknown stage "${stage}" — expected one of ${Object.keys(STAGE_AGENTS).join(', ')}` });
    return;
  }
  if (artifact == null) {
    res.status(400).json({ error: 'missing artifact' });
    return;
  }
  const invalid = validate(stage, artifact);
  if (invalid) {
    res.status(422).json({ error: invalid });
    return;
  }
  if (stage === 'plan' && !projectId) {
    projectId = 'ext-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  if (!projectId) {
    res.status(400).json({ error: 'missing projectId (returned by the "plan" push — send it with every later stage)' });
    return;
  }
  if (!/^[a-zA-Z0-9_-]{3,64}$/.test(projectId)) {
    res.status(400).json({ error: 'projectId must be 3-64 chars of [a-zA-Z0-9_-]' });
    return;
  }

  try {
    const agentName = agent || STAGE_AGENTS[stage];
    const latest = await queryRows('campaign_events',
      `select=agent,artifact,at&project_id=eq.${encodeURIComponent(projectId)}&stage=eq.${encodeURIComponent(stage)}&order=at.desc&limit=1`);
    if (latest.length && stable(latest[0].artifact) === stable(artifact)) {
      res.status(200).json({ ok: true, projectId, stage, agent: latest[0].agent || agentName, duplicate: true, at: latest[0].at });
      return;
    }
    await insertEvent({
      project_id: projectId,
      stage,
      agent: agentName,
      trend: trend || null,
      artifact,
    });
    res.status(200).json({ ok: true, projectId, stage, agent: agentName });
  } catch (err) {
    res.status(502).json({ error: String((err && err.message) || err) });
  }
};
