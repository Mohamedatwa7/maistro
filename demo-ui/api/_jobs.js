// The job service (M3, ADR-004). A `jobs` row is the source of truth for
// every long-running provider call. createJob() writes the row (after the
// domain allowed the stage to generate) and tries one advance so the submit
// happens inside the request when it is quick; the one-minute tick and the
// page's own reads advance due rows afterwards. Completion records the
// artifact version through the campaign store (job_id, producedBy) and the
// stage goes generating → generated through the domain. Nothing here waits
// on a provider beyond one bounded call.
const { queryRows, insertRows, patchRows } = require('./_supabase.js');
const { ensurePiece, recordVersion, StoreError } = require('./_store.js');
const { prerequisitesMet, transition } = require('../src/domain/stages.js');
const higgsfield = require('./_adapters/higgsfield.js');
const f1x8 = require('./_adapters/f1x8.js');
const storage = require('./_adapters/storage.js');
const { recordGeneration } = require('./_records.js');
const jobRecord = (job, extra) => recordGeneration({ kind: job.kind.startsWith('higgsfield') ? job.kind : 'f1x8', legacyPieceId: job.payload && job.payload.pieceId, pieceId: job.piece_id || null, stage: job.payload && job.payload.stage, promptName: job.kind.startsWith('higgsfield') ? 'director.prompt' : 'f1x8.analysis', promptVersion: null, resolvedPrompt: job.payload && (job.payload.prompt || job.payload.description) || null, params: { aspect_ratio: job.payload && job.payload.aspect_ratio, resolution: job.payload && job.payload.resolution, duration: job.payload && job.payload.duration, ref: Boolean(job.payload && job.payload.ref), v: job.payload && job.payload.v }, inputAssets: job.payload && (job.payload.ref || job.payload.assetUrl || job.payload.assetPath) ? [job.payload.ref || job.payload.assetPath || job.payload.assetUrl] : [], jobId: job.id, memberId: job.payload && job.payload.generatedBy, correlationId: job.payload && job.payload.correlationId, latencyMs: job.started_at ? Date.now() - new Date(job.started_at).getTime() : null, ...extra });

const q = (v) => encodeURIComponent(String(v));
const KINDS = ['higgsfield_image', 'higgsfield_video', 'f1x8_image', 'f1x8_video', 'vision_check'];
const RENDER_KINDS = ['higgsfield_image', 'higgsfield_video'];
const KIND_STAGE = { higgsfield_image: ['mood', 'thumb', 'board'], higgsfield_video: ['draft', 'final'], f1x8_image: ['mood', 'thumb', 'board'], f1x8_video: ['draft', 'final'], vision_check: ['mood', 'thumb', 'board'] };
// How long to wait before asking again, and when to give up (seconds).
// the vision_check claim window must exceed the bounded model call (90 s) so a
// second tick cannot re-claim a check that is still running
const POLL_S = { higgsfield_image: 20, higgsfield_video: 45, f1x8_image: 60, f1x8_video: 90, vision_check: 150 };
const TIMEOUT_S = { higgsfield_image: 15 * 60, higgsfield_video: 20 * 60, f1x8_image: 30 * 60, f1x8_video: 45 * 60, vision_check: 10 * 60 };
const MAX_SUBMIT_ATTEMPTS = 3;

const nowIso = () => new Date().toISOString();
const plusS = (s) => new Date(Date.now() + s * 1000).toISOString();

function publicJob(j, legacyId) {
  return {
    id: j.id, kind: j.kind, state: j.state, stage: j.payload && j.payload.stage, pieceId: legacyId || (j.payload && j.payload.pieceId) || null,
    providerRef: j.provider_ref || null, attempts: j.attempts, result: j.result || null, error: j.error || null,
    createdAt: j.created_at, startedAt: j.started_at || null, finishedAt: j.finished_at || null, nextPollAt: j.next_poll_at || null,
  };
}

/** Create a job for a stage of a piece. `payload` is the provider request
 *  plus `meta` (what the artifact needs: prompt, note, ar, dur, res) for
 *  renders, or {assetUrl, title, description} for F1X8. */
async function createJob({ legacyId, stage, kind, payload = {}, piece = {}, member = null }) {
  if (!KINDS.includes(kind)) throw new StoreError(400, 'bad_kind', `kind must be one of ${KINDS.join(', ')}`);
  if (!KIND_STAGE[kind].includes(stage)) throw new StoreError(400, 'bad_stage', `${kind} cannot target stage "${stage}"`);
  const { piece: p, stages } = await ensurePiece(legacyId, piece);
  const s = stages.find((x) => x.kind === stage);
  const isRender = RENDER_KINDS.includes(kind);
  let nextStageState = null;
  if (isRender) {
    // Order (A-05, M3): the legacy page is soft — prerequisites must exist;
    // the new pages will pass strict:true and require them approved.
    const met = prerequisitesMet(stages.map((x) => ({ kind: x.kind, state: x.state })), stage, { strict: Boolean(payload.strict), origin: p.origin });
    if (met !== true) throw new StoreError(409, 'prerequisites', `${stage} needs ${met.join(', ')} first`);
    if (s.state === 'approved') throw new StoreError(409, 'approved_immutable', `${stage} is approved; reopen it before regenerating`);
    // a never-touched stage whose prerequisites exist counts as ready; a stage
    // left `generating` by a job that is no longer live counts as ready too
    let from = s.state === 'locked' ? 'ready' : s.state;
    if (from === 'generating') {
      const live = await queryRows('jobs', `select=id&stage_id=eq.${q(s.id)}&state=in.(queued,running)&limit=1`);
      if (!live.length) from = 'ready';
    }
    const t = transition(stage, from, { type: from === 'generated' ? 'regenerate' : 'generate' });
    if (!t.ok) throw new StoreError(409, t.code, t.message);
    nextStageState = t.next;
  } else if (kind === 'vision_check') {
    if (!s.current_version_id) throw new StoreError(409, 'no_version', `${stage} has nothing to check yet`);
  } else if (!s.current_version_id && !payload.assetUrl && !payload.assetPath) {
    throw new StoreError(409, 'no_version', `${stage} has nothing to analyse yet`);
  }
  // the row first, the stage second: a failed insert leaves nothing behind,
  // and a failed stage patch is recorded on the row instead of stranding the stage
  const [job] = await insertRows('jobs', [{
    piece_id: p.id, stage_id: s.id, kind, state: 'queued', attempts: 0,
    payload: { ...payload, pieceId: legacyId, stage, generatedBy: member ? member.id : null },
    next_poll_at: nowIso(),
  }], { returning: true });
  if (nextStageState) {
    try { await patchRows('stages', `id=eq.${q(s.id)}`, { state: nextStageState }); }
    catch (e) { await finish(job, { state: 'failed', error: `stage could not be set generating: ${String(e.message || e).slice(0, 200)}` }); throw new StoreError(502, 'stage_patch', e.message); }
  }
  // try to submit right away (bounded); the tick picks it up otherwise
  await advance(job).catch(() => null);
  const fresh = await getJob(job.id);
  return publicJob(fresh || job, legacyId);
}

async function getJob(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
  const rows = await queryRows('jobs', `select=*&id=eq.${q(id)}&limit=1`);
  return rows[0] || null;
}

/** Take a due row: a conditional update that only succeeds for one caller
 *  (state unchanged and next_poll_at still due), so overlapping ticks or a
 *  tick racing a page read never double-submit. */
async function claim(job) {
  const rows = await patchRows('jobs', `id=eq.${q(job.id)}&state=eq.${q(job.state)}&next_poll_at=lte.${q(nowIso())}`, {
    next_poll_at: plusS(POLL_S[job.kind] || 60), started_at: job.started_at || nowIso(),
  });
  return rows.length ? rows[0] : null;
}

async function finish(job, patch) {
  const rows = await patchRows('jobs', `id=eq.${q(job.id)}`, { finished_at: nowIso(), next_poll_at: null, ...patch });
  return rows[0] || { ...job, ...patch };
}

/** Advance one job by one step: submit if it has no provider ref, otherwise
 *  read the provider status; on completion record the result. Returns the
 *  row's new state. Safe to call on a row that is not due (no-op). */
async function advance(job) {
  if (!['queued', 'running'].includes(job.state)) return job.state;
  const claimed = await claim(job);
  if (!claimed) return job.state; // someone else has it, or not due yet
  job = claimed;
  const started = new Date(job.started_at || job.created_at).getTime();
  if (Date.now() - started > (TIMEOUT_S[job.kind] || 1800) * 1000) {
    await fail(job, 'timed_out', `no result after ${Math.round((TIMEOUT_S[job.kind] || 1800) / 60)} minutes`);
    return 'timed_out';
  }
  try {
    if (!job.provider_ref && job.kind === 'vision_check') return await runVisionCheck(job);
    if (!job.provider_ref) {
      const attempts = (job.attempts || 0) + 1;
      if (attempts > MAX_SUBMIT_ATTEMPTS) { await fail(job, 'failed', job.error || 'submit failed repeatedly'); return 'failed'; }
      await patchRows('jobs', `id=eq.${q(job.id)}`, { attempts });
      try {
        const sub = job.kind.startsWith('higgsfield')
          ? await higgsfield.submit({ ...job.payload, kind: job.kind === 'higgsfield_image' ? 'image' : 'video' }, { idempotencyKey: job.id })
          : await f1x8.submit({ kind: job.kind === 'f1x8_video' ? 'video' : 'image', assetUrl: await assetUrlFor(job.payload), title: job.payload.title, description: job.payload.description });
        await patchRows('jobs', `id=eq.${q(job.id)}`, { provider_ref: String(sub.ref), state: 'running', error: null, payload: { ...job.payload, v: sub.v || 0, ...(sub.correlationId ? { correlationId: sub.correlationId } : {}) } });
        return 'running';
      } catch (e) {
        // Documented classification (HIGGSFIELD.md §3 H-3): retryable = the
        // concurrency-limit 400, 423, 5xx, timeouts and network errors;
        // permanent = validation, auth, not-found, insufficient credits, and
        // a disallowed asset host. Retries replay the same Idempotency-Key.
        const permanent = e && e.retryable === false ? true : Boolean(e && e.status && e.status < 500 && e.status !== 429 && e.retryable !== true);
        if (permanent) { await fail(job, 'failed', e.message); return 'failed'; }
        const wait = Math.round(60 * attempts * (0.75 + Math.random() * 0.5)); // backoff with jitter
        await patchRows('jobs', `id=eq.${q(job.id)}`, { error: String(e.message || e).slice(0, 300), next_poll_at: plusS(wait) });
        return 'queued';
      }
    }
    if (job.kind.startsWith('higgsfield')) return await pollRender(job);
    if (job.kind === 'vision_check') return await runVisionCheck(job);
    return await pollQc(job);
  } catch (e) {
    await patchRows('jobs', `id=eq.${q(job.id)}`, { error: String(e.message || e).slice(0, 300), attempts: (job.attempts || 0) + 1 });
    return job.state;
  }
}

/** The stored copy outlives the provider URL (seven days): sign it for the
 *  analysis when the job names an assetPath; fall back to the provider URL. */
async function assetUrlFor(payload) {
  if (payload && payload.assetPath && /^pieces\/[a-zA-Z0-9_-]{3,64}\/(mood|thumb|board|draft|final)\/[a-z0-9-]+\.(png|jpg|webp|mp4|webm|mov)$/.test(payload.assetPath)) {
    try { return await storage.signedUrl(payload.assetPath, 3600); } catch (e) { if (!payload.assetUrl) throw e; }
  }
  return payload.assetUrl;
}

async function fail(job, state, error) {
  await finish(job, { state, error: String(error || '').slice(0, 300) });
  await jobRecord(job, { status: state === 'timed_out' ? 'timed_out' : /moderated|nsfw/i.test(String(error)) ? 'refused' : 'failed', error });
  if (RENDER_KINDS.includes(job.kind) && job.stage_id) {
    // the stage goes back to ready so the person can try again (domain: generating → failed → ready)
    const [s] = await queryRows('stages', `select=id,kind,state&id=eq.${q(job.stage_id)}&limit=1`);
    if (s && s.state === 'generating') await patchRows('stages', `id=eq.${q(s.id)}`, { state: 'ready' });
  }
}

async function pollRender(job) {
  const st = await higgsfield.status(job.provider_ref, job.payload.v || 0);
  if (st.status === 'completed' && !(st.video || (st.images && st.images.length))) {
    // the provider says done but handed back no media: that never improves with polling
    await fail(job, 'failed', 'provider reported completed without any output');
    return 'failed';
  }
  if (st.status === 'completed') {
    const meta = job.payload.meta || {};
    const stage = job.payload.stage;
    const isVideo = job.kind === 'higgsfield_video';
    const sourceUrl = isVideo ? st.video : st.images[0];
    // ADR-006: the finished asset is copied into the private bucket with its
    // checksum; the provider URL stays on the artifact for rendering in the
    // legacy page (the new pages read signed URLs from assetPath).
    let copy = null;
    try { copy = await storage.copyIn(sourceUrl, `pieces/${job.payload.pieceId}/${stage}`, isVideo ? 'video/mp4' : 'image/png'); }
    catch (e) { console.warn('[jobs] asset copy-in failed:', e.message); }
    const artifact = isVideo
      ? { version: meta.version || 'v1', dur: `${meta.dur || 5}s`, audio: 'Native audio — generated by Seedance 2.5', variants: [{ a: meta.ar || '16:9', l: meta.res || '720p', k: 'seedance', st: 'ready' }], videoUrl: sourceUrl, prompt: meta.prompt || '', note: meta.note || '', ...(stage === 'final' ? { qcRevised: true } : {}) }
      : { imageUrl: sourceUrl, prompt: meta.prompt || '', note: meta.note || '', ...(meta.title ? { title: meta.title, sub: meta.sub || '' } : {}) };
    if (copy) { artifact.assetPath = copy.path; artifact.sha256 = copy.sha256; artifact.size = copy.size; }
    // 6.2: an image SET (Soul batch) — every image copied in and listed. A batch
    // renders ONE prompt, so the images are variations of it: tagged as such
    // (a tile-per-facet tag would claim what was never asked for).
    if (!isVideo && st.images.length > 1) {
      const tagOf = (i) => (meta.setMode === 'variations' ? `variation ${i + 1}` : meta.direction && meta.direction.tiles && meta.direction.tiles[i] ? meta.direction.tiles[i].tag : null);
      artifact.images = [{ url: st.images[0], assetPath: copy ? copy.path : null, sha256: copy ? copy.sha256 : null, tag: tagOf(0) }];
      for (let i = 1; i < st.images.length; i++) {
        let c2 = null;
        try { c2 = await storage.copyIn(st.images[i], `pieces/${job.payload.pieceId}/${stage}`, 'image/png'); } catch (e) { console.warn('[jobs] asset copy-in failed:', e.message); }
        artifact.images.push({ url: st.images[i], assetPath: c2 ? c2.path : null, sha256: c2 ? c2.sha256 : null, tag: tagOf(i) });
      }
      if (meta.setMode) artifact.setMode = meta.setMode;
    }
    if (meta.direction) { artifact.direction = meta.direction; artifact.directionVersion = meta.directionVersion || null; }
    if (meta.overlay) { artifact.overlay = meta.overlay; artifact.textSide = meta.textSide || null; artifact.promptVersion = meta.promptVersion || null; artifact.moodApproved = Boolean(meta.moodApproved); }
    let recorded;
    try {
      // the stage is `generating`; recordVersion needs a non-approved stage and sets `generated`
      recorded = await recordVersion(job.payload.pieceId, stage, artifact, { producedBy: isVideo ? 'higgsfield_seedance' : 'higgsfield_soul', kind: isVideo ? 'video' : 'image', jobId: job.id, generatedBy: job.payload.generatedBy || null });
    } catch (e) {
      await finish(job, { state: 'failed', error: `result could not be recorded: ${String(e.message || e).slice(0, 200)}`, result: { artifact } });
      return 'failed';
    }
    await finish(job, { state: 'succeeded', error: null, result: { artifact, version: recorded.version, versionId: recorded.versionId, copiedIn: Boolean(copy) } });
    await jobRecord(job, { status: 'succeeded', outputAssets: (artifact.images || [{ url: sourceUrl, assetPath: copy ? copy.path : null, sha256: copy ? copy.sha256 : null }]).map((a) => ({ ...a, versionId: recorded.versionId })) });
    // 6.2: queue the automated visual check on the new version (never blocks the render)
    if (job.payload.autoCheck && !isVideo) {
      try {
        // the submitter says which images are meant to show the product; a
        // tile-per-facet set (legacy) is held to it only on its product tiles
        const tiles = meta.direction && Array.isArray(meta.direction.tiles) && meta.setMode !== 'variations' ? meta.direction.tiles : null;
        const expectProduct = meta.expectProduct !== undefined ? meta.expectProduct : tiles ? tiles.map((t, i) => (/product|device/i.test(`${t.tag} ${t.demonstrates}`) ? i : -1)).filter((i) => i >= 0) : Boolean(meta.product);
        await insertRows('jobs', [{ piece_id: job.piece_id, stage_id: job.stage_id, kind: 'vision_check', state: 'queued', attempts: 0, next_poll_at: nowIso(), payload: { pieceId: job.payload.pieceId, stage, versionId: recorded.versionId, images: (artifact.images || [{ url: sourceUrl, assetPath: artifact.assetPath || null }]).map((a, i) => ({ index: i, url: a.url, assetPath: a.assetPath || null })), direction: meta.direction || null, product: meta.product || null, productLook: meta.productLook || null, rules: meta.rules || [], expectProduct, anchors: meta.anchors || [], textSide: meta.textSide || null, generatedBy: job.payload.generatedBy || null } }]);
      } catch (e) { console.warn('[jobs] vision check could not be queued:', e.message); }
    }
    try { const { syncSpec } = require('./_spec.js'); await syncSpec(job.payload.pieceId, { memberId: job.payload.generatedBy || null, note: `${stage} rendered by job` }); } catch (e) { console.warn('[jobs] spec sync failed:', e.message); }
    return 'succeeded';
  }
  if (['failed', 'nsfw', 'canceled'].includes(st.status)) {
    await fail(job, 'failed', st.status === 'nsfw' ? 'moderated (nsfw) — nothing was generated' : `provider reported ${st.status}`);
    return 'failed';
  }
  await patchRows('jobs', `id=eq.${q(job.id)}`, { state: 'running', error: null });
  return 'running';
}

/** The automated visual check (6.2): one vision call over the version's images,
 *  stored as a stage_checks row; flags for the human, never a decision. */
async function runVisionCheck(job) {
  const { visionCheck } = require('./_studio/checks.js');
  const p = job.payload || {};
  const images = [];
  for (const im of p.images || []) {
    let url = im.url;
    if (im.assetPath) { try { url = await storage.signedUrl(im.assetPath, 3600); } catch (e) { /* provider URL stays */ } }
    if (url) images.push({ index: im.index, url });
  }
  if (!images.length) { await fail(job, 'failed', 'no images to check'); return 'failed'; }
  await patchRows('jobs', `id=eq.${q(job.id)}`, { state: 'running', error: null });
  const anchors = [];
  for (const a of p.anchors || []) {
    let url = a.url;
    if (a.assetPath) { try { url = await storage.signedUrl(a.assetPath, 3600); } catch (e) { /* provider URL stays */ } }
    if (url) anchors.push({ index: a.index, url });
  }
  const out = await visionCheck({ images, anchors, textSide: p.textSide, direction: p.direction, product: p.product, productLook: p.productLook, rules: p.rules, expectProduct: p.expectProduct, legacyPieceId: p.pieceId, stage: p.stage, jobId: job.id });
  if (out.error) { await fail(job, 'failed', out.error); return 'failed'; }
  try {
    await insertRows('stage_checks', [{ piece_id: job.piece_id, stage_id: job.stage_id, artifact_version_id: p.versionId, kind: 'vision', passed: out.passed, results: { images: out.results }, model: out.model, prompt_version: out.promptVersion, job_id: job.id }]);
  } catch (e) { console.warn('[jobs] stage_checks write failed:', e.message); }
  await finish(job, { state: 'succeeded', error: null, result: { passed: out.passed, images: out.results } });
  return 'succeeded';
}

async function pollQc(job) {
  const st = await f1x8.status(job.provider_ref);
  if (st.status === 'done' && st.result) {
    const R = { ...st.result };
    let heatmapPath = null;
    if (R.heatmap) {
      try {
        const bytes = Buffer.from(String(R.heatmap).replace(/^data:[^,]*,/, ''), 'base64');
        const put = await storage.putBlob(`pieces/${job.payload.pieceId}/${job.payload.stage}/heatmap-${job.id}.png`, bytes, R.heatmap_type || 'image/png');
        heatmapPath = put.path;
      } catch (e) { console.warn('[jobs] heatmap store failed:', e.message); }
      delete R.heatmap; delete R.heatmap_type;
    }
    // bind the result to the analysed stage's current version (qc_results)
    try {
      const [s] = await queryRows('stages', `select=id,current_version_id&id=eq.${q(job.stage_id)}&limit=1`);
      if (s && s.current_version_id) {
        await insertRows('qc_results', [{ artifact_version_id: s.current_version_id, job_id: job.id, provider: 'f1x8', score: typeof R.score === 'number' ? Math.round(R.score * 100) / 100 : null, result: R, heatmap_path: heatmapPath }]);
      }
    } catch (e) { console.warn('[jobs] qc_results insert failed:', e.message); }
    await finish(job, { state: 'succeeded', error: null, result: { analysis: R, heatmapPath, score: typeof R.score === 'number' ? R.score : null } });
    await jobRecord(job, { status: 'succeeded', outputAssets: [{ score: typeof R.score === 'number' ? R.score : null, heatmapPath }] });
    return 'succeeded';
  }
  if (st.status === 'error' || st.status === 'not_found') {
    await fail(job, 'failed', st.error || `F1X8 reported ${st.status}`);
    return 'failed';
  }
  await patchRows('jobs', `id=eq.${q(job.id)}`, { state: 'running', error: null, result: st.status ? { providerStatus: st.status } : null });
  return 'running';
}

/** The tick: advance every due row within a time budget. */
async function tick(budgetMs = 50000, limit = 25) {
  const t0 = Date.now();
  const due = await queryRows('jobs', `select=*&state=in.(queued,running)&next_poll_at=lte.${q(nowIso())}&order=next_poll_at.asc&limit=${limit}`);
  const out = { due: due.length, advanced: 0, states: {} };
  for (const j of due) {
    if (Date.now() - t0 > budgetMs) break;
    const st = await advance(j).catch((e) => `error: ${e.message}`);
    out.advanced++; out.states[st] = (out.states[st] || 0) + 1;
  }
  return out;
}

/** Jobs of one piece (newest first), advancing any that are due — the
 *  reconcile-on-open the page calls. */
async function jobsForPiece(legacyId, limit = 50) {
  const [p] = await queryRows('content_pieces', `select=id&legacy_id=eq.${q(legacyId)}&limit=1`);
  if (!p) return [];
  const rows = await queryRows('jobs', `select=*&piece_id=eq.${q(p.id)}&order=created_at.desc&limit=${limit}`);
  const out = [];
  for (const j of rows) {
    if (['queued', 'running'].includes(j.state)) { await advance(j).catch(() => {}); out.push(publicJob((await getJob(j.id)) || j, legacyId)); }
    else out.push(publicJob(j, legacyId));
  }
  return out;
}

module.exports = { KINDS, createJob, getJob, advance, tick, jobsForPiece, publicJob, POLL_S, TIMEOUT_S };
