// "Coming soon" gate (owner request 2026-10-30): until the site is unveiled, every page answers a plain
// white holding page with a password bar. The password lives only in Vercel env (MAISTRO_GATE_PASSWORD);
// the gate is off when it is unset (local preview, previews). A correct password sets an HttpOnly cookie
// holding an HMAC of the password under MAISTRO_SESSION_SECRET, so changing either one signs everybody out.
// middleware.ts applies it; the functions here are pure so tests/page/gate.test.ts can pin them.

export const GATE_COOKIE = "maistro_gate";
export const GATE_PAGE = "/coming-soon.html";
export const GATE_MAX_AGE = 60 * 60 * 24 * 30;

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** The cookie value a correct password earns. */
export async function gateToken(secret, password) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret || "maistro-gate"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(`maistro-gate:v1:${password}`)));
}

/** Compares the typed password with the configured one without an early exit on the first differing byte. */
export async function passwordMatches(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string" || !expected) return false;
  const [a, b] = await Promise.all([given, expected].map((s) => crypto.subtle.digest("SHA-256", enc.encode(s))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Paths that stay reachable without the cookie: the holding page itself, its icons, the API (it has its own auth), Next internals. */
export function isOpenPath(pathname) {
  return pathname === GATE_PAGE || pathname === "/favicon.ico" || pathname.startsWith("/api/") || pathname.startsWith("/assets/") || pathname.startsWith("/_next/");
}
