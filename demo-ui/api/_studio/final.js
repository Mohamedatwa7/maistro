// Stage 7 — Final (Phase 6.8): apply the APPROVED QC fix plan at each fix's
// regeneration unit only, verify every original risk afterwards, show the
// manager a per-shot diff, and package the deliverable.
//   - overlay_edit / caption_edit → the shot's text changes; its overlay PNG is
//     redrawn by the browser (Arabic shaping) before the re-assembly
//   - shot_regen → ONE Seedance image-to-video job from the shot's approved
//     keyframe with the fix instruction appended
//   - audio_swap / shotlist_change → NOT applied here (no licensed library; a
//     shot-list change means sending the piece back to the storyboard) and
//     reported as such, never hidden
// Untouched shots keep their clip and overlay objects verbatim (same asset
// path, same sha256), so they are byte-identical to the draft.
const crypto = require('node:crypto');
const { registerPrompt, recordGeneration } = require('../_records.js');

const VERSION = 'final-v1-2026-10-22';
const VERIFY_VERSION = 'final-verify-v1-2026-10-22';
const MODEL = () => process.env.MAISTRO_VISION_MODEL || 'claude-sonnet-5-5';

/** Build the final version's shots from the draft's and the approved plan. */
function applyPlan(draft, report) {
  const shots = (draft.shots || []).map((s) => ({ ...s }));
  const applied = []; const notApplied = []; const regen = new Map();
  for (const f of (report.fixes || []).filter((x) => x.include)) {
    const s = shots.find((x) => x.n === f.shot);
    if (f.fixType === 'audio_swap') { notApplied.push({ id: f.id, ref: f.ref, fixType: f.fixType, reason: 'no licensed audio library is connected — owner input' }); continue; }
    if (f.fixType === 'shotlist_change') { notApplied.push({ id: f.id, ref: f.ref, fixType: f.fixType, reason: 'a shot-list change is made in the storyboard — send the piece back from QC' }); continue; }
    if (!s) { notApplied.push({ id: f.id, ref: f.ref, fixType: f.fixType, reason: `shot ${f.shot} not in the draft` }); continue; }
    if (f.fixType === 'overlay_edit' || f.fixType === 'caption_edit') {
      if (!f.newText || !(f.newText.en || f.newText.ar)) { notApplied.push({ id: f.id, ref: f.ref, fixType: f.fixType, reason: 'the fix has no new text' }); continue; }
      const field = f.fixType === 'overlay_edit' ? 'onScreenText' : 'line';
      const before = s[field] || { en: '', ar: '' };
      s[field] = { en: f.newText.en || '', ar: f.newText.ar || '' };
      s.overlay = null; s.overlayStale = true; // the browser redraws it before the assembly
      applied.push({ id: f.id, ref: f.ref, fixType: f.fixType, shot: s.n, change: { field, before, after: s[field] } });
      continue;
    }
    // shot_regen: one clip per shot, instructions of several fixes merged
    regen.set(s.n, [...(regen.get(s.n) || []), f]);
  }
  for (const [n, fixes] of regen) {
    const s = shots.find((x) => x.n === n);
    s.clipHistory = [...(s.clipHistory || []), ...(s.clip ? [s.clip] : [])];
    s.clip = { state: 'pending' }; s.review = null; s.regenInstruction = fixes.map((f) => f.instruction).join(' ');
    for (const f of fixes) applied.push({ id: f.id, ref: f.ref, fixType: f.fixType, shot: n, change: { field: 'clip', instruction: f.instruction } });
  }
  return { shots, applied, notApplied, regenShots: [...regen.keys()] };
}

/** Per-shot diff draft → final, from asset hashes and text (computed, never described by a model). */
function diffShots(draftShots, finalShots) {
  return (finalShots || []).map((f) => {
    const d = (draftShots || []).find((x) => x.n === f.n) || {};
    const clipSame = Boolean(d.clip && f.clip && d.clip.sha256 && d.clip.sha256 === f.clip.sha256 && d.clip.assetPath === f.clip.assetPath);
    const textChanges = ['onScreenText', 'line'].filter((k) => JSON.stringify(d[k] || {}) !== JSON.stringify(f[k] || {}));
    const overlaySame = Boolean((d.overlay && f.overlay && d.overlay.sha256 === f.overlay.sha256) || (!d.overlay && !f.overlay));
    const status = clipSame && !textChanges.length && overlaySame ? 'unchanged' : !clipSame ? 'clip_regenerated' : 'text_changed';
    return { n: f.n, status, clipSame, overlaySame, textChanges, draftClip: d.clip ? { assetPath: d.clip.assetPath, sha256: d.clip.sha256 } : null, finalClip: f.clip ? { assetPath: f.clip.assetPath || null, sha256: f.clip.sha256 || null, state: f.clip.state } : null, before: Object.fromEntries(textChanges.map((k) => [k, d[k]])), after: Object.fromEntries(textChanges.map((k) => [k, f[k]])) };
  });
}

const VERIFY_SYSTEM = [
  'You verify whether the fixes applied to a Samsung Gulf social video resolved the QC risks. You get each ORIGINAL risk (from the F1X8 analysis of the draft) with the fix that was applied, and the NEW F1X8 analysis of the final cut (score, risks, summary).',
  'For every original risk answer resolved: yes | partial | no, quoting the new analysis as evidence (a new risk that restates the old one means "no"; its absence with a better score is "yes"). Be strict; never mark a risk resolved without evidence.',
].join('\n');
const VERIFY_SCHEMA = { type: 'object', additionalProperties: false, required: ['risks'], properties: { risks: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ref', 'resolved', 'evidence'], properties: { ref: { type: 'string' }, resolved: { type: 'string', enum: ['yes', 'partial', 'no'] }, evidence: { type: 'string' } } } } } };

async function verifyRisks({ report, applied, notApplied, analysis, legacyId, memberId, client }) {
  const Anthropic = client ? null : require('@anthropic-ai/sdk');
  const c = client || new Anthropic({ timeout: 90000, maxRetries: 1 });
  registerPrompt('studio.final.verify', VERIFY_VERSION, `SYSTEM:\n${VERIFY_SYSTEM}\n\nUSER: original {{original}} applied {{applied}} new {{analysis}}`, ['original', 'applied', 'analysis']);
  const original = (report.f1x8.risks || []).map((r) => ({ ref: `risk:${r.rank}`, issue: r.issue, evidence: r.evidence, fixes: [...applied.filter((a) => a.ref === `risk:${r.rank}`).map((a) => `${a.fixType}: ${a.change.instruction || JSON.stringify(a.change.after)}`), ...notApplied.filter((a) => a.ref === `risk:${r.rank}`).map((a) => `NOT APPLIED (${a.fixType}): ${a.reason}`)] }));
  const v = analysis.verdict || {};
  const user = `ORIGINAL RISKS AND THE FIXES APPLIED: ${JSON.stringify(original, null, 1)}\n\nNEW F1X8 ANALYSIS OF THE FINAL CUT: ${JSON.stringify({ score: analysis.score, summary: v.summary, risks: v.risks || [] }, null, 1)}`;
  const t0 = Date.now();
  const rec = { kind: 'claude', legacyPieceId: legacyId, stage: 'final', model: MODEL(), promptName: 'studio.final.verify', promptVersion: VERIFY_VERSION, resolvedPrompt: `${VERIFY_SYSTEM}\n\n${user}`, userPrompt: user, params: { risks: original.length }, memberId };
  let response;
  try { response = await c.messages.create({ model: MODEL(), max_tokens: 4000, system: VERIFY_SYSTEM, messages: [{ role: 'user', content: user }], output_config: { format: { type: 'json_schema', schema: VERIFY_SCHEMA }, effort: 'low' } }); }
  catch (e) { await recordGeneration({ ...rec, status: 'failed', error: e.message, latencyMs: Date.now() - t0 }); return { error: e.message }; }
  const text = response.content && response.content.find((b) => b.type === 'text');
  let j; try { j = JSON.parse(text ? text.text : ''); } catch (e) { await recordGeneration({ ...rec, status: 'failed', error: 'malformed JSON', latencyMs: Date.now() - t0 }); return { error: 'malformed JSON' }; }
  await recordGeneration({ ...rec, status: 'succeeded', latencyMs: Date.now() - t0, usage: response.usage || null });
  // every original risk gets a row; a risk the model skipped is "no" (never hidden)
  const by = new Map((j.risks || []).map((r) => [r.ref, r]));
  const risks = original.map((o) => by.get(o.ref) || { ref: o.ref, resolved: 'no', evidence: 'not assessed by the verifier — treated as unresolved' });
  return { risks, model: MODEL() };
}

/** The deliverable manifest (JSON), hashed, for the Sprinklr adapter or manual posting. */
function packageManifest({ piece, finalVersion, final, brief, thumb, scores, trend }) {
  const sp = brief && brief.spec ? brief.spec : null;
  const captions = { en: sp ? sp.caption.en : null, ar: sp ? sp.caption.ar : null };
  const m = {
    manifestVersion: VERSION, generatedAt: new Date().toISOString(),
    piece: { id: piece.legacy_id, title: piece.title, trend: trend || { id: piece.trend_id || null, name: piece.trend_name || null }, angle: piece.angle || null, products: [piece.product].filter(Boolean), markets: piece.markets || [], platforms: piece.platforms || [] },
    final: { versionId: finalVersion.id, version: finalVersion.version, video: final.assembled ? { assetPath: final.assembled.assetPath, sha256: final.assembled.sha256, durationS: final.assembled.durationS, width: final.assembled.width, height: final.assembled.height, fps: final.assembled.fps, aspect: final.aspect } : null, exports: final.assembled ? [{ platform: (piece.platforms || [])[0] || null, aspect: final.aspect, assetPath: final.assembled.assetPath }] : [] },
    thumbnail: thumb ? { assetPath: thumb.assetPath || null, sha256: thumb.sha256 || null, overlay: thumb.overlay ? { headline: thumb.overlay.headline || null, headlineAr: thumb.overlay.headlineAr || null } : null } : null,
    copy: { captions, hashtags: sp ? sp.hashtags : null, cta: sp ? sp.cta : null, disclaimers: sp ? sp.claims.map((c) => c.disclaimer).filter(Boolean) : [], claims: sp ? sp.claims : [] },
    scores: { f1x8Draft: scores.draft, f1x8Final: scores.final, risksResolved: scores.resolved },
  };
  const body = JSON.stringify(m, null, 1);
  return { manifest: m, body, sha256: crypto.createHash('sha256').update(body).digest('hex') };
}

module.exports = { VERSION, VERIFY_VERSION, applyPlan, diffShots, verifyRisks, packageManifest };
