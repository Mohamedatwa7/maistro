// DISABLED (owner decision 2026-10-22): no Higgsfield spend for testing. Real renders happen only when a person
// generates a piece in the Studio. This script renders, so it refuses to run. (tests/api/no-paid-renders.test.js)
console.error('Disabled: paid Higgsfield renders from scripts are not authorised (owner, 2026-10-22).'); process.exit(1);
// Probe: does /v1/text2image/soul accept a strength for image_reference?
// FastAPI validation errors reveal the schema without spending a render.
async function probe(extra, label) {
  const r = await fetch('https://api.higgsfield.ai/v1/text2image/soul', {
    method: 'POST',
    headers: { Authorization: `Key ${process.env.HF_CREDENTIALS}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ params: {
      prompt: 'x', width_and_height: 'BAD_ON_PURPOSE', quality: '1080p', batch_size: 1,
      image_reference: { type: 'image_url', image_url: 'https://example.com/x.png' },
      ...extra,
    } }),
  });
  const d = await r.json().catch(() => ({}));
  console.log(label, '→', r.status, JSON.stringify(d).slice(0, 300));
}
(async () => {
  await probe({ image_reference_strength: 0.9 }, 'image_reference_strength');
  await probe({ reference_strength: 0.9 }, 'reference_strength');
  await probe({ style_strength: 0.9 }, 'style_strength');
})();
