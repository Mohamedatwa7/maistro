// Poll the v1 job-set from soul-ref-test and print the result shape.
const SET = process.argv[2] || 'f616d7bc-b97c-4aa1-a770-f5fd5a034e19';
async function main() {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`https://platform.higgsfield.ai/v1/job-sets/${SET}`, {
      headers: { Authorization: `Key ${process.env.HF_CREDENTIALS}` },
    }).catch(() => null);
    const r2 = r && r.ok ? r : await fetch(`https://api.higgsfield.ai/v1/job-sets/${SET}`, {
      headers: { Authorization: `Key ${process.env.HF_CREDENTIALS}` },
    });
    const d = await r2.json();
    const st = (d.jobs || []).map((j) => j.status).join(',');
    if (/completed|failed|nsfw|canceled/.test(st)) {
      console.log('statuses:', st);
      console.log(JSON.stringify(d.jobs, null, 1).slice(0, 900));
      return;
    }
    console.log('…', st || JSON.stringify(d).slice(0, 120));
    await new Promise((x) => setTimeout(x, 8000));
  }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
