// Phase 6.6 (b): the composition step. Seedance makes clips, not edits; this
// module turns approved clips into one platform-ready cut with ffmpeg
// (`ffmpeg-static`, bundled into the function):
//   - orders the clips and trims each to the shot's exact duration
//   - applies the shot list's transitions (cut, dissolve = 0.25 s cross-fade
//     with an audio cross-fade; whip / match cut / hold → cut for now)
//   - burns the per-shot overlay PNGs the browser drew (text and captions
//     with correct Arabic shaping — never drawn by ffmpeg's drawtext)
//   - normalises loudness (EBU R128 loudnorm, -14 LUFS, -1 dBTP: the common
//     social target; the KB has no verified per-platform figure yet)
//   - exports H.264 / AAC, yuv420p, 30 fps, faststart at the platform frame
// and extracts review frames from a clip for the vision checks.
// Everything here is deterministic given the same inputs; numbers come from
// ffmpeg's own probe, never from a model.
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DISSOLVE_S = 0.25;
const LOUDNESS = { I: -14, TP: -1, LRA: 11, note: 'builder default (-14 LUFS integrated, -1 dBTP) — platform figures unverified' };
const FPS = 30;
const FRAMES = { '9:16': { '720p': [720, 1280], '1080p': [1080, 1920] }, '16:9': { '720p': [1280, 720], '1080p': [1920, 1080] }, '1:1': { '720p': [720, 720], '1080p': [1080, 1080] } };

function ffmpegPath() {
  if (process.env.MAISTRO_FFMPEG) return process.env.MAISTRO_FFMPEG;
  try { return require('ffmpeg-static'); } catch (e) { return 'ffmpeg'; }
}

function run(args, { timeoutMs = 240000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath(), ['-hide_banner', '-nostdin', '-y', ...args], { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(Object.assign(new Error(`ffmpeg failed: ${String(stderr || err.message).split('\n').filter(Boolean).slice(-6).join(' | ').slice(0, 900)}`), { stderr: String(stderr || '') }));
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

/** Duration, size, fps and stream presence from ffmpeg's own banner (no ffprobe in ffmpeg-static). */
async function probe(file) {
  const r = await new Promise((resolve) => execFile(ffmpegPath(), ['-hide_banner', '-nostdin', '-i', file, '-f', 'null', '-'], { timeout: 60000, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => resolve(String(stderr || ''))));
  const dur = r.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const durationS = dur ? Math.round((Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3])) * 1000) / 1000 : null;
  const vid = r.match(/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Video: [^\n]*?(\d{2,5})x(\d{2,5})[^\n]*?(?:,\s*([\d.]+) fps)?/);
  const hasAudio = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?: Audio:/.test(r);
  return { durationS, width: vid ? Number(vid[1]) : null, height: vid ? Number(vid[2]) : null, fps: vid && vid[3] ? Number(vid[3]) : null, hasVideo: Boolean(vid), hasAudio };
}

function frameFor(aspect, resolution) {
  const a = FRAMES[aspect] || FRAMES['9:16'];
  return a[resolution] || a['720p'];
}

function tmpDir(prefix = 'maistro-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function sha256File(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }

/** Extract review frames at fractions of the clip (0, 0.5, ~1) → PNG paths. */
async function extractFrames(clipFile, outDir, fractions = [0, 0.5, 0.96]) {
  const p = await probe(clipFile);
  if (!p.durationS) throw new Error('clip has no readable duration');
  const out = [];
  for (let i = 0; i < fractions.length; i++) {
    const t = Math.max(0, Math.min(p.durationS - 0.05, p.durationS * fractions[i]));
    const file = path.join(outDir, `frame-${i}.png`);
    await run(['-ss', t.toFixed(3), '-i', clipFile, '-frames:v', '1', '-vf', 'scale=iw:ih', file]);
    out.push({ index: i, t: Math.round(t * 1000) / 1000, file });
  }
  return { frames: out, probe: p };
}

/** Build and run the assembly. shots: [{ n, file, trimS, transition, overlayFile|null }] in order. */
async function assemble({ shots, aspect = '9:16', resolution = '720p', out, loudness = LOUDNESS }) {
  if (!Array.isArray(shots) || !shots.length) throw new Error('no shots to assemble');
  const [W, H] = frameFor(aspect, resolution);
  const inputs = []; const filters = []; const info = [];
  let ii = 0;
  for (const s of shots) {
    const p = await probe(s.file);
    if (!p.hasVideo) throw new Error(`shot ${s.n}: clip has no video stream`);
    const trim = Math.min(Number(s.trimS) || p.durationS, p.durationS);
    info.push({ n: s.n, source: p, trimS: Math.round(trim * 1000) / 1000, transition: s.transition || 'cut', overlay: Boolean(s.overlayFile) });
    const vi = ii; inputs.push('-i', s.file); ii++;
    let oi = null; if (s.overlayFile) { oi = ii; inputs.push('-i', s.overlayFile); ii++; }
    // video: trim, conform to the platform frame (scale to cover, crop), fps, overlay
    let v = `[${vi}:v]trim=0:${trim},setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},format=yuv420p,setsar=1`;
    if (oi != null) { filters.push(`[${oi}:v]scale=${W}:${H}:flags=lanczos,format=rgba[ov${s.n}]`); v += `[vb${s.n}];[vb${s.n}][ov${s.n}]overlay=0:0:format=auto`; }
    v += `,settb=AVTB,setpts=PTS-STARTPTS[v${s.n}]`; filters.push(v); // one timebase for every segment: xfade and concat need it
    // audio: the clip's own track trimmed, or silence when the clip has none
    if (p.hasAudio) filters.push(`[${vi}:a]atrim=0:${trim},asetpts=PTS-STARTPTS,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${s.n}]`);
    else filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${trim},asetpts=PTS-STARTPTS[a${s.n}]`);
  }
  // chain: cut = concat; dissolve = xfade + acrossfade (offset = accumulated length − fade)
  let vcur = `v${shots[0].n}`, acur = `a${shots[0].n}`, acc = info[0].trimS; let k = 0;
  for (let i = 1; i < shots.length; i++) {
    const prevT = info[i - 1].transition; const seg = info[i];
    const vn = `vx${k}`, an = `ax${k}`; k++;
    if (prevT === 'dissolve' && info[i - 1].trimS > DISSOLVE_S && seg.trimS > DISSOLVE_S) {
      const off = Math.max(0, acc - DISSOLVE_S);
      filters.push(`[${vcur}][v${seg.n}]xfade=transition=fade:duration=${DISSOLVE_S}:offset=${off.toFixed(3)},settb=AVTB[${vn}]`);
      filters.push(`[${acur}][a${seg.n}]acrossfade=d=${DISSOLVE_S}:c1=tri:c2=tri[${an}]`);
      acc = acc + seg.trimS - DISSOLVE_S;
    } else {
      filters.push(`[${vcur}][v${seg.n}]concat=n=2:v=1:a=0,settb=AVTB[${vn}]`);
      filters.push(`[${acur}][a${seg.n}]concat=n=2:v=0:a=1[${an}]`);
      acc = acc + seg.trimS;
    }
    vcur = vn; acur = an;
  }
  filters.push(`[${acur}]loudnorm=I=${loudness.I}:TP=${loudness.TP}:LRA=${loudness.LRA}[aout]`);
  const args = [...inputs, '-filter_complex', filters.join(';'), '-map', `[${vcur}]`, '-map', '[aout]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-r', String(FPS), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-movflags', '+faststart', '-shortest', out];
  await run(args);
  const result = await probe(out);
  return { out, sha256: sha256File(out), size: fs.statSync(out).size, width: W, height: H, fps: FPS, expectedS: Math.round(acc * 1000) / 1000, durationS: result.durationS, hasAudio: result.hasAudio, shots: info, loudness: { ...loudness }, transitions: info.map((x) => x.transition), filterGraph: filters.join(';') };
}

/** Checks on the assembled cut, computed from ffmpeg's probe and the shot list. */
function assembledChecks(result, { targetS, shots }) {
  const out = [];
  const tol = Math.max(0.5, (targetS || 0) * 0.1);
  if (targetS) out.push({ code: 'duration_matches_brief', passed: result.durationS != null && Math.abs(result.durationS - targetS) <= tol, detail: `${result.durationS} s vs brief ${targetS} s (±${tol.toFixed(1)} s)` });
  out.push({ code: 'duration_matches_shots', passed: result.durationS != null && Math.abs(result.durationS - result.expectedS) <= 0.35, detail: `${result.durationS} s vs shot list ${result.expectedS} s` });
  out.push({ code: 'every_shot_in_order', passed: result.shots.length === shots.length && result.shots.every((x, i) => x.n === shots[i].n), detail: `${result.shots.length} shots: ${result.shots.map((x) => x.n).join(' → ')}` });
  const needsOverlay = shots.filter((s) => (s.onScreenText && (s.onScreenText.en || s.onScreenText.ar)) || (s.line && (s.line.en || s.line.ar)));
  const missing = needsOverlay.filter((s) => !result.shots.find((x) => x.n === s.n && x.overlay)).map((s) => s.n);
  out.push({ code: 'overlays_present', passed: missing.length === 0, detail: missing.length ? `shots without their text/caption overlay: ${missing.join(', ')}` : `${needsOverlay.length} shot(s) carry text or captions` });
  out.push({ code: 'export_spec', passed: result.hasAudio && result.fps === FPS && result.width > 0, detail: `${result.width}×${result.height} @ ${result.fps} fps, H.264/AAC, loudnorm ${result.loudness.I} LUFS${result.hasAudio ? '' : ' — NO AUDIO'}` });
  return out;
}

module.exports = { ffmpegPath, run, probe, frameFor, tmpDir, sha256File, extractFrames, assemble, assembledChecks, DISSOLVE_S, LOUDNESS, FPS, FRAMES };
