// One-time cold-start backfill (TREND_FRAMEWORK.md §3.4b): every distinct
// board in Trend Radar's git history becomes trend_snapshots rows (source
// "TrendRadar git history", fetched_at = the board's generatedAt), so first-
// seen, days-on-board, velocity and acceleration have history on day one.
//
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/backfill-trend-history.mjs \
//     --repo "D:/Trend Radar/samsungtrend" [--since 2026-09-15] [--dry]
//
// Idempotent: a board whose generatedAt already has rows is skipped.
// Reads git only; never touches Trend Radar's deployment or kymah.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeAgent } = require('../api/_handlers/trends.js');

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : [])).filter(Boolean));
const repo = args.repo || 'D:/Trend Radar/samsungtrend';
const since = args.since || '2026-09-15';
const dry = Boolean(args.dry);
const FILE = 'apps/web/app/lib/trends.generated.json';
const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!dry && (!base || !key)) { console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (or --dry)'); process.exit(1); }
const H = { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' };

const git = (a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const shas = git(['log', '--format=%h', `--since=${since}`, '--', FILE]).split('\n').filter(Boolean);
const boards = new Map();
for (const sha of shas) {
  let d; try { d = JSON.parse(git(['show', `${sha}:${FILE}`])); } catch { continue; }
  const at = d.generatedAt; if (!at || boards.has(at)) continue;
  boards.set(at, d.trends || []);
}
console.log(`commits ${shas.length}, distinct boards ${boards.size}`);

// The raw published file carries `thumbs`, the agent projection `clips`;
// normalizeAgent reads fit/sound/growth/eng/viewsWk/durabilityClass the same way.
const rowOf = (t, at) => {
  const n = normalizeAgent({ ...t, clips: t.clips || [] });
  if (!n.name || !(n.trendId || n.id)) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  return {
    fetched_at: at, board_generated_at: at, source: 'TrendRadar git history', trend_id: String(n.trendId || n.id), name: n.name.slice(0, 300),
    stage: n.status || null, kind: t.kind || null, category: n.category || null, growth_pct_per_day: num(n.momentumPerDay), eng: num(n.avgEngagementPct),
    views_wk: num(n.viewsPerWeek) == null ? null : Math.round(n.viewsPerWeek), fit_strength: n.samsungFit && num(n.samsungFit.score) != null ? Math.round(n.samsungFit.score) : null,
    on_brand: typeof n.onBrand === 'boolean' ? n.onBrand : null, signal_strength: num(n.signalStrength) == null ? null : Math.round(n.signalStrength),
    durability: n.stayingPower || null, sound_music_id: n.sound && n.sound.musicId ? String(n.sound.musicId) : null,
    sound_cleared: n.sound && typeof n.sound.cleared === 'boolean' && n.sound.clearedCheckedAt ? n.sound.cleared : null,
    raw: { ...n, backfilled: true },
  };
};

let written = 0, skipped = 0;
for (const [at, trends] of [...boards.entries()].sort()) {
  if (!dry) {
    const r = await fetch(`${base}/rest/v1/trend_snapshots?select=id&board_generated_at=eq.${encodeURIComponent(at)}&limit=1`, { headers: H });
    const existing = await r.json();
    if (Array.isArray(existing) && existing.length) { skipped++; continue; }
  }
  const rows = trends.map((t) => rowOf(t, at)).filter(Boolean);
  if (dry) { console.log(at, rows.length, 'rows'); written += rows.length; continue; }
  const ins = await fetch(`${base}/rest/v1/trend_snapshots`, { method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(rows) });
  if (!ins.ok) { console.error(`insert failed for board ${at}: ${ins.status} ${(await ins.text()).slice(0, 200)}`); process.exit(2); }
  written += rows.length;
  console.log(at, rows.length, 'rows');
}
console.log(`done: ${written} rows written, ${skipped} boards already present${dry ? ' (dry run)' : ''}`);
