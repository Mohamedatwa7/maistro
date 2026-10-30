// The "coming soon" gate (src/gate.mjs, middleware.ts): which paths stay open, the password check, the cookie token.
const { test } = require("node:test");
const assert = require("node:assert/strict");

test("gate: only the holding page, icons, assets, the API and Next internals stay open", async () => {
  const { isOpenPath } = await import("../../src/gate.mjs");
  for (const p of ["/coming-soon.html", "/favicon.ico", "/assets/favicon.svg", "/api/health", "/_next/static/x.js"]) assert.equal(isOpenPath(p), true, p);
  for (const p of ["/", "/legacy/index.html", "/legacy/", "/anything", "/assetsx", "/gate"]) assert.equal(isOpenPath(p), false, p);
});

test("gate: the password must match exactly; an unset password never matches", async () => {
  const { passwordMatches } = await import("../../src/gate.mjs");
  assert.equal(await passwordMatches("s3cret*", "s3cret*"), true);
  assert.equal(await passwordMatches("s3cret", "s3cret*"), false);
  assert.equal(await passwordMatches("", "s3cret*"), false);
  assert.equal(await passwordMatches("anything", ""), false);
  assert.equal(await passwordMatches(undefined, "s3cret*"), false);
});

test("gate: the cookie token depends on both the secret and the password", async () => {
  const { gateToken } = await import("../../src/gate.mjs");
  const t = await gateToken("k1", "p1");
  assert.match(t, /^[0-9a-f]{64}$/);
  assert.equal(await gateToken("k1", "p1"), t);
  assert.notEqual(await gateToken("k2", "p1"), t);
  assert.notEqual(await gateToken("k1", "p2"), t);
  assert.match(await gateToken("", "p1"), /^[0-9a-f]{64}$/, "works without a session secret");
});
