// Probe the Soul v1 endpoint shape with image_reference (billable: 1 image).
const { config, higgsfield } = require('@higgsfield/client/v2');

async function main() {
  config({ credentials: process.env.HF_CREDENTIALS });
  const result = await higgsfield.subscribe('/v1/text2image/soul', {
    input: {
      params: {
        prompt: 'Premium product hero shot of the exact fridge from the reference image on a warm sand-beige backdrop, soft directional light',
        width_and_height: '2048x1152',
        quality: '1080p',
        batch_size: 1,
        image_reference: {
          type: 'image_url',
          image_url: 'https://d3u0tzju9qaucj.cloudfront.net/9bb1fc65-397b-48aa-8a7f-68f454ceb695/335bd254-32b8-4081-85d3-e30cf88f3cfd.png',
        },
        enhance_prompt: false,
      },
    },
    withPolling: true,
  });
  console.log('status:', result.status);
  console.log('images:', JSON.stringify(result.images || result, null, 1).slice(0, 500));
}
main().catch((e) => { console.error('FAILED:', e.message, e.response?.data ? JSON.stringify(e.response.data).slice(0, 500) : ''); process.exit(1); });
