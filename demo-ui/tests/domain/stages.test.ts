// Domain rules (src/domain/stages.ts): the server-side state machine the audit found missing (A-05, B-03).
import { test } from "node:test";
import assert from "node:assert/strict";
import { STAGE_KINDS, readyStages, transition, pieceStatus, type StageSnapshot } from "../../src/domain/stages.ts";

const snap = (overrides: Partial<Record<(typeof STAGE_KINDS)[number], StageSnapshot["state"]>>): StageSnapshot[] =>
  STAGE_KINDS.map((kind) => ({ kind, state: overrides[kind] ?? "locked" }));

test("only plan is ready on a new studio piece; approving plan unlocks the creative stages", () => {
  assert.deepEqual(readyStages(snap({}), "studio"), ["plan"]);
  assert.deepEqual(readyStages(snap({ plan: "approved" }), "studio"), ["mood", "thumb", "brief", "board"]);
});

test("draft needs brief and board approved; qc needs a generated draft; final needs qc approved", () => {
  const s = snap({ plan: "approved", mood: "approved", thumb: "approved", brief: "approved" });
  assert.ok(!readyStages(s, "studio").includes("draft"));
  s[STAGE_KINDS.indexOf("board")].state = "approved";
  assert.ok(readyStages(s, "studio").includes("draft"));
  s[STAGE_KINDS.indexOf("draft")].state = "generated";
  assert.ok(readyStages(s, "studio").includes("qc"));
  assert.ok(!readyStages(s, "studio").includes("final"));
  s[STAGE_KINDS.indexOf("qc")].state = "approved";
  assert.ok(readyStages(s, "studio").includes("final"));
});

test("external pushes may arrive in any order once the plan exists", () => {
  assert.deepEqual(readyStages(snap({ plan: "approved" }), "external_hermes"), ["mood", "thumb", "brief", "board", "draft", "qc", "final"]);
  assert.deepEqual(readyStages(snap({}), "external_hermes"), ["plan"]);
});

test("transitions: generate only from ready/rejected, result only onto generating, failure returns to ready", () => {
  assert.deepEqual(transition("mood", "ready", { type: "generate" }), { ok: true, next: "generating" });
  assert.equal(transition("mood", "locked", { type: "generate" }).ok, false);
  assert.deepEqual(transition("mood", "generating", { type: "generated" }), { ok: true, next: "generated" });
  assert.equal(transition("mood", "ready", { type: "generated" }).ok, false);
  assert.deepEqual(transition("mood", "generating", { type: "failed" }), { ok: true, next: "ready" });
});

test("approval: reviewers approve ordinary stages; final needs both documents and the right role; no self-approval; no double approval", () => {
  const docs = { line_manager: true, adlcp: true };
  assert.deepEqual(transition("brief", "generated", { type: "approve", role: "reviewer", approverId: "u1", generatedBy: "u2", documents: { line_manager: false, adlcp: false } }), { ok: true, next: "approved" });
  assert.equal(transition("brief", "generated", { type: "approve", role: "viewer", approverId: "u1", generatedBy: null, documents: docs }).ok, false);
  assert.equal(transition("brief", "generated", { type: "approve", role: "reviewer", approverId: "u1", generatedBy: "u1", documents: docs }).ok, false, "self-approval");
  assert.equal(transition("brief", "generated", { type: "approve", role: "admin", approverId: "u1", generatedBy: "u1", documents: docs }).ok, true, "admin may");
  const r = transition("final", "generated", { type: "approve", role: "line_manager", approverId: "u1", generatedBy: null, documents: { line_manager: true, adlcp: false } });
  assert.equal(r.ok, false); assert.equal((r as { code: string }).code, "documents_required");
  assert.equal(transition("final", "generated", { type: "approve", role: "reviewer", approverId: "u1", generatedBy: null, documents: docs }).ok, false, "reviewer cannot approve final");
  assert.deepEqual(transition("final", "generated", { type: "approve", role: "adlcp_approver", approverId: "u1", generatedBy: null, documents: docs }), { ok: true, next: "approved" });
  assert.equal(transition("final", "approved", { type: "approve", role: "admin", approverId: "u1", generatedBy: null, documents: docs }).ok, false, "already approved");
});

test("rejection needs a reason and sends the stage to rejected; regeneration goes back through generating; reopen is admin-only", () => {
  assert.equal(transition("thumb", "generated", { type: "reject", reason: "  " }).ok, false);
  assert.deepEqual(transition("thumb", "generated", { type: "reject", reason: "logo missing" }), { ok: true, next: "rejected" });
  assert.deepEqual(transition("thumb", "rejected", { type: "regenerate" }), { ok: true, next: "generating" });
  assert.deepEqual(transition("thumb", "generated", { type: "regenerate" }), { ok: true, next: "generating" });
  assert.equal(transition("thumb", "approved", { type: "regenerate" }).ok, false, "an approved version is immutable; reopen first");
  assert.equal(transition("thumb", "approved", { type: "reopen", role: "reviewer" }).ok, false);
  assert.deepEqual(transition("thumb", "approved", { type: "reopen", role: "admin" }), { ok: true, next: "ready" });
});

test("piece status derives from stages", () => {
  assert.equal(pieceStatus(snap({})), "planning");
  assert.equal(pieceStatus(snap({ plan: "approved" })), "in_production");
  assert.equal(pieceStatus(snap({ plan: "approved", mood: "generated" })), "in_review");
  assert.equal(pieceStatus(snap({ plan: "approved", final: "approved" })), "approved");
});
