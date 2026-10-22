// Types for src/domain/stages.js (the implementation is CommonJS so the
// Vercel function bundle and the Next.js server share one file).
export declare const STAGE_KINDS: readonly ["plan", "mood", "thumb", "brief", "board", "draft", "qc", "final"];
export type StageKind = (typeof STAGE_KINDS)[number];

export declare const STAGE_STATES: readonly ["locked", "ready", "generating", "generated", "rejected", "approved"];
export type StageState = (typeof STAGE_STATES)[number];

export declare const ORIGINS: readonly ["hermes_dispatch", "external_hermes", "studio"];
export type Origin = (typeof ORIGINS)[number];

export declare const ROLES: readonly ["admin", "creator", "reviewer", "line_manager", "adlcp_approver", "viewer"];
export type Role = (typeof ROLES)[number];
export declare const FINAL_APPROVER_ROLES: readonly Role[];
export declare const STAGE_APPROVER_ROLES: readonly Role[];

export type StageSnapshot = { kind: StageKind; state: StageState };

export declare function stagePosition(kind: StageKind): number;
export declare function prerequisites(kind: StageKind): StageKind[];
export declare function readyStages(stages: StageSnapshot[], origin: Origin): StageKind[];
/** true when `kind` may be generated; otherwise the list of unmet prerequisite kinds. */
export declare function prerequisitesMet(stages: StageSnapshot[], kind: StageKind, opts?: { strict?: boolean; origin?: Origin }): true | StageKind[];

export type Transition =
  | { type: "generate" }
  | { type: "generated" }
  | { type: "failed" }
  | { type: "approve"; role: Role; approverId: string | null; generatedBy: string | null; documents: { line_manager: boolean; adlcp: boolean } }
  | { type: "reject"; reason: string }
  | { type: "regenerate" }
  | { type: "reopen"; role: Role };

export type TransitionResult = { ok: true; next: StageState } | { ok: false; code: string; message: string };

export declare function transition(kind: StageKind, from: StageState, t: Transition): TransitionResult;
export declare function pieceStatus(stages: StageSnapshot[]): "planning" | "in_production" | "in_review" | "approved";
export declare const CONSUMES: Record<StageKind, StageKind[]>;
export declare function staleStages(stages: { kind: StageKind; current_version_id: string | null }[], inputsById: Map<string, Record<string, string> | null>): { kind: StageKind; because: { kind: StageKind; built: string; current: string | null }[] }[];
