// Request schemas for the function boundary (ADR-010, M2 part 2 — the
// DB-free half). Zero dependencies on purpose: the legacy bundle is one
// Vercel function and zod arrives with the Next.js server layer.
//
// A schema is a small description; validate(schema, value) returns an array
// of problems ("path: message"), empty when the value conforms. The stage
// schemas below are the documented ingest contract (API.md) widened to the
// media shapes the Studio and the website renderer already accept.
const HEX = /^#[0-9a-fA-F]{6}$/;
const HTTPS = /^https:\/\/[^\s]+$/;
const PLATFORMS = ['tiktok', 'instagram', 'youtube', 'x'];

const str = (opts = {}) => ({ t: 'string', min: opts.min ?? 1, max: opts.max ?? 2000, pattern: opts.pattern, enum: opts.enum, optional: opts.optional });
const num = (opts = {}) => ({ t: 'number', min: opts.min, max: opts.max, int: opts.int, optional: opts.optional });
const bool = (opts = {}) => ({ t: 'boolean', optional: opts.optional });
const arr = (item, opts = {}) => ({ t: 'array', item, min: opts.min ?? 0, max: opts.max ?? 100, optional: opts.optional });
const obj = (props, opts = {}) => ({ t: 'object', props, optional: opts.optional, extra: opts.extra !== false });
const tuple = (items, opts = {}) => ({ t: 'tuple', items, optional: opts.optional });
const oneOf = (alts, opts = {}) => ({ t: 'oneOf', alts, optional: opts.optional });
const hex = (opts = {}) => str({ pattern: HEX, max: 7, ...opts });
const url = (opts = {}) => str({ pattern: HTTPS, max: 2048, ...opts });

function validate(schema, value, path = '$', out = []) {
  if (value === undefined || value === null) {
    if (!schema.optional) out.push(`${path}: required`);
    return out;
  }
  switch (schema.t) {
    case 'string':
      if (typeof value !== 'string') out.push(`${path}: must be a string`);
      else if (value.length < schema.min) out.push(`${path}: must not be empty`);
      else if (value.length > schema.max) out.push(`${path}: longer than ${schema.max} characters`);
      else if (schema.pattern && !schema.pattern.test(value)) out.push(`${path}: has the wrong format`);
      else if (schema.enum && !schema.enum.includes(value)) out.push(`${path}: must be one of ${schema.enum.join('|')}`);
      return out;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) out.push(`${path}: must be a number`);
      else if (schema.int && !Number.isInteger(value)) out.push(`${path}: must be an integer`);
      else if (schema.min != null && value < schema.min) out.push(`${path}: below ${schema.min}`);
      else if (schema.max != null && value > schema.max) out.push(`${path}: above ${schema.max}`);
      return out;
    case 'boolean':
      if (typeof value !== 'boolean') out.push(`${path}: must be true or false`);
      return out;
    case 'array':
      if (!Array.isArray(value)) { out.push(`${path}: must be an array`); return out; }
      if (value.length < schema.min) out.push(`${path}: needs at least ${schema.min} item${schema.min === 1 ? '' : 's'}`);
      if (value.length > schema.max) out.push(`${path}: more than ${schema.max} items`);
      value.forEach((v, i) => validate(schema.item, v, `${path}[${i}]`, out));
      return out;
    case 'tuple':
      if (!Array.isArray(value) || value.length !== schema.items.length) { out.push(`${path}: must be an array of ${schema.items.length}`); return out; }
      schema.items.forEach((s, i) => validate(s, value[i], `${path}[${i}]`, out));
      return out;
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) { out.push(`${path}: must be an object`); return out; }
      for (const [k, s] of Object.entries(schema.props)) validate(s, value[k], `${path}.${k}`, out);
      return out;
    }
    case 'oneOf': {
      const attempts = schema.alts.map((a) => validate(a, value, path, []));
      if (attempts.some((p) => p.length === 0)) return out;
      // report the closest alternative (fewest problems)
      attempts.sort((a, b) => a.length - b.length);
      out.push(...attempts[0]);
      return out;
    }
    default:
      out.push(`${path}: unknown schema`);
      return out;
  }
}

// ---- ingest artifacts per stage ----
const media = (extra = {}) => obj({ imageUrl: url({ optional: true }), videoUrl: url({ optional: true }), prompt: str({ max: 4000, optional: true }), note: str({ max: 2000, optional: true }), ...extra });

const STAGE_SCHEMAS = {
  plan: obj({
    title: str({ max: 200 }), product: str({ max: 200 }), msg: str({ max: 300 }), angle: str({ max: 600, optional: true }),
    markets: arr(str({ max: 60 }), { max: 12 }), platforms: arr(str({ enum: PLATFORMS }), { max: 4 }),
    th: tuple([hex(), hex()]),
  }),
  mood: oneOf([
    obj({ note: str({ max: 2000 }), tiles: arr(tuple([hex(), hex(), str({ max: 60 })]), { min: 1, max: 6 }) }),
    obj({ imageUrl: url(), note: str({ max: 2000, optional: true }), prompt: str({ max: 4000, optional: true }) }),
  ]),
  thumb: oneOf([
    obj({ title: str({ max: 120 }), sub: str({ max: 160 }), g: tuple([hex(), hex()]) }),
    obj({ imageUrl: url(), title: str({ max: 120, optional: true }), sub: str({ max: 160, optional: true }), prompt: str({ max: 4000, optional: true }), note: str({ max: 2000, optional: true }) }),
  ]),
  brief: obj({
    objective: str({ max: 1500 }), msg: str({ max: 300 }), markets: arr(str({ max: 60 }), { max: 12 }),
    platforms: arr(str({ enum: PLATFORMS }), { max: 4 }), deadline: str({ max: 60 }), mandatories: arr(str({ max: 300 }), { max: 12 }),
  }),
  board: oneOf([
    arr(obj({ tc: str({ max: 12 }), d: str({ max: 600 }), g: tuple([hex(), hex()]) }), { min: 1, max: 6 }),
    obj({ imageUrl: url(), prompt: str({ max: 4000, optional: true }), note: str({ max: 2000, optional: true }) }),
    obj({ shots: arr(obj({}), { min: 1, max: 8 }) }), // 6.5 shot list (the Studio writes it through the store; other keys pass)
  ]),
  final: media({
    version: str({ max: 20 }), dur: str({ max: 20 }), audio: str({ max: 300 }),
    variants: arr(obj({ a: str({ enum: ['9:16', '16:9', '1:1'] }), l: str({ max: 12 }), k: str({ enum: ['original', 'subtitles', 'voiceover', 'seedance'] }), st: str({ enum: ['ready', 'rendering'] }) }), { min: 1, max: 12 }),
    qcRevised: bool({ optional: true }),
  }),
  qc: oneOf([
    obj({ f1x8: arr(obj({ n: str({ max: 80 }), s: num({ int: true, min: 0, max: 100 }) }), { min: 1, max: 8 }), f1x8Note: str({ max: 600 }), human: str({ max: 120, optional: true }), humanNote: str({ max: 600, optional: true }), simulated: bool({ optional: true }) }),
    obj({ real: bool(), runs: obj({}), avg: num({ min: 0, max: 10, optional: true }) }),
  ]),
};

const MAX_ARTIFACT_BYTES = 64 * 1024;

// Returns null when valid, else a message in the historical format
// ("<stage> artifact is missing: a, b" when only required keys are absent;
// otherwise "<stage> artifact invalid: …") plus the structured problem list.
function validateArtifact(stage, artifact) {
  const schema = STAGE_SCHEMAS[stage];
  if (!schema) return { message: `unknown stage "${stage}"`, problems: [] };
  const size = Buffer.byteLength(JSON.stringify(artifact ?? null), 'utf8');
  if (size > MAX_ARTIFACT_BYTES) return { message: `${stage} artifact invalid: larger than ${MAX_ARTIFACT_BYTES} bytes`, problems: [`$: ${size} bytes`] };
  const problems = validate(schema, artifact);
  if (!problems.length) return null;
  const missing = problems.filter((p) => /^\$\.[A-Za-z0-9_]+: required$/.test(p)).map((p) => p.slice(2, p.indexOf(':')));
  if (missing.length === problems.length && !Array.isArray(artifact)) return { message: `${stage} artifact is missing: ${missing.join(', ')}`, problems };
  return { message: `${stage} artifact invalid: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}`, problems };
}

// ---- generation request bodies ----
const HERMES_BODY = obj({
  stage: str({ enum: ['plan', 'mood', 'thumb', 'brief', 'board', 'final', 'qc'] }),
  trend: obj({ name: str({ max: 200 }) }),
  project: obj({}, { optional: true }),
});
const DIRECTOR_BODY = obj({
  stage: str({ enum: ['mood', 'thumb', 'board', 'final', 'revise'] }),
  userInput: str({ min: 0, max: 4000, optional: true }),
  campaign: obj({ title: str({ max: 200 }) }),
  context: obj({}, { optional: true }),
});

module.exports = { validate, validateArtifact, STAGE_SCHEMAS, HERMES_BODY, DIRECTOR_BODY, MAX_ARTIFACT_BYTES, PLATFORMS };
