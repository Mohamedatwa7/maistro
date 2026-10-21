// Phase 6.6 (b) — assembly with the bundled ffmpeg on synthetic clips (no paid API): trim to shot durations,
// dissolve, overlay, loudness, export spec; frame extraction for the clip checks. Numbers come from ffmpeg's probe.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../../api/_studio/assemble.js');

const have = (() => { try { return fs.existsSync(A.ffmpegPath()); } catch { return false; } })();

async function synth(dir, name, seconds, { audio = true, size = '180x320' } = {}) {
  const file = path.join(dir, name);
  const args = ['-f', 'lavfi', '-i', `testsrc=duration=${seconds}:size=${size}:rate=30`];
  if (audio) args.push('-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`);
  args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-shortest');
  args.push(file);
  await A.run(args);
  return file;
}

test('assemble: three synthetic clips trimmed to 2 / 1.5 / 2 s with one dissolve and one overlay → one 720p-class cut of the expected length with audio, 30 fps; assembledChecks reads the probe; extractFrames yields three PNGs', { skip: !have && 'ffmpeg binary not available' }, async () => {
  const dir = A.tmpDir('maistro-test-');
  try {
    const c1 = await synth(dir, 'c1.mp4', 4); const c2 = await synth(dir, 'c2.mp4', 4, { audio: false }); const c3 = await synth(dir, 'c3.mp4', 4);
    // an overlay PNG the size of the output frame (transparent with a red box), drawn by ffmpeg here, by the browser in production
    const ov = path.join(dir, 'ov.png');
    await A.run(['-f', 'lavfi', '-i', 'color=c=red@0.6:s=200x100:d=1,format=rgba', '-frames:v', '1', ov]);
    const out = path.join(dir, 'cut.mp4');
    const r = await A.assemble({ shots: [{ n: 1, file: c1, trimS: 2, transition: 'cut', overlayFile: ov }, { n: 2, file: c2, trimS: 1.5, transition: 'dissolve', overlayFile: null }, { n: 3, file: c3, trimS: 2, transition: 'none', overlayFile: null }], aspect: '9:16', resolution: '720p', out });
    assert.equal(r.width, 720); assert.equal(r.height, 1280); assert.equal(r.fps, 30); assert.equal(r.hasAudio, true);
    assert.equal(r.expectedS, 5.25, '2 + 1.5 + 2 − 0.25 dissolve'); assert.ok(Math.abs(r.durationS - 5.25) < 0.35, `duration ${r.durationS}`);
    assert.deepEqual(r.transitions, ['cut', 'dissolve', 'none']); assert.equal(r.shots[1].source.hasAudio, false, 'silence was synthesised for the mute clip'); assert.ok(/xfade=transition=fade:duration=0\.25:offset=3\.250/.test(r.filterGraph)); assert.ok(/loudnorm=I=-14:TP=-1:LRA=11/.test(r.filterGraph));
    assert.match(r.sha256, /^[0-9a-f]{64}$/); assert.ok(r.size > 1000);
    const checks = A.assembledChecks(r, { targetS: 5, shots: [{ n: 1, onScreenText: { en: 'x', ar: '' }, line: { en: '', ar: '' } }, { n: 2, onScreenText: { en: '', ar: '' }, line: { en: 'cap', ar: '' } }, { n: 3, onScreenText: { en: '', ar: '' }, line: { en: '', ar: '' } }] });
    const by = Object.fromEntries(checks.map((c) => [c.code, c]));
    assert.equal(by.duration_matches_brief.passed, true); assert.equal(by.duration_matches_shots.passed, true); assert.equal(by.every_shot_in_order.passed, true); assert.equal(by.export_spec.passed, true);
    assert.equal(by.overlays_present.passed, false, 'shot 2 has a caption line but no overlay'); assert.match(by.overlays_present.detail, /: 2$/);
    const fr = await A.extractFrames(c3, dir);
    assert.equal(fr.frames.length, 3); assert.ok(fr.frames.every((f) => fs.existsSync(f.file) && fs.statSync(f.file).size > 100)); assert.deepEqual(fr.frames.map((f) => f.index), [0, 1, 2]); assert.ok(fr.frames[2].t > 3.5 && fr.frames[2].t < 4);
    assert.equal(A.frameFor('16:9', '1080p')[0], 1920); assert.equal(A.frameFor('1:1', '720p')[1], 720);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
