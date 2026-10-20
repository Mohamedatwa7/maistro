// Verify the F1X8 async image flow + response shape with a real generated asset.
const BASE = 'https://mohamedymay7--fixation-api-fastapi-app.modal.run';
const ASSET = 'https://d3u0tzju9qaucj.cloudfront.net/9bb1fc65-397b-48aa-8a7f-68f454ceb695/335bd254-32b8-4081-85d3-e30cf88f3cfd.png';

async function main() {
  const ar = await fetch(ASSET);
  const buf = await ar.arrayBuffer();
  console.log('asset bytes:', buf.byteLength);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'image/png' }), 'asset.png');
  form.append('title', 'Deadpan Reveal — moodboard');
  form.append('description', 'Campaign: Deadpan Reveal for Bespoke AI Fridge. Key message: The punchline chills here. Angle: setup line then deadpan punchline caption reveal. Markets: UAE, KSA. Platform: TikTok.');
  form.append('format_type', 'social');
  form.append('role', 'creative_director');
  const r = await fetch(BASE + '/api/analyze/image/submit', { method: 'POST', body: form });
  const d = await r.json();
  console.log('submit:', JSON.stringify(d));
  if (!d.job_id) process.exit(1);
  for (let i = 0; i < 120; i++) {
    await new Promise((x) => setTimeout(x, 10000));
    const jr = await fetch(`${BASE}/api/job/${d.job_id}`);
    const jd = await jr.json();
    if (jd.status === 'done') {
      const R = jd.result;
      console.log('SCORE:', R.score, '| funnel:', R.funnel_stage, '| tier:', R.product_tier);
      console.log('KPIs:', Object.entries(R.kpis).map(([k, v]) => `${k}=${v.score}`).join(' '));
      console.log('context_score:', R.context_score);
      console.log('strengths:', (R.verdict.strengths || []).length, '| risks:', (R.verdict.risks || []).length);
      console.log('revision_brief keys:', Object.keys(R.verdict.revision_brief || {}).join(','));
      console.log('heatmap:', R.heatmap ? (R.heatmap.length + ' b64 chars, ' + R.heatmap_type) : 'none');
      console.log('summary:', (R.verdict.summary || '').slice(0, 200));
      return;
    }
    if (jd.status === 'error' || jd.status === 'not_found') { console.log('FAILED:', JSON.stringify(jd).slice(0, 400)); process.exit(1); }
    console.log('…', jd.status);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
