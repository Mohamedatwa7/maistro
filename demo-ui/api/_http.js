// Bounded outbound HTTP for every serverless function (M1, AUDIT E-01).
//
// fetchT(url, init, opts): fetch with a hard timeout and optional retries
// with exponential backoff + jitter. Retries only when the caller asks for
// them (idempotent reads) and only on network errors, 429 and 5xx.
//
// Nothing here changes a response shape; a timeout surfaces as the same
// thrown error the callers already map to 5xx.
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

async function fetchT(url, init = {}, opts = {}) {
  const { timeoutMs = 15000, retries = 0, retryOn = (r) => r.status === 429 || r.status >= 500 } = opts;
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (attempt < retries && retryOn(r)) {
        lastErr = new Error(`upstream ${r.status}`);
        await sleep(300 * 2 ** attempt + Math.floor(Math.random() * 200));
        continue;
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (attempt >= retries) break;
      await sleep(300 * 2 ** attempt + Math.floor(Math.random() * 200));
    }
  }
  if (lastErr && lastErr.name === 'TimeoutError') {
    const err = new Error(`upstream timed out after ${timeoutMs} ms: ${String(url).split('?')[0]}`);
    err.code = 'ETIMEDOUT';
    throw err;
  }
  throw lastErr || new Error('fetch failed');
}

module.exports = { fetchT, sleep };
