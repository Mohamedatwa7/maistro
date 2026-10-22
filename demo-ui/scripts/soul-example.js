// DISABLED (owner decision 2026-10-22): no Higgsfield spend for testing. Real renders happen only when a person
// generates a piece in the Studio. This script renders, so it refuses to run. (tests/api/no-paid-renders.test.js)
console.error('Disabled: paid Higgsfield renders from scripts are not authorised (owner, 2026-10-22).'); process.exit(1);
// Higgsfield Soul v2 text-to-image shape check.
// Run: node --env-file=.env.local scripts/soul-example.js   (one billable image)
const { config, higgsfield } = require('@higgsfield/client/v2');

async function main() {
  config({ credentials: process.env.HF_CREDENTIALS });
  const result = await higgsfield.subscribe('higgsfield-ai/soul/v2/standard', {
    input: { prompt: 'Minimal product moodboard collage, dark premium palette', aspect_ratio: '16:9', resolution: '720p', batch_size: 1 },
    withPolling: true,
  });
  console.log('status:', result.status);
  console.log('keys:', Object.keys(result));
  console.log('images:', JSON.stringify(result.images, null, 2).slice(0, 800));
}
main().catch((e) => { console.error('failed:', e.message); process.exit(1); });
