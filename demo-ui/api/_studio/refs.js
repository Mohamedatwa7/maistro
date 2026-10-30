// The person's own reference images (owner 2026-10-30): attached in the Studio chat or a stage's prompt
// box, uploaded through /api/upload to the public "refs" bucket. They show the look, framing, setting or
// motion the person wants; the product itself still comes only from its photo or 3D model. The prompt
// writers (Claude) see them as images, and every render job carries them to the Hermes bots.
const MAX = 4;

/** Only our own public refs bucket (what /api/upload returns), https, at most MAX, no repeats. */
function clean(list) {
  const base = String(process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!base || !Array.isArray(list)) return [];
  const prefix = `${base}/storage/v1/object/public/refs/`;
  return [...new Set(list.map((u) => String(u || '').trim()).filter((u) => /^https:\/\//.test(u) && u.startsWith(prefix) && u.length < 600))].slice(0, MAX);
}

const NOTE = 'REFERENCE IMAGES FROM THE USER (attached above): follow their look, mood, framing, setting or motion as the user intends. '
  + 'They are references, not the product: never copy a device, logo, brand, watermark or text from them, and never copy a real identifiable person.';

/** The user message as plain text, or (with references) the images first, then the text and the note. */
function withImages(text, refs) {
  if (!refs || !refs.length) return text;
  return [...refs.map((url) => ({ type: 'image', source: { type: 'url', url } })), { type: 'text', text: `${text}\n\n${NOTE}` }];
}

// what the render bots are told about style_reference_urls (api/_adapters/hermes.js)
const BOT_RULE = 'style_reference_urls are the user\'s own reference images: follow their look, framing, setting or motion; '
  + 'never copy a device, logo, text or a real person from them (the product comes only from product_image_urls or the prompt).';

// and the brief bot, which gets them as links in its task
const BRIEF_RULE = 'Write the brief so the look, setting and story follow these references where they fit the campaign; '
  + 'never copy a device, logo, text or a real person from them.';

module.exports = { MAX, clean, withImages, NOTE, BOT_RULE, BRIEF_RULE };
