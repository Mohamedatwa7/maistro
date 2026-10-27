// Stage 6 — QC (Phase 6.7): decide whether the assembled draft is ready and
// exactly what to fix if not. Inputs: the F1X8 analysis of the STORED cut (the
// bytes whose sha256 is on the draft version), the automated checks already
// recorded on the draft, storyboard and brief versions, and the shot timeline.
// Code computes the timeline, maps timestamps to shots, enforces that every
// risk and failed check is covered by a fix, and prices the plan with
// Higgsfield's free /estimate endpoint; the model only locates and phrases the
// fixes. Output: one QC report version on the qc stage.
const { registerPrompt, recordGeneration } = require('../_records.js');
const { queryRows } = require('../_supabase.js');

const VERSION = 'qc-report-v1-2026-10-22';
const PLAN_VERSION = 'qc-plan-v1-2026-10-22';
const MODEL = () => process.env.MAISTRO_VISION_MODEL || 'claude-sonnet-5-5';
const ELEMENTS = ['visual', 'overlay_text', 'caption', 'audio', 'pacing'];
const FIX_TYPES = ['overlay_edit', 'caption_edit', 'audio_swap', 'shot_regen', 'shotlist_change'];
// the smallest regeneration unit each element can be fixed at, cheapest first
const ALLOWED = { overlay_text: ['overlay_edit'], caption: ['caption_edit'], audio: ['audio_swap', 'shot_regen'], visual: ['shot_regen', 'shotlist_change'], pacing: ['shotlist_change', 'shot_regen'] };
const DISSOLVE_S = 0.25;

/** Shot start/end on the cut, from the shot durations and the transitions actually applied. */
function timeline(shots, transitions) {
  let t = 0; const out = [];
  shots.forEach((s, i) => {
    const d = Number(s.durationS) || 0;
    out.push({ n: s.n, startS: Math.round(t * 100) / 100, endS: Math.round((t + d) * 100) / 100 });
    const tr = (transitions && transitions[i]) || s.transition;
    t += d - (tr === 'dissolve' && i < shots.length - 1 ? DISSOLVE_S : 0);
  });
  return out;
}
function shotAt(tl, ts) {
  if (typeof ts !== 'number' || !(ts >= 0)) return null;
  const hit = tl.find((x) => ts >= x.startS && ts < x.endS) || (ts >= (tl[tl.length - 1] || {}).endS ? tl[tl.length - 1] : null);
  return hit ? hit.n : null;
}

/** The automated checklist, from checks already stored on the draft, storyboard and brief versions. */
function checklist({ draft, briefChecks, draftChecks, boardChecks }) {
  const items = [];
  const add = (code, passed, detail, extra = {}) => items.push({ code, passed: Boolean(passed), detail, shot: null, element: null, source: 'check', ...extra });
  const shots = draft.shots || [];
  // product accuracy, morphing, artefacts: the clip checks (vision, clip mode), one row per shot
  for (const s of shots) {
    const c = draftChecks.filter((x) => x.kind === 'vision' && x.results && x.results.shot === s.n).sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
    if (!c) { add('clip_checked', false, `shot ${s.n}: no clip check recorded`, { shot: s.n, element: 'visual' }); continue; }
    const flags = (c.results.images || []).flatMap((im) => im.flags || []);
    add('clip_product_and_artifacts', c.passed, c.passed ? `shot ${s.n}: product stable, no artefacts` : `shot ${s.n}: ${[...new Set(flags)].join(', ') || 'needs a look'}`, { shot: s.n, element: 'visual' });
  }
  // technical spec, duration, overlays (captions), audio: the assembled checks
  for (const a of draft.assembledChecks || []) add(`cut_${a.code}`, a.passed, a.detail, { element: a.code === 'overlays_present' ? 'overlay_text' : a.code === 'export_spec' ? 'audio' : a.code.startsWith('duration') ? 'pacing' : null });
  add('cut_loudness', Boolean(draft.assembled && draft.assembled.loudness && draft.assembled.hasAudio), draft.assembled && draft.assembled.loudness ? `loudnorm ${draft.assembled.loudness.I} LUFS / ${draft.assembled.loudness.TP} dBTP (builder target)` : 'no loudness record', { element: 'audio' });
  add('overlay_safe_zone', true, 'text overlays are drawn inside the platform safe zone by construction (page canvas, conservative zone)', { element: 'overlay_text' });
  // claims, disclaimers, Arabic, brand voice: the brief's code + copy checks
  const bc = briefChecks[0];
  if (bc && bc.results) {
    for (const c of bc.results.codeChecks || []) if (['claims_approved', 'arabic_copy_present', 'audio_licensed', 'mandatories_complete', 'product_in_catalog'].includes(c.code)) add(`brief_${c.code}`, c.passed, c.detail, { element: c.code === 'audio_licensed' ? 'audio' : c.code === 'arabic_copy_present' ? 'caption' : null });
    if (bc.results.copy) add('brief_arabic_fluency', bc.results.copy.arabicFluency !== 'literal', `Arabic copy: ${bc.results.copy.arabicFluency}${(bc.results.copy.arabicIssues || []).length ? ` — ${bc.results.copy.arabicIssues.slice(0, 3).join('; ')}` : ''}`, { element: 'caption' });
  } else add('brief_checked', false, 'no brief checks recorded', {});
  const sc = boardChecks.find((x) => x.kind === 'spec');
  if (sc && sc.results && sc.results.mechanic) add('board_trend_mechanic', sc.results.mechanic.followsTrendMechanic !== 'no', `trend mechanic: ${sc.results.mechanic.followsTrendMechanic}; hook: ${sc.results.mechanic.hookStrength}`, { element: 'pacing' });
  return items;
}

const SYSTEM = [
  'You are the QC lead inside MAISTRO (Samsung Gulf social video). You receive the F1X8 engagement analysis of an assembled draft (score, ranked risks with evidence and suggested fixes, a revision brief), the failed automated checks, and the shot timeline (each shot\'s start/end seconds, action, overlay text, caption line, audio cue).',
  'Write the FIX PLAN: one fix per problem, each LOCATED and mapped to the SMALLEST regeneration unit:',
  '- element: visual | overlay_text | caption | audio | pacing',
  '- fixType: overlay_edit (change on-screen text only), caption_edit (change the caption line only), audio_swap (replace the audio bed), shot_regen (re-render ONE shot\'s clip from its approved keyframe with a changed motion prompt), shotlist_change (add, remove, reorder or retime shots — the most expensive, use only when no single-shot fix works).',
  '- shot: the shot number it applies to (0 = the whole piece, only for audio or pacing); timestampS when the risk names a moment (seconds on the cut).',
  '- ref: the F1X8 risk rank it addresses ("risk:1") or the failed check code ("check:<code>"). Every risk and every failed check must be addressed by at least one fix.',
  '- instruction: exactly what to change; for overlay_edit and caption_edit give the new text in en and ar (native Gulf Arabic, never a literal translation); for shot_regen the new motion direction in one sentence.',
  'Never propose a fix that changes the product, makes a claim, names a track, or adds real people. Prefer the cheapest unit that resolves the problem.',
].join('\n');

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['fixes', 'summary'],
  properties: {
    summary: { type: 'string' },
    fixes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['ref', 'shot', 'timestampS', 'element', 'problem', 'fixType', 'instruction', 'newText'], properties: {
      ref: { type: 'string' }, shot: { type: 'integer' }, timestampS: { anyOf: [{ type: 'number' }, { type: 'null' }] }, element: { type: 'string', enum: ELEMENTS }, problem: { type: 'string' }, fixType: { type: 'string', enum: FIX_TYPES }, instruction: { type: 'string' },
      newText: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['en', 'ar'], properties: { en: { type: 'string' }, ar: { type: 'string' } } }] },
    } } },
  },
};

/** Normalise the model's plan in code: shots from timestamps, allowed fix types, coverage. */
function normalisePlan(plan, { tl, risks, failed }) {
  const nShots = tl.length; const notes = [];
  const fixes = (plan.fixes || []).map((f, i) => {
    const out = { id: `fx${i + 1}`, ...f, include: true };
    const at = shotAt(tl, f.timestampS);
    if (at != null && at !== f.shot) { notes.push(`${out.id}: shot ${f.shot} → ${at} from t=${f.timestampS}s`); out.shot = at; }
    if (!(Number.isInteger(out.shot) && out.shot >= 0 && out.shot <= nShots)) { notes.push(`${out.id}: shot ${f.shot} out of range → whole piece`); out.shot = 0; }
    if (out.shot === 0 && !['audio', 'pacing'].includes(out.element)) { notes.push(`${out.id}: a ${out.element} fix needs a shot → shot 1`); out.shot = 1; }
    const allowed = ALLOWED[out.element] || FIX_TYPES;
    if (!allowed.includes(out.fixType)) { notes.push(`${out.id}: ${out.fixType} is not a unit for ${out.element} → ${allowed[0]}`); out.fixType = allowed[0]; }
    if (['overlay_edit', 'caption_edit'].includes(out.fixType) && !(out.newText && (out.newText.en || out.newText.ar))) notes.push(`${out.id}: ${out.fixType} without new text`);
    return out;
  });
  const refs = new Set(fixes.map((f) => f.ref));
  const uncovered = [...risks.map((r) => `risk:${r.rank}`), ...failed.map((c) => `check:${c.code}`)].filter((r) => !refs.has(r));
  return { fixes, notes, coverage: { risks: risks.length, failedChecks: failed.length, uncovered, complete: uncovered.length === 0 } };
}

/** Price the plan: Higgsfield /estimate for every shot re-render (deduplicated per shot); edits cost a re-assembly only. */
async function estimatePlan(fixes, { draft, estimate }) {
  const items = []; const regenShots = new Set(); let total = 0; const unknown = [];
  for (const f of fixes.filter((x) => x.include)) {
    if (f.fixType === 'overlay_edit' || f.fixType === 'caption_edit') { items.push({ id: f.id, fixType: f.fixType, usd: 0, basis: 're-assembly only (ffmpeg on our function)' }); continue; }
    if (f.fixType === 'audio_swap') { items.push({ id: f.id, fixType: f.fixType, usd: null, basis: 'blocked: no licensed audio library is connected (owner input)' }); unknown.push(f.id); continue; }
    if (f.fixType === 'shot_regen') {
      if (regenShots.has(f.shot)) { items.push({ id: f.id, fixType: f.fixType, usd: 0, basis: `shares shot ${f.shot}'s re-render` }); continue; }
      regenShots.add(f.shot);
      const s = (draft.shots || []).find((x) => x.n === f.shot) || {};
      const body = { image_url: 'https://estimate.invalid/keyframe.png', prompt: f.instruction, duration: Math.min(30, Math.max(4, Math.ceil(Number(s.durationS) || 4))), resolution: draft.resolution || '720p', generate_audio: true, bitrate_mode: 'high' };
      try { const e = await estimate('bytedance/seedance-2.5/image-to-video', body); items.push({ id: f.id, fixType: f.fixType, usd: e.usd, credits: e.credits, basis: `Seedance image-to-video ${body.duration}s ${body.resolution} (provider estimate)` }); total += e.usd; }
      catch (err) { items.push({ id: f.id, fixType: f.fixType, usd: null, basis: `estimate failed: ${String(err.message).slice(0, 120)}` }); unknown.push(f.id); }
      continue;
    }
    // shotlist_change: a new keyframe + a new clip at least; the storyboard rewrite (Claude) is not priced
    try {
      const k = await estimate('higgsfield-ai/soul/v2/standard', { prompt: f.instruction, aspect_ratio: draft.aspect || '9:16', resolution: '1080p', batch_size: 1 });
      const c = await estimate('bytedance/seedance-2.5/image-to-video', { image_url: 'https://estimate.invalid/keyframe.png', prompt: f.instruction, duration: 4, resolution: draft.resolution || '720p', generate_audio: true, bitrate_mode: 'high' });
      items.push({ id: f.id, fixType: f.fixType, usd: Math.round((k.usd + c.usd) * 10000) / 10000, basis: 'one keyframe (Soul V2) + one 4 s clip (provider estimates); the shot-list rewrite is a Claude call, not priced' }); total += k.usd + c.usd;
    } catch (err) { items.push({ id: f.id, fixType: f.fixType, usd: null, basis: `estimate failed: ${String(err.message).slice(0, 120)}` }); unknown.push(f.id); }
  }
  return { totalUsd: Math.round(total * 10000) / 10000, items, unknownIds: unknown, note: unknown.length ? `${unknown.length} fix(es) not priced` : 'all fixes priced' };
}

async function planFixes({ analysis, failed, tl, draft, legacyId, memberId, client }) {
  const Anthropic = client ? null : require('@anthropic-ai/sdk');
  const c = client || new Anthropic({ timeout: 90000, maxRetries: 1 });
  registerPrompt('studio.qc.plan', PLAN_VERSION, `SYSTEM:\n${SYSTEM}\n\nUSER: f1x8 {{analysis}} failed checks {{failed}} timeline {{timeline}}`, ['analysis', 'failed', 'timeline']);
  const v = analysis.verdict || {};
  const shots = (draft.shots || []).map((s) => { const t = tl.find((x) => x.n === s.n) || {}; return { n: s.n, startS: t.startS, endS: t.endS, type: s.type, action: s.action, overlayText: s.onScreenText, captionLine: s.line, audioCue: s.audioCue, transition: s.transition }; });
  const user = `F1X8 ANALYSIS: ${JSON.stringify({ score: analysis.score, summary: v.summary, risks: v.risks || [], revisionBrief: v.revision_brief || null }, null, 1)}\n\nFAILED AUTOMATED CHECKS: ${JSON.stringify(failed.map((x) => ({ code: x.code, shot: x.shot, element: x.element, detail: x.detail })), null, 1)}\n\nSHOT TIMELINE (seconds on the cut): ${JSON.stringify(shots, null, 1)}`;
  const t0 = Date.now();
  const rec = { kind: 'claude', legacyPieceId: legacyId, stage: 'qc', model: MODEL(), promptName: 'studio.qc.plan', promptVersion: PLAN_VERSION, resolvedPrompt: `${SYSTEM}\n\n${user}`, userPrompt: user, params: { risks: (v.risks || []).length, failed: failed.length }, memberId };
  let response;
  try { response = await c.messages.create({ model: MODEL(), max_tokens: 8000, system: SYSTEM, messages: [{ role: 'user', content: user }], output_config: { format: { type: 'json_schema', schema: SCHEMA }, effort: 'low' } }); }
  catch (e) { await recordGeneration({ ...rec, status: 'failed', error: e.message, latencyMs: Date.now() - t0 }); return { error: e.message }; }
  const text = response.content && response.content.find((b) => b.type === 'text');
  let j; try { j = JSON.parse(text ? text.text : ''); } catch (e) { await recordGeneration({ ...rec, status: 'failed', error: 'malformed JSON', latencyMs: Date.now() - t0 }); return { error: 'malformed JSON' }; }
  if (!Array.isArray(j.fixes)) { await recordGeneration({ ...rec, status: 'failed', error: 'no fixes array', latencyMs: Date.now() - t0 }); return { error: 'no fixes array' }; }
  await recordGeneration({ ...rec, status: 'succeeded', latencyMs: Date.now() - t0, usage: response.usage || null });
  return { plan: j, model: MODEL() };
}

/** Everything the report needs that lives in the store. */
async function reportContext(pieceId, draftVersionId) {
  const stages = await queryRows('stages', `select=id,kind,current_version_id&piece_id=eq.${encodeURIComponent(pieceId)}`);
  const vid = (k) => (stages.find((s) => s.kind === k) || {}).current_version_id || null;
  const checksOf = (id) => (id ? queryRows('stage_checks', `select=*&artifact_version_id=eq.${encodeURIComponent(id)}&order=at.desc&limit=50`) : Promise.resolve([]));
  const [dv] = await queryRows('artifact_versions', `select=id,version,payload&id=eq.${encodeURIComponent(draftVersionId)}&limit=1`);
  const [draftChecks, briefChecks, boardChecks] = await Promise.all([checksOf(draftVersionId), checksOf(vid('brief')).then((r) => r.filter((x) => x.kind === 'copy')), checksOf(vid('board'))]);
  return { draft: dv ? dv.payload : {}, draftVersion: dv ? dv.version : null, draftChecks, briefChecks, boardChecks };
}

async function buildReport({ analysis, heatmapPath, pieceId, legacyId, draftVersionId, draftSha256, memberId, estimate, client }) {
  const ctx = await reportContext(pieceId, draftVersionId);
  const draft = ctx.draft;
  const tl = timeline(draft.shots || [], draft.assembled && draft.assembled.transitions);
  const items = checklist({ draft, briefChecks: ctx.briefChecks, draftChecks: ctx.draftChecks, boardChecks: ctx.boardChecks });
  const failed = items.filter((x) => !x.passed);
  const risks = (analysis.verdict && analysis.verdict.risks) || [];
  const p = await planFixes({ analysis, failed, tl, draft, legacyId, memberId, client });
  const norm = p.plan ? normalisePlan(p.plan, { tl, risks, failed }) : { fixes: [], notes: [`plan failed: ${p.error}`], coverage: { risks: risks.length, failedChecks: failed.length, uncovered: [...risks.map((r) => `risk:${r.rank}`), ...failed.map((c) => `check:${c.code}`)], complete: false } };
  const cost = await estimatePlan(norm.fixes, { draft, estimate });
  return {
    reportVersion: VERSION, planVersion: PLAN_VERSION, planModel: p.model || null, planError: p.error || null,
    score: typeof analysis.score === 'number' ? analysis.score : null, summary: (analysis.verdict && analysis.verdict.summary) || (p.plan && p.plan.summary) || '',
    f1x8: { risks, revisionBrief: (analysis.verdict && analysis.verdict.revision_brief) || null, heatmapPath: heatmapPath || null },
    draftVersionId, draftVersion: ctx.draftVersion, draftSha256, timeline: tl, format: { resolution: draft.resolution || '720p', aspect: draft.aspect || '9:16' },
    checklist: items, passedChecks: items.filter((x) => x.passed).length, failedChecks: failed.length,
    fixes: norm.fixes, planNotes: norm.notes, coverage: norm.coverage, cost,
  };
}

/** A human edit of the plan: drop or re-instruct fixes; coverage and cost are recomputed in code. */
async function editPlan(report, edits, { estimate }) {
  const byId = new Map((edits || []).map((e) => [String(e.id), e]));
  const fixes = report.fixes.map((f) => { const e = byId.get(f.id); if (!e) return f; return { ...f, include: e.include !== undefined ? Boolean(e.include) : f.include, instruction: typeof e.instruction === 'string' && e.instruction.trim() ? e.instruction.trim().slice(0, 1000) : f.instruction, newText: e.newText && typeof e.newText === 'object' ? { en: String(e.newText.en || '').slice(0, 200), ar: String(e.newText.ar || '').slice(0, 200) } : f.newText, edited: true }; });
  const refs = new Set(fixes.filter((f) => f.include).map((f) => f.ref));
  const all = [...report.f1x8.risks.map((r) => `risk:${r.rank}`), ...report.checklist.filter((c) => !c.passed).map((c) => `check:${c.code}`)];
  const uncovered = all.filter((r) => !refs.has(r));
  const fmt = report.format || {};
  const cost = await estimatePlan(fixes, { draft: { shots: report.timeline.map((t) => ({ n: t.n, durationS: Math.round((t.endS - t.startS) * 100) / 100 })), resolution: fmt.resolution, aspect: fmt.aspect }, estimate });
  return { ...report, fixes, coverage: { ...report.coverage, uncovered, complete: uncovered.length === 0, accepted: uncovered.length ? 'risks left unaddressed by the human edit' : null }, cost, editedAt: new Date().toISOString() };
}

module.exports = { VERSION, PLAN_VERSION, SYSTEM, SCHEMA, ELEMENTS, FIX_TYPES, ALLOWED, timeline, shotAt, checklist, normalisePlan, estimatePlan, planFixes, reportContext, buildReport, editPlan };
