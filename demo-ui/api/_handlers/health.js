// GET /api/health — which integrations are configured (names only, never
// values) and the running revision, so a deploy can be checked without
// touching paid upstreams. Probing the upstreams is milestone M3's job once
// the adapters exist. Lives in the dispatcher (Hobby plan function cap).
const REQUIRED = [
  'ANTHROPIC_API_KEY', 'HF_CREDENTIALS', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
  'TRACK_SUPABASE_URL', 'TRACK_SUPABASE_KEY', 'MAISTRO_INGEST_KEY', 'CRON_SECRET',
  'MAISTRO_SESSION_SECRET', 'MAISTRO_APP_PASSWORD',
  'MAISTRO_DATABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });
  const configured = {};
  for (const name of REQUIRED) configured[name] = Boolean(process.env[name]);
  const missing = REQUIRED.filter((n) => !configured[n]);
  // Optional switches that change behaviour (names only): bootstrap admins
  // for first sign-in, and whether decisions still accept password sessions.
  const features = { MAISTRO_ADMIN_EMAILS: Boolean(process.env.MAISTRO_ADMIN_EMAILS), MAISTRO_REQUIRE_MEMBER: process.env.MAISTRO_REQUIRE_MEMBER === '1', MAISTRO_APP_PASSWORD: Boolean(process.env.MAISTRO_APP_PASSWORD) };
  // Phase 12 O4: one status per monitored integration from the open alerts (names and ok/alert only, no details)
  let integrations = null;
  if (configured.SUPABASE_URL && configured.SUPABASE_SERVICE_ROLE_KEY) {
    try {
      const { CHECKS } = require('../_ops/monitor.js');
      const open = await require('../_supabase.js').queryRows('ops_alerts', 'select=kind&resolved_at=is.null&limit=200');
      const bad = new Set(open.map((x) => x.kind));
      integrations = Object.fromEntries(Object.keys(CHECKS).map((k) => [k, bad.has(k) ? 'alert' : 'ok']));
    } catch (e) { integrations = { unavailable: true }; }
  }
  return res.status(missing.length ? 503 : 200).json({
    ok: missing.length === 0,
    // CLI deploys carry no git metadata: the release gate passes MAISTRO_REVISION (the SHA CI tested) as a deployment env
    revision: (process.env.VERCEL_GIT_COMMIT_SHA || process.env.MAISTRO_REVISION || '').slice(0, 7) || null,
    environment: process.env.VERCEL_ENV || 'local',
    // Phase 12 O3: a Preview deployment should use its own Supabase project; until the owner points Preview at one
    // and sets MAISTRO_PREVIEW_DB=1 in the Preview scope, this says previews read and write production data
    dataIsolation: process.env.VERCEL_ENV === 'preview' && process.env.MAISTRO_PREVIEW_DB !== '1' ? 'preview uses the production database' : 'ok',
    configured,
    missing,
    features,
    integrations,
    tools: { ffmpeg: (() => { try { const f = require('ffmpeg-static'); return Boolean(f && require('node:fs').existsSync(f)); } catch (e) { return false; } })() }, checkedAt: new Date().toISOString(),
  });
};
