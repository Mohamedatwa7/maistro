// DISABLED (owner decision 2026-10-22): no Higgsfield spend for testing. Real renders happen only when a person
// generates a piece in the Studio. This script renders, so it refuses to run. (tests/api/no-paid-renders.test.js)
console.error('Disabled: paid Higgsfield renders from scripts are not authorised (owner, 2026-10-22).'); process.exit(1);
// Higgsfield SDK example — Seedance 2.5 text-to-video.
// Run: node --env-file=.env.local scripts/seedance-example.js
// Makes ONE billable generation request and prints the video URL.
const { config, higgsfield } = require('@higgsfield/client/v2');

async function main() {
  if (!process.env.HF_CREDENTIALS) {
    console.error('HF_CREDENTIALS is not set — add it to .env.local (key-id:key-secret).');
    process.exit(1);
  }
  config({ credentials: process.env.HF_CREDENTIALS });

  const result = await higgsfield.subscribe('bytedance/seedance-2.5/text-to-video', {
    input: {
      prompt: 'A cinematic scene at sunset',
      duration: 5,
      resolution: '720p',
      aspect_ratio: '16:9',
    },
    withPolling: true,
  });

  if (result.status === 'completed') {
    const url = result.video?.url || result.video;
    if (!url) {
      console.error('Completed but no video URL in result:', JSON.stringify(result));
      process.exit(1);
    }
    console.log('VIDEO URL:', url);
  } else {
    // failed / canceled / moderated — report honestly, never claim success
    console.error('Generation did not complete. Status:', result.status);
    if (result.error) console.error('Error:', JSON.stringify(result.error));
    process.exit(1);
  }
}

main().catch((e) => { console.error('Request failed:', e.message); process.exit(1); });
