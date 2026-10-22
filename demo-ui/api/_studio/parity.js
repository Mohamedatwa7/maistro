// Phase 6.9 — Hermes parity: an artifact pushed through POST /api/ingest gets
// the SAME automated checks as one made in the Studio. No path bypasses the
// quality gates:
//   - mood / thumb / board images → copied into the private bucket and a
//     vision_check job (the 6.2 check, product expected when the piece names one)
//   - brief → the 6.4 code checks (only possible on the structured contract;
//     a legacy-shaped brief is recorded as failing "structured brief missing")
//   - final video → copied in and an F1X8 analysis bound to the version
// When an asset cannot be copied (host outside the media allow-list, fetch
// failure) a failing stage_check says so — the push is never silently unchecked.
const storage = require('../_adapters/storage.js');
const { queryRows, insertRows } = require('../_supabase.js');

async function failCheck({ piece, stageRow, versionId, kind, reason }) {
  await insertRows('stage_checks', [{ piece_id: piece.id, stage_id: stageRow.id, artifact_version_id: versionId, kind, passed: false, results: { flags: [reason], source: 'ingest', passed: false } }]);
  return { kind, queued: false, reason };
}

async function queueChecks({ legacyId, stage, artifact, versionId, createJob }) {
  const [piece] = await queryRows('content_pieces', `select=id,product,markets,platforms&legacy_id=eq.${encodeURIComponent(legacyId)}&limit=1`);
  if (!piece) return [];
  const [stageRow] = await queryRows('stages', `select=id&piece_id=eq.${encodeURIComponent(piece.id)}&kind=eq.${stage}&limit=1`);
  if (!stageRow) return [];
  const out = [];
  if (['mood', 'thumb', 'board'].includes(stage) && artifact && artifact.imageUrl) {
    let copy;
    try { copy = await storage.copyIn(artifact.imageUrl, `pieces/${legacyId}/${stage}`, 'image/png'); }
    catch (e) { out.push(await failCheck({ piece, stageRow, versionId, kind: 'vision', reason: `pushed image could not be checked: ${String(e.message || e).slice(0, 160)}` })); return out; }
    const job = await createJob({ legacyId, stage, kind: 'vision_check', payload: { versionId, images: [{ index: 0, url: artifact.imageUrl, assetPath: copy.path }], product: piece.product || null, productLook: null, rules: [], expectProduct: Boolean(piece.product) && stage !== 'mood', source: 'ingest' } });
    out.push({ kind: 'vision', queued: true, jobId: job.id, assetPath: copy.path, sha256: copy.sha256 });
  }
  if (stage === 'brief') {
    if (!artifact || !artifact.spec) { out.push(await failCheck({ piece, stageRow, versionId, kind: 'copy', reason: 'structured brief missing — the claims, duration, hashtag, audio and Arabic checks need the brief contract (CONTENT_STUDIO.md 6.4)' })); }
    else {
      const briefMod = require('./brief.js');
      const problems = briefMod.validateShape(artifact.spec);
      if (problems.length) out.push(await failCheck({ piece, stageRow, versionId, kind: 'copy', reason: `brief contract invalid: ${problems.slice(0, 3).join('; ')}` }));
      else {
        const ctx = await briefMod.briefContext(piece, legacyId);
        const checks = briefMod.codeChecks(artifact.spec, ctx);
        const passed = checks.every((c) => c.passed);
        await insertRows('stage_checks', [{ piece_id: piece.id, stage_id: stageRow.id, artifact_version_id: versionId, kind: 'copy', passed, results: { codeChecks: checks, flags: checks.filter((c) => !c.passed).map((c) => `${c.code}: ${c.detail}`), passed, source: 'ingest', copy: null, copyNote: 'the model copy check runs on Studio briefs; pushed briefs get the code checks' }, prompt_version: briefMod.VERSION }]);
        out.push({ kind: 'copy', queued: false, passed });
      }
    }
  }
  if (stage === 'final' && artifact && artifact.videoUrl) {
    let copy;
    try { copy = await storage.copyIn(artifact.videoUrl, `pieces/${legacyId}/final`, 'video/mp4'); }
    catch (e) { out.push(await failCheck({ piece, stageRow, versionId, kind: 'spec', reason: `pushed video could not be checked: ${String(e.message || e).slice(0, 160)}` })); return out; }
    const job = await createJob({ legacyId, stage: 'final', kind: 'f1x8_video', payload: { assetPath: copy.path, expectSha256: copy.sha256, versionId, title: `Hermes final for ${legacyId}`, description: 'Final cut pushed by the external Hermes agent.', source: 'ingest' } });
    out.push({ kind: 'f1x8', queued: true, jobId: job.id, assetPath: copy.path, sha256: copy.sha256 });
  }
  return out;
}

module.exports = { queueChecks };
