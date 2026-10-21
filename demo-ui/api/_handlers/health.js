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
  return res.status(missing.length ? 503 : 200).json({
    ok: missing.length === 0,
    revision: (process.env.VERCEL_GIT_COMMIT_SHA || '').slice(0, 7) || null,
    environment: process.env.VERCEL_ENV || 'local',
    configured,
    missing,
    features,
    checkedAt: new Date().toISOString(),
  });
};
