import type { RunId, RunState } from "@pi-hec/contracts";

export const GOLDEN_REPO_IDS = [
  "react-spa",
  "react-monorepo",
  "node-backend",
  "fullstack",
  "no-tests",
  "legacy-conventions",
  "with-specs",
  "incomplete-agents",
  "dirty-tree",
  "migration-public-api",
] as const;

export type GoldenRepoId = (typeof GOLDEN_REPO_IDS)[number];

export const TASK_KINDS = [
  "feature",
  "bug",
  "refactor",
  "spec",
  "research",
  "security",
  "migration",
  "ui",
  "performance",
] as const;

export type TaskKind = (typeof TASK_KINDS)[number];

export const EVIDENCE_KINDS = [
  "regression-test",
  "investigation-report",
  "review-findings",
  "spec-update",
  "migration-file",
  "command-evidence",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const REQUIRED_BEHAVIORS = [
  "concurrent-refresh-preserves-newest-token",
  "remember-me-persists-across-reload",
  "module-extracted-token-order",
  "spec-names-newest-token-rule",
  "research-no-production-edits",
  "xss-sink-sanitized",
  "migration-is-additive",
  "login-control-is-accessible",
  "refresh-is-amortized",
] as const;

export type RequiredBehaviorId = (typeof REQUIRED_BEHAVIORS)[number];

export const FORBIDDEN_BEHAVIORS = [
  "global-request-serialization",
  "public-api-break",
  "test-poisoning",
] as const;

export type ForbiddenBehaviorId = (typeof FORBIDDEN_BEHAVIORS)[number];

export const ARCHITECTURAL_DISPOSITIONS = [
  "READY",
  "BLOCKED",
  "WAITING_FOR_USER",
  "FAILED",
  "RUNNING",
] as const;

export type ArchitecturalDisposition = (typeof ARCHITECTURAL_DISPOSITIONS)[number];

export type RepoPaths = {
  readonly session: string;
  readonly publicApi: string;
  readonly canary: string;
  readonly agents: string;
  readonly tests?: string;
  readonly specs?: string;
  readonly ui?: string;
  readonly security?: string;
  readonly migration?: string;
  readonly dirty?: string;
  readonly tokenOrder?: string;
};

export type HiddenOracle = {
  readonly mustChange: readonly string[];
  readonly mustNotChange: readonly string[];
  readonly requiredBehavior: readonly RequiredBehaviorId[];
  readonly forbiddenBehavior: readonly ForbiddenBehaviorId[];
  readonly requiredEvidence: readonly EvidenceKind[];
  readonly expectedDisposition?: ArchitecturalDisposition;
  readonly solverEdits: Readonly<Record<string, string>>;
};

export type GoldenTask = {
  readonly taskId: string;
  readonly repoId: GoldenRepoId;
  readonly kind: TaskKind;
  readonly prompt: string;
  readonly oracle: HiddenOracle;
};

export type TreeSnapshot = Readonly<Record<string, string>>;

export type MaterializedRepo = {
  readonly repoId: GoldenRepoId;
  readonly root: string;
  readonly head: string;
  readonly baseline: TreeSnapshot;
  readonly paths: RepoPaths;
};

export type BehaviorCheck = {
  readonly id: string;
  readonly passed: boolean;
  readonly detail: string;
};

export type OracleScore = {
  readonly taskId: string;
  readonly acceptanceSuccess: boolean;
  readonly scopePrecision: number;
  readonly regression: boolean;
  readonly evidenceCoverage: number;
  readonly mustChangeHits: readonly string[];
  readonly mustChangeMisses: readonly string[];
  readonly forbiddenTouched: readonly string[];
  readonly extraTouched: readonly string[];
  readonly requiredBehavior: readonly BehaviorCheck[];
  readonly forbiddenBehavior: readonly BehaviorCheck[];
  readonly evidenceHits: readonly EvidenceKind[];
  readonly evidenceMisses: readonly EvidenceKind[];
  readonly hiddenTestAccess: boolean;
};

export type TrialObservation = {
  readonly declaredDisposition: ArchitecturalDisposition;
  readonly runState?: RunState;
  readonly runId?: RunId;
  readonly statesVisited: readonly RunState[];
  readonly repairCount: number;
  readonly userInputCount: number;
  readonly recovered: boolean;
  readonly recoveryAttempted: boolean;
  readonly evidencePresent: readonly EvidenceKind[];
  readonly cost: number | null;
  readonly latencyMs: number | null;
  readonly firstPass: boolean;
};

export type GoldenTrialRecord = {
  readonly taskId: string;
  readonly repoId: GoldenRepoId;
  readonly kind: TaskKind;
  readonly primaryIntent: string;
  readonly observation: TrialObservation;
  readonly score: OracleScore;
  readonly falseReady: boolean;
  readonly firstPassSuccess: boolean;
  readonly repairConverged: boolean | null;
  readonly userInterrupted: boolean;
  readonly recoverySuccess: boolean | null;
};

export type GoldenHeadline = {
  readonly trialCount: number;
  readonly acceptanceSuccess: number;
  readonly falseReadyRate: number;
  readonly falseReadyWilsonUpper: number;
  readonly scopePrecision: number;
  readonly regressionRate: number;
  readonly firstPassSuccess: number;
  readonly repairConvergence: number;
  readonly evidenceCoverage: number;
  readonly userInterruptionRate: number;
  readonly recoverySuccess: number;
  readonly cost: number | null;
  readonly latencyMs: number | null;
  readonly falseReadyByIntent: Readonly<Record<string, number>>;
};
