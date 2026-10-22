// The content-piece stage model (ARCHITECTURE_TARGET §3). Pure: no I/O, no
// framework. Everything the server enforces about ordering and approvals
// lives here and is unit-tested; services call these functions and persist
// the result.
//
// Plain CommonJS so both the Vercel function bundle (api/_handlers, CJS) and
// the Next.js server layer (TS, esModuleInterop) can load the same file;
// the types live in stages.d.ts.

const STAGE_KINDS = ["plan", "mood", "thumb", "brief", "board", "draft", "qc", "final"];
const STAGE_STATES = ["locked", "ready", "generating", "generated", "rejected", "approved"];
const ORIGINS = ["hermes_dispatch", "external_hermes", "studio"];
const ROLES = ["admin", "creator", "reviewer", "line_manager", "adlcp_approver", "viewer"];
const FINAL_APPROVER_ROLES = ["line_manager", "adlcp_approver", "admin"];
const STAGE_APPROVER_ROLES = ["reviewer", "line_manager", "adlcp_approver", "admin"];

const stagePosition = (kind) => STAGE_KINDS.indexOf(kind);

/** What must already be approved before `kind` may be generated. */
function prerequisites(kind) {
  switch (kind) {
    case "plan": return [];
    case "mood": return ["plan"];
    case "thumb": return ["plan"];
    case "brief": return ["plan"];
    case "board": return ["plan"];
    case "draft": return ["plan", "brief", "board"];
    case "qc": return ["draft"]; // QC needs a generated draft, approval of the draft is the QC itself
    case "final": return ["qc"];
    default: return [];
  }
}

/** Which stages become `ready` given the current snapshot. External pushes
 *  arrive in any order and are reviewed as they come, so for that origin every
 *  stage is ready once the plan exists. */
function readyStages(stages, origin) {
  const state = new Map(stages.map((s) => [s.kind, s.state]));
  const done = (k) => state.get(k) === "approved" || (k === "draft" && state.get(k) === "generated");
  const out = [];
  for (const kind of STAGE_KINDS) {
    const st = state.get(kind) ?? "locked";
    if (st !== "locked" && st !== "ready") continue;
    if (origin === "external_hermes") { if (kind === "plan" || done("plan")) out.push(kind); continue; }
    if (prerequisites(kind).every(done)) out.push(kind);
  }
  return out;
}

/** May `kind` be generated now? Strict (the new pages): every prerequisite
 *  is approved. Soft (the legacy page, which produces stages in any order
 *  and has no plan approval step): every prerequisite merely exists
 *  (generated or approved). External pushes only need the plan. */
function prerequisitesMet(stages, kind, opts = {}) {
  const state = new Map(stages.map((s) => [s.kind, s.state]));
  const exists = (k) => ["generated", "approved"].includes(state.get(k));
  const approved = (k) => state.get(k) === "approved" || (k === "draft" && state.get(k) === "generated");
  if (opts.origin === "external_hermes") return kind === "plan" || exists("plan");
  const ok = opts.strict ? approved : exists;
  const missing = prerequisites(kind).filter((k) => !ok(k));
  return missing.length === 0 ? true : missing;
}

/** The single place that decides whether a stage transition is allowed. */
function transition(kind, from, t) {
  const no = (code, message) => ({ ok: false, code, message });
  switch (t.type) {
    case "generate":
      if (from !== "ready" && from !== "rejected") return no("not_ready", `${kind} is ${from}; it can only be generated when ready or rejected`);
      return { ok: true, next: "generating" };
    case "generated":
      if (from !== "generating") return no("not_generating", `${kind} is ${from}; a job result can only land on a generating stage`);
      return { ok: true, next: "generated" };
    case "failed":
      if (from !== "generating") return no("not_generating", `${kind} is ${from}`);
      return { ok: true, next: "ready" };
    case "regenerate":
      if (from !== "generated" && from !== "rejected") return no("not_regenerable", `${kind} is ${from}; only a generated or rejected stage can be regenerated`);
      return { ok: true, next: "generating" };
    case "reject":
      if (from !== "generated") return no("not_reviewable", `${kind} is ${from}; only a generated stage can be rejected`);
      if (!t.reason || !t.reason.trim()) return no("reason_required", "a rejection needs a written reason");
      return { ok: true, next: "rejected" };
    case "approve": {
      if (from !== "generated") return no("not_reviewable", `${kind} is ${from}; only a generated stage can be approved`);
      if (t.generatedBy && t.generatedBy === t.approverId && t.role !== "admin") return no("self_approval", "a member cannot approve a version they generated");
      if (kind === "final") {
        if (!t.documents || !t.documents.line_manager || !t.documents.adlcp) return no("documents_required", "final needs the line-manager and ADLCP documents attached to this version");
        if (!FINAL_APPROVER_ROLES.includes(t.role)) return no("role_required", "final can only be approved by a line manager or ADLCP approver");
      } else if (!STAGE_APPROVER_ROLES.includes(t.role)) {
        return no("role_required", `${t.role} cannot approve stages`);
      }
      return { ok: true, next: "approved" };
    }
    case "reopen":
      if (from !== "approved") return no("not_approved", `${kind} is ${from}`);
      if (t.role !== "admin") return no("role_required", "only an admin can reopen an approved stage");
      return { ok: true, next: "ready" };
    default:
      return no("unknown_transition", `unknown transition ${String(t && t.type)}`);
  }
}

/** What each rebuilt Studio stage is BUILT FROM (6.9 lineage + invalidation). Distinct from
 *  prerequisites(): the legacy page may generate in any order, but a version always records the
 *  upstream versions that existed when it was made. */
const CONSUMES = { plan: [], mood: ["plan"], thumb: ["mood"], brief: ["mood", "thumb"], board: ["brief", "mood"], draft: ["board"], qc: ["draft"], final: ["qc", "draft"] };

/** Stale stages: a stage whose current version recorded an input version that is no longer that
 *  input stage's current version. Pure. `stages` = [{kind, current_version_id}], `inputsById` =
 *  Map(versionId → inputs object | null). Returns [{kind, because: [{kind, built, current}]}]. */
function staleStages(stages, inputsById) {
  const cur = new Map(stages.map((s) => [s.kind, s.current_version_id || null]));
  const byKind = new Map(stages.map((s) => [s.kind, s]));
  const stale = new Map();
  // in pipeline order, so staleness propagates: a stage built from a stale (out-of-date) upstream is stale too
  for (const kind of STAGE_KINDS) {
    const s = byKind.get(kind);
    if (!s || !s.current_version_id) continue;
    const inputs = inputsById.get(s.current_version_id);
    if (!inputs) continue; // versions from before 016 carry no inputs: never claimed stale
    const because = [];
    for (const [k, vid] of Object.entries(inputs)) {
      if (!vid) continue;
      if (cur.get(k) !== vid) because.push({ kind: k, built: vid, current: cur.get(k) || null });
      else if (stale.has(k)) because.push({ kind: k, built: vid, current: vid, via: stale.get(k).map((b) => b.kind) });
    }
    if (because.length) stale.set(kind, because);
  }
  return [...stale.entries()].map(([kind, because]) => ({ kind, because }));
}

/** Piece status derived from its stages (never stored independently). */
function pieceStatus(stages) {
  const state = new Map(stages.map((s) => [s.kind, s.state]));
  if ((state.get("plan") ?? "locked") !== "approved") return "planning";
  if (state.get("final") === "approved") return "approved";
  if ([...state.values()].some((s) => s === "generated")) return "in_review";
  return "in_production";
}

module.exports = { STAGE_KINDS, STAGE_STATES, ORIGINS, ROLES, FINAL_APPROVER_ROLES, STAGE_APPROVER_ROLES, CONSUMES, stagePosition, prerequisites, prerequisitesMet, readyStages, transition, pieceStatus, staleStages };
