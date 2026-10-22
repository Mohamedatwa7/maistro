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
const jobRecord = (job, extra) => recordGeneration({ kind: job.kind.startsWith('higgsfield') ? job.kind : job.kind === 'assemble' ? 'assemble' : 'f1x8', legacyPieceId: job.payload && job.payload.pieceId, pieceId: job.piece_id || null, stage: job.payload && job.payload.stage, promptName: job.kind.startsWith('higgsfield') ? 'director.prompt' : job.kind === 'assemble' ? 'assemble.ffmpeg' : 'f1x8.analysis', promptVersion: null, resolvedPrompt: job.payload && (job.payload.prompt || job.payload.description) || null, params: { aspect_ratio: job.payload && job.payload.aspect_ratio, resolution: job.payload && job.payload.resolution, duration: job.payload && job.payload.duration, ref: Boolean(job.payload && job.payload.ref), v: job.payload && job.payload.v, seed: job.payload && job.payload.seed != null ? job.payload.seed : null }, inputAssets: job.payload && (job.payload.ref || job.payload.assetUrl || job.payload.assetPath) ? [job.payload.ref || job.payload.assetPath || job.payload.assetUrl] : [], jobId: job.id, memberId: job.payload && job.payload.generatedBy, correlationId: job.payload && job.payload.correlationId, latencyMs: job.started_at ? Date.now() - new Date(job.started_at).getTime() : null, costUsd: job.estimate_usd != null ? (extra && extra.status === 'succeeded' ? Number(job.estimate_usd) : 0) : undefined, ...extra });

const q = (v) => encodeURIComponent(String(v));
const KINDS = ['higgsfield_image', 'higgsfield_video', 'f1x8_image', 'f1x8_video', 'vision_check', 'assemble', 'clip_check'];
const RENDER_KINDS = ['higgsfield_image', 'higgsfield_video'];
const KIND_STAGE = { higgsfield_image: ['mood', 'thumb', 'board'], higgsfield_video: ['draft', 'final'], f1x8_image: ['mood', 'thumb', 'board'], f1x8_video: ['draft', 'final'], vision_check: ['mood', 'thumb', 'board', 'draft', 'final'], assemble: ['draft', 'final'], clip_check: ['draft', 'final'] };
// How long to wait before asking again, and when to give up (seconds).
// the vision_check claim window must exceed the bounded model call (90 s) so a
// second tick cannot re-claim a check that is still running
// assemble and clip_check run ffmpeg inside one invocation: their claim windows exceed the
// longest run (the function limit is 300 s) so a second tick can never double-claim them
const POLL_S = { higgsfield_image: 20, higgsfield_video: 45, f1x8_image: 60, f1x8_video: 90, vision_check: 150, assemble: 290, clip_check: 200 };
const TIMEOUT_S = { higgsfield_image: 15 * 60, higgsfield_video: 20 * 60, f1x8_image: 30 * 60, f1x8_video: 45 * 60, vision_check: 10 * 60, assemble: 15 * 60, clip_check: 10 * 60 };
const MAX_SUBMIT_ATTEMPTS = 3;

const nowIso = () => new Date().toISOString();
const plusS = (s) => new Date(Date.now() + s * 1000).toISOString();

function publicJob(j, legacyId) {
  return {
    id: j.id, kind: j.kind, state: j.state, stage: j.payload && j.payload.stage, pieceId: legacyId || (j.payload && j.payload.pieceId) || null,
    providerRef: j.provider_ref || null, attempts: j.attempts, result: j.result || null, error: j.error || null,
    estimateUsd: j.estimate_usd != null ? Number(j.estimate_usd) : null, budgetWarning: (j.payload && j.payload.budgetWarning) || null, createdAt: j.created_at, startedAt: j.started_at || null, finishedAt: j.finished_at || null, nextPollAt: j.next_poll_at || null,
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
    if (!job.provider_ref && job.kind === 'clip_check') return await runClipCheck(job);
    if (!job.provider_ref && job.kind === 'assemble') return await runAssemble(job);
    if (!job.provider_ref) {
      const attempts = (job.attempts || 0) + 1;
      if (attempts > MAX_SUBMIT_ATTEMPTS) { await fail(job, 'failed', job.error || 'submit failed repeatedly'); return 'failed'; }
      await patchRows('jobs', `id=eq.${q(job.id)}`, { attempts });
      try {
        // 6.9: price the exact body before submitting and hold the piece to its budget
        if (job.kind.startsWith('higgsfield') && job.estimate_usd == null && !job.payload.budgetChecked) {
          const gate = await budgetGate(job);
          if (gate.refuse) { if (gate.estimateUsd != null) { await patchRows('jobs', `id=eq.${q(job.id)}`, { estimate_usd: gate.estimateUsd }); job = { ...job, estimate_usd: gate.estimateUsd }; } await fail(job, 'failed', gate.refuse); return 'failed'; }
          job = { ...job, estimate_usd: gate.estimateUsd, payload: { ...job.payload, budgetChecked: true, ...(gate.warning ? { budgetWarning: gate.warning } : {}) } };
          await patchRows('jobs', `id=eq.${q(job.id)}`, { estimate_usd: gate.estimateUsd, payload: job.payload });
        }
        // 6.6: a clip job names its keyframe by private path; the signed URL is minted once
        // (24 h) and kept on the job so the idempotent body is identical on every retry
        if (job.kind === 'higgsfield_video' && job.payload.imageAssetPath && !job.payload.imageUrl) {
          const imageUrl = await storage.signedUrl(job.payload.imageAssetPath, 24 * 3600);
          job = { ...job, payload: { ...job.payload, imageUrl } };
          await patchRows('jobs', `id=eq.${q(job.id)}`, { payload: job.payload });
        }
        const sub = job.kind.startsWith('higgsfield')
          ? await higgsfield.submit({ ...job.payload, kind: job.kind === 'higgsfield_image' ? 'image' : 'video' }, { idempotencyKey: job.id })
          : await f1x8.submit({ kind: job.kind === 'f1x8_video' ? 'video' : 'image', assetUrl: await assetUrlFor(job.payload), title: job.payload.title, description: job.payload.description, expectSha256: job.payload.expectSha256 || null });
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
  if (job.payload && job.payload.attachTo && RENDER_KINDS.includes(job.kind)) {
    // 6.5: a failed keyframe marks its shot; the other shots keep rendering
    try {
      const { versionId, shot } = job.payload.attachTo;
      const slot = job.kind === 'higgsfield_video' ? 'clip' : 'keyframe';
      await updateShots(versionId, (payload) => {
        if (!Array.isArray(payload.shots) || !payload.shots[shot - 1]) return null;
        const shots = payload.shots.map((s) => ({ ...s }));
        const prev = shots[shot - 1][slot];
        shots[shot - 1] = { ...shots[shot - 1], [slot]: prev && prev.state === 'rendered' ? { ...prev, lastError: String(error || '').slice(0, 200) } : { state: 'failed', error: String(error || '').slice(0, 200), jobId: job.id, at: nowIso() } };
        return { ...payload, shots };
      });
    } catch (e) { console.warn('[jobs] shot failure could not be recorded:', e.message); }
    await settleBoardStage(job);
    return;
  }
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
    // 6.5: a storyboard keyframe fills a shot slot on an existing version instead of making a new one
    if (job.payload.attachTo) return attachKeyframe(job, { artifact, sourceUrl, copy, meta, stage, slot: isVideo ? 'clip' : 'keyframe' });
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

/** 6.9: the piece's budget — cap from the piece or MAISTRO_PIECE_BUDGET_USD (default 25), warning at
 *  budget_warn_pct. Spent = estimates of succeeded renders; committed = queued/running renders already
 *  priced; failed / moderated / canceled renders are not charged by Higgsfield and do not count. */
async function pieceBudget(pieceId) {
  const [p] = await queryRows('content_pieces', `select=id,budget_usd,budget_warn_pct&id=eq.${q(pieceId)}&limit=1`);
  const capUsd = p && p.budget_usd != null ? Number(p.budget_usd) : Number(process.env.MAISTRO_PIECE_BUDGET_USD || 25);
  const warnPct = p && p.budget_warn_pct ? Number(p.budget_warn_pct) : 80;
  const rows = await queryRows('jobs', `select=id,state,estimate_usd,kind&piece_id=eq.${q(pieceId)}&estimate_usd=not.is.null&limit=1000`);
  const sum = (f) => Math.round(rows.filter(f).reduce((a, r) => a + Number(r.estimate_usd || 0), 0) * 10000) / 10000;
  return { capUsd, warnPct, spentUsd: sum((r) => r.state === 'succeeded'), committedUsd: sum((r) => r.state === 'queued' || r.state === 'running'), jobs: rows.length };
}

async function budgetGate(job) {
  let estimateUsd = null;
  try { const e = await higgsfield.estimateRequest({ ...job.payload, kind: job.kind === 'higgsfield_image' ? 'image' : 'video' }); estimateUsd = e ? Math.round(e.usd * 10000) / 10000 : null; }
  catch (e) { console.warn('[jobs] estimate failed:', e.message); }
  const b = await pieceBudget(job.piece_id);
  const after = b.spentUsd + b.committedUsd + (estimateUsd || 0);
  if (estimateUsd != null && b.capUsd > 0 && after > b.capUsd) return { refuse: `budget cap: this render (~$${estimateUsd.toFixed(2)}) would take the piece to $${after.toFixed(2)} of its $${b.capUsd.toFixed(2)} cap — raise the budget to continue`, estimateUsd };
  const warning = b.capUsd > 0 && after >= b.capUsd * b.warnPct / 100 ? `piece at $${after.toFixed(2)} of $${b.capUsd.toFixed(2)} (${Math.round(after / b.capUsd * 100)} %)` : null;
  return { estimateUsd, warning };
}

/** 6.5: change a version's `payload.shots` under an optimistic revision. Readers that run
 *  in separate invocations (the tick, GET ?id= polls, the page's decisions) each read,
 *  mutate one shot and write back; the PATCH is filtered on the revision they read, so a
 *  concurrent writer makes it return zero rows and the change is re-applied on a fresh
 *  read (the same pattern as claim()). `mutate(payload)` returns the new payload or null
 *  to abort. Resolves {payload, rev} or throws after `attempts`. */
async function updateShots(versionId, mutate, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    const [v] = await queryRows('artifact_versions', `select=id,payload&id=eq.${q(versionId)}&limit=1`);
    if (!v) throw new Error(`version ${versionId} not found`);
    const seen = v.payload && v.payload.rev != null ? Number(v.payload.rev) : null;
    const next = mutate(v.payload || {});
    if (next === null) return { payload: v.payload, rev: seen, unchanged: true };
    const payload = { ...next, rev: (seen || 0) + 1 };
    const filter = seen == null ? 'payload->>rev=is.null' : `payload->>rev=eq.${seen}`;
    const rows = await patchRows('artifact_versions', `id=eq.${q(versionId)}&${filter}`, { payload });
    if (rows.length) return { payload, rev: payload.rev };
    await new Promise((r) => setTimeout(r, 25 + Math.floor(Math.random() * 50)));
  }
  throw new Error(`version ${versionId}: payload changed concurrently ${attempts} times`);
}

/** 6.5: no render job left alive on the stage → the storyboard is `generated` again. */
async function settleBoardStage(job) {
  const rows = await queryRows('jobs', `select=id,kind&stage_id=eq.${q(job.stage_id)}&state=in.(queued,running)&limit=50`);
  const live = rows.filter((r) => RENDER_KINDS.includes(r.kind) && r.id !== job.id);
  if (live.length) return false;
  const [s] = await queryRows('stages', `select=id,state&id=eq.${q(job.stage_id)}&limit=1`);
  if (s && s.state === 'generating') await patchRows('stages', `id=eq.${q(s.id)}`, { state: 'generated' });
  return true;
}

/** 6.5: write a rendered keyframe into `payload.shots[n-1].keyframe` of the storyboard
 *  version named by the job, keep the previous keyframe in the shot's history, queue the
 *  vision check (anchored to the selected mood tiles and the previous shot's keyframe) and,
 *  on the hook shot, the lightweight F1X8 check. The version number does not change. */
async function attachKeyframe(job, { artifact, sourceUrl, copy, meta, stage, slot = 'keyframe' }) {
  const { versionId, shot } = job.payload.attachTo;
  const history = `${slot}History`;
  const keyframe = { state: 'rendered', url: sourceUrl, assetPath: copy ? copy.path : null, sha256: copy ? copy.sha256 : null, size: copy ? copy.size : null, jobId: job.id, prompt: meta.prompt || '', seed: job.payload.seed != null ? job.payload.seed : null, v: job.payload.v || 0, at: nowIso(), ...(slot === 'clip' ? { durationS: job.payload.duration || null, resolution: job.payload.resolution || null, fromKeyframe: job.payload.imageAssetPath || null } : {}) };
  let shots = null;
  try {
    const r = await updateShots(versionId, (payload) => {
      if (!Array.isArray(payload.shots) || !payload.shots[shot - 1]) return null;
      const next = payload.shots.map((s) => ({ ...s }));
      const prev = next[shot - 1][slot];
      next[shot - 1] = { ...next[shot - 1], [slot]: keyframe, [history]: [...(next[shot - 1][history] || []), ...(prev && prev.state === 'rendered' ? [prev] : [])], review: null };
      return { ...payload, shots: next };
    });
    if (r.unchanged) { await fail(job, 'failed', `storyboard version or shot ${shot} not found`); return 'failed'; }
    shots = r.payload.shots;
  } catch (e) { await fail(job, 'failed', `keyframe could not be attached: ${String(e.message || e).slice(0, 160)}`); return 'failed'; }
  await finish(job, { state: 'succeeded', error: null, result: { attached: { versionId, shot, slot }, [slot]: keyframe, copiedIn: Boolean(copy) } });
  await jobRecord(job, { status: 'succeeded', outputAssets: [{ url: sourceUrl, assetPath: keyframe.assetPath, sha256: keyframe.sha256, versionId, shot }] });
  if (job.payload.autoCheck && slot === 'keyframe') {
    try {
      const prevShot = shot > 1 ? shots[shot - 2] : null;
      const anchors = [...(meta.anchors || []), ...(prevShot && prevShot.keyframe && prevShot.keyframe.state === 'rendered' ? [{ index: shot - 2, url: prevShot.keyframe.url, assetPath: prevShot.keyframe.assetPath, label: `previous shot ${shot - 1} keyframe — the same product, character, setting and lighting are expected` }] : [])];
      await insertRows('jobs', [{ piece_id: job.piece_id, stage_id: job.stage_id, kind: 'vision_check', state: 'queued', attempts: 0, next_poll_at: nowIso(), payload: { pieceId: job.payload.pieceId, stage, versionId, shot, images: [{ index: shot, url: sourceUrl, assetPath: keyframe.assetPath }], direction: meta.direction || null, product: meta.product || null, productLook: meta.productLook || null, rules: meta.rules || [], expectProduct: Boolean(meta.expectProduct), anchors, textSide: null, generatedBy: job.payload.generatedBy || null } }]);
    } catch (e) { console.warn('[jobs] vision check could not be queued:', e.message); }
  }
  if (job.payload.autoCheck && slot === 'clip' && keyframe.assetPath) {
    // 6.6 (b): frames of the clip go to the vision check with the keyframe as the anchor
    try { await insertRows('jobs', [{ piece_id: job.piece_id, stage_id: job.stage_id, kind: 'clip_check', state: 'queued', attempts: 0, next_poll_at: nowIso(), payload: { pieceId: job.payload.pieceId, stage, versionId, shot, clipAssetPath: keyframe.assetPath, keyframeAssetPath: job.payload.imageAssetPath || null, product: meta.product || null, productLook: meta.productLook || null, rules: meta.rules || [], expectProduct: Boolean(meta.expectProduct), generatedBy: job.payload.generatedBy || null } }]); }
    catch (e) { console.warn('[jobs] clip check could not be queued:', e.message); }
  }
  if (meta.hookCheck && slot === 'keyframe' && keyframe.assetPath) {
    try { await insertRows('jobs', [{ piece_id: job.piece_id, stage_id: job.stage_id, kind: 'f1x8_image', state: 'queued', attempts: 0, next_poll_at: nowIso(), payload: { pieceId: job.payload.pieceId, stage, assetPath: keyframe.assetPath, title: meta.title || 'storyboard hook', description: `Storyboard hook keyframe (shot ${shot})`, hookCheck: true, versionId, generatedBy: job.payload.generatedBy || null } }]); }
    catch (e) { console.warn('[jobs] hook check could not be queued:', e.message); }
  }
  await settleBoardStage(job);
  try { const { syncSpec } = require('./_spec.js'); await syncSpec(job.payload.pieceId, { memberId: job.payload.generatedBy || null, note: `${stage} shot ${shot} ${slot}` }); } catch (e) { /* best effort */ }
  return 'succeeded';
}

/** Download a private asset to a file (signed URL → bytes). */
async function fetchToFile(assetPath, file) {
  const url = await storage.signedUrl(assetPath, 3600);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`asset ${assetPath} could not be fetched (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  require('node:fs').writeFileSync(file, buf);
  return buf.length;
}

/** 6.6 (b): three frames of one clip → the vision check in clip mode (product stability,
 *  morphing, artefacts) with the source keyframe as the anchor. */
async function runClipCheck(job) {
  const A = require('./_studio/assemble.js');
  const { visionCheck } = require('./_studio/checks.js');
  const fs = require('node:fs'); const path = require('node:path');
  const p = job.payload || {};
  await patchRows('jobs', `id=eq.${q(job.id)}`, { state: 'running', error: null });
  const dir = A.tmpDir('maistro-clip-');
  try {
    const clip = path.join(dir, 'clip.mp4');
    await fetchToFile(p.clipAssetPath, clip);
    const { frames, probe } = await A.extractFrames(clip, dir);
    const images = [];
    for (const f of frames) {
      const put = await storage.putBlob(`pieces/${p.pieceId}/${p.stage}/frames-${p.shot}-${f.index}-${job.id.slice(0, 8)}.png`, fs.readFileSync(f.file), 'image/png');
      images.push({ index: f.index, url: await storage.signedUrl(put.path, 3600), assetPath: put.path, t: f.t });
    }
    const anchors = [];
    if (p.keyframeAssetPath) { try { anchors.push({ index: 0, url: await storage.signedUrl(p.keyframeAssetPath, 3600), label: `source keyframe of shot ${p.shot} — the clip must keep this product, character, setting and lighting` }); } catch (e) { /* no anchor */ } }
    const out = await visionCheck({ images: images.map((i) => ({ index: i.index, url: i.url })), anchors, mode: 'clip', product: p.product, productLook: p.productLook, rules: p.rules, expectProduct: p.expectProduct, legacyPieceId: p.pieceId, stage: p.stage, jobId: job.id });
    if (!Array.isArray(out.results)) { await fail(job, 'failed', out.error || 'clip check failed'); return 'failed'; }
    const results = { images: out.results, shot: p.shot, frames: images.map((i) => ({ index: i.index, t: i.t, assetPath: i.assetPath })), clip: { durationS: probe.durationS, width: probe.width, height: probe.height, fps: probe.fps, hasAudio: probe.hasAudio } };
    await insertRows('stage_checks', [{ piece_id: job.piece_id, stage_id: job.stage_id, artifact_version_id: p.versionId, kind: 'vision', passed: out.passed, results, model: out.model || null, prompt_version: out.promptVersion || null, job_id: job.id }]);
    await finish(job, { state: 'succeeded', error: null, result: { shot: p.shot, passed: out.passed, flags: results.images.flatMap((i) => i.flags || []) } });
    return 'succeeded';
  } catch (e) { await fail(job, 'failed', `clip check: ${String(e.message || e).slice(0, 240)}`); return 'failed'; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* tmp */ } }
}

/** 6.6 (b): assemble the approved clips of a draft version into one cut (ffmpeg), store it
 *  in the private bucket, record it on the version (assembled + assetPath/sha256), run the
 *  assembled checks and hand the whole artifact back as the job result. */
async function runAssemble(job) {
  const A = require('./_studio/assemble.js');
  const fs = require('node:fs'); const path = require('node:path');
  const p = job.payload || {};
  await patchRows('jobs', `id=eq.${q(job.id)}`, { state: 'running', error: null });
  const [v] = await queryRows('artifact_versions', `select=id,version,payload&id=eq.${q(p.versionId)}&limit=1`);
  if (!v || !Array.isArray(v.payload.shots)) { await fail(job, 'failed', 'draft version not found'); return 'failed'; }
  const shots = v.payload.shots;
  const notReady = shots.filter((s) => !(s.clip && s.clip.state === 'rendered' && s.clip.assetPath) || !(s.review && s.review.decision === 'approved')).map((s) => s.n);
  if (notReady.length) { await fail(job, 'failed', `shots not approved or not rendered: ${notReady.join(', ')}`); return 'failed'; }
  const dir = A.tmpDir('maistro-cut-');
  try {
    const inputs = [];
    for (const s of shots) {
      const file = path.join(dir, `clip-${s.n}.mp4`); await fetchToFile(s.clip.assetPath, file);
      let overlayFile = null;
      if (s.overlay && s.overlay.assetPath) { overlayFile = path.join(dir, `ov-${s.n}.png`); await fetchToFile(s.overlay.assetPath, overlayFile); }
      inputs.push({ n: s.n, file, trimS: Number(s.durationS) || undefined, transition: s.transition || 'cut', overlayFile });
    }
    const out = path.join(dir, 'cut.mp4');
    const r = await A.assemble({ shots: inputs, aspect: v.payload.aspect || '9:16', resolution: v.payload.resolution || '720p', out });
    const put = await storage.putBlob(`pieces/${p.pieceId}/${p.stage}/cut-${job.id.slice(0, 8)}.mp4`, fs.readFileSync(out), 'video/mp4');
    const assembled = { assetPath: put.path, sha256: r.sha256, size: r.size, durationS: r.durationS, expectedS: r.expectedS, width: r.width, height: r.height, fps: r.fps, hasAudio: r.hasAudio, loudness: r.loudness, transitions: r.transitions, overlays: inputs.filter((i) => i.overlayFile).map((i) => i.n), jobId: job.id, at: nowIso(), version: `v${v.version}` };
    const checks = A.assembledChecks(r, { targetS: p.targetS || v.payload.totalS || null, shots });
    const passed = checks.every((c) => c.passed);
    const upd = await updateShots(v.id, (payload) => ({ ...payload, assembled, assetPath: put.path, sha256: r.sha256, size: r.size, videoUrl: null, dur: `${r.durationS}s`, variants: (payload.variants || []).map((x) => ({ ...x, st: 'ready' })), audio: `Native clip audio, loudnorm ${r.loudness.I} LUFS / ${r.loudness.TP} dBTP`, assembledChecks: checks }));
    await insertRows('stage_checks', [{ piece_id: job.piece_id, stage_id: job.stage_id, artifact_version_id: v.id, kind: 'spec', passed, results: { codeChecks: checks, flags: checks.filter((c) => !c.passed).map((c) => `${c.code}: ${c.detail}`), passed, assembled }, job_id: job.id }]);
    await finish(job, { state: 'succeeded', error: null, result: { artifact: { ...upd.payload, version: `v${v.version}` }, version: v.version, versionId: v.id, assembled, checks } });
    await jobRecord(job, { status: 'succeeded', outputAssets: [{ assetPath: put.path, sha256: r.sha256, versionId: v.id }], latencyMs: Date.now() - new Date(job.started_at || job.created_at).getTime() });
    try { const { syncSpec } = require('./_spec.js'); await syncSpec(p.pieceId, { memberId: p.generatedBy || null, note: 'draft assembled' }); } catch (e) { /* best effort */ }
    return 'succeeded';
  } catch (e) { await fail(job, 'failed', `assembly: ${String(e.message || e).slice(0, 280)}`); return 'failed'; }
  finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* tmp */ } }
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
    if (url) anchors.push({ index: a.index, url, label: a.label || null });
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
    // bind the result to the analysed version: the one named on the job (6.7), else the stage's current one
    try {
      const [s] = await queryRows('stages', `select=id,current_version_id&id=eq.${q(job.stage_id)}&limit=1`);
      const vid = job.payload.versionId || (s && s.current_version_id);
      if (vid) {
        await insertRows('qc_results', [{ artifact_version_id: vid, job_id: job.id, provider: 'f1x8', score: typeof R.score === 'number' ? Math.round(R.score * 100) / 100 : null, result: R, heatmap_path: heatmapPath }]);
      }
    } catch (e) { console.warn('[jobs] qc_results insert failed:', e.message); }
    // finish FIRST: the report below takes a model call and provider estimates, and a finished
    // row can never be re-claimed by an overlapping tick
    await finish(job, { state: 'succeeded', error: null, result: { analysis: R, heatmapPath, score: typeof R.score === 'number' ? R.score : null } });
    await jobRecord(job, { status: 'succeeded', outputAssets: [{ score: typeof R.score === 'number' ? R.score : null, heatmapPath }] });
    if (job.payload.verifyFinal) {
      try {
        const finalMod = require('./_studio/final.js');
        const [fvr] = await queryRows('artifact_versions', `select=id,payload&id=eq.${q(job.payload.versionId)}&limit=1`);
        const [qvr] = job.payload.qcVersionId ? await queryRows('artifact_versions', `select=payload&id=eq.${q(job.payload.qcVersionId)}&limit=1`) : [];
        const report = qvr && qvr.payload && qvr.payload.report;
        if (fvr && report) {
          const vr = await finalMod.verifyRisks({ report, applied: fvr.payload.applied || [], notApplied: fvr.payload.notApplied || [], analysis: R, legacyId: job.payload.pieceId, memberId: job.payload.generatedBy || null });
          const verification = { score: typeof R.score === 'number' ? R.score : null, scoreBefore: report.score, risks: vr.risks || [], unresolved: (vr.risks || []).filter((r) => r.resolved !== 'yes').map((r) => r.ref), notApplied: fvr.payload.notApplied || [], error: vr.error || null, model: vr.model || null, version: finalMod.VERIFY_VERSION, cutSha256: job.payload.expectSha256, at: nowIso() };
          await updateShots(fvr.id, (payload) => ({ ...payload, verification }));
        }
      } catch (e) { await patchRows('jobs', `id=eq.${q(job.id)}`, { error: `verification: ${String(e.message || e).slice(0, 240)}` }); }
    }
    if (job.payload.qcReport) {
      try {
        const qc = require('./_studio/qc.js');
        const { recordVersion } = require('./_store.js');
        const report = await qc.buildReport({ analysis: R, heatmapPath, pieceId: job.piece_id, legacyId: job.payload.pieceId, draftVersionId: job.payload.versionId, draftSha256: job.payload.expectSha256, memberId: job.payload.generatedBy || null, estimate: higgsfield.estimate });
        const rec = await recordVersion(job.payload.pieceId, 'qc', { real: true, report, runs: { draft: { score: report.score, verdict: { summary: report.summary, risks: report.f1x8.risks, revision_brief: report.f1x8.revisionBrief } } }, avg: report.score }, { producedBy: 'f1x8', kind: 'qc_report', jobId: job.id, generatedBy: job.payload.generatedBy || null });
        await patchRows('jobs', `id=eq.${q(job.id)}`, { result: { analysis: R, heatmapPath, score: report.score, report: { versionId: rec.versionId, version: rec.version } } });
        try { const { syncSpec } = require('./_spec.js'); await syncSpec(job.payload.pieceId, { memberId: job.payload.generatedBy || null, note: 'QC report' }); } catch (e) { /* best effort */ }
      } catch (e) {
        console.warn('[jobs] QC report failed:', e.message);
        await patchRows('jobs', `id=eq.${q(job.id)}`, { error: `QC report: ${String(e.message || e).slice(0, 240)}` });
      }
    }
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

module.exports = { KINDS, createJob, getJob, advance, tick, jobsForPiece, publicJob, settleBoardStage, updateShots, pieceBudget, POLL_S, TIMEOUT_S };
