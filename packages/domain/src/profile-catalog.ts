import type {
  ArtifactType,
  TaskKind,
  WorkflowNode,
  WorkflowProfile,
  WorkflowProfileId,
} from "@pi-hec/contracts";

const RETRY = {
  maxAttempts: 3,
  retryOn: ["validation", "runtime", "lost-session"] as const,
};

export function workflowNode(
  id: string,
  fields: Omit<WorkflowNode, "id" | "dependsOn" | "retryPolicy" | "invalidates"> & {
    dependsOn?: readonly string[];
    invalidates?: readonly string[];
  },
): WorkflowNode {
  return {
    id,
    dependsOn: [...(fields.dependsOn ?? [])],
    retryPolicy: { maxAttempts: RETRY.maxAttempts, retryOn: [...RETRY.retryOn] },
    invalidates: [...(fields.invalidates ?? [])],
    ...(fields.role === undefined ? {} : { role: fields.role }),
    ...(fields.operation === undefined ? {} : { operation: fields.operation }),
    ...(fields.when === undefined ? {} : { when: fields.when }),
    ...(fields.concurrencyGroup === undefined ? {} : { concurrencyGroup: fields.concurrencyGroup }),
  };
}

function node(
  id: string,
  fields: Omit<WorkflowNode, "id" | "dependsOn" | "retryPolicy" | "invalidates"> & {
    dependsOn?: readonly string[];
    invalidates?: readonly string[];
  },
): WorkflowNode {
  return workflowNode(id, fields);
}

function profile(
  id: WorkflowProfileId,
  appliesTo: readonly TaskKind[],
  nodes: readonly WorkflowNode[],
  requiredArtifacts: readonly ArtifactType[],
  acceptance: WorkflowProfile["acceptancePolicy"],
): WorkflowProfile {
  return {
    schemaVersion: 1,
    id,
    appliesTo: [...appliesTo],
    nodes: [...nodes],
    requiredArtifacts: [...requiredArtifacts],
    acceptancePolicy: acceptance,
  };
}

const FEATURE_STANDARD_ACCEPT = {
  requireReviewer: true,
  requireCommandEvidence: true,
  requireFreshReviewAfterRepair: true,
  allowResearchWithoutWrite: false,
} as const;

export const FEATURE_PROFILE = profile(
  "FEATURE",
  ["feature"],
  [
    node("analyst", { role: "analyst", concurrencyGroup: "read" }),
    node("code-investigator", {
      role: "investigator",
      dependsOn: ["analyst"],
      concurrencyGroup: "read",
    }),
    node("spec-investigator", {
      role: "investigator",
      dependsOn: ["analyst"],
      concurrencyGroup: "read",
    }),
    node("planner", {
      role: "planner",
      dependsOn: ["code-investigator", "spec-investigator"],
      concurrencyGroup: "read",
    }),
    node("plan-critic", {
      role: "architecture-reviewer",
      dependsOn: ["planner"],
      when: "HIGH_RISK",
      concurrencyGroup: "review",
    }),
    node("implementer", {
      role: "implementer",
      dependsOn: ["planner"],
      concurrencyGroup: "write",
    }),
    node("integration", {
      operation: "DETERMINISTIC_INTEGRATION",
      dependsOn: ["implementer"],
    }),
    node("verification", {
      operation: "VERIFICATION",
      dependsOn: ["integration"],
    }),
    node("reviewer", {
      role: "reviewer",
      dependsOn: ["verification"],
      concurrencyGroup: "review",
    }),
    node("repair-implementer", {
      role: "implementer",
      dependsOn: ["reviewer"],
      when: "HAS_BLOCKING_FINDINGS",
      concurrencyGroup: "write",
      invalidates: ["verification", "reviewer"],
    }),
    node("fresh-reviewer", {
      role: "reviewer",
      dependsOn: ["repair-implementer"],
      when: "HAS_BLOCKING_FINDINGS",
      concurrencyGroup: "review",
    }),
    node("spec-consistency", {
      operation: "SPEC_CONSISTENCY",
      dependsOn: ["reviewer"],
    }),
    node("acceptance", {
      operation: "ACCEPTANCE",
      dependsOn: ["spec-consistency"],
    }),
  ],
  ["task-contract", "implementation-plan", "change-manifest", "review-findings", "acceptance-ledger"],
  FEATURE_STANDARD_ACCEPT,
);

export const BUGFIX_PROFILE = profile(
  "BUGFIX",
  ["bugfix"],
  [
    node("analyst", { role: "analyst", concurrencyGroup: "read" }),
    node("reproduction-investigator", {
      role: "investigator",
      dependsOn: ["analyst"],
      concurrencyGroup: "read",
    }),
    node("root-cause-investigator", {
      role: "investigator",
      dependsOn: ["reproduction-investigator"],
      concurrencyGroup: "read",
    }),
    node("second-hypothesis", {
      role: "investigator",
      dependsOn: ["reproduction-investigator"],
      when: "UNSTABLE_BUG",
      concurrencyGroup: "read",
    }),
    node("planner", {
      role: "planner",
      dependsOn: ["root-cause-investigator"],
      concurrencyGroup: "read",
    }),
    node("implementer", {
      role: "implementer",
      dependsOn: ["planner"],
      concurrencyGroup: "write",
    }),
    node("regression-verification", {
      operation: "REGRESSION_VERIFICATION",
      dependsOn: ["implementer"],
    }),
    node("reviewer", {
      role: "reviewer",
      dependsOn: ["regression-verification"],
      concurrencyGroup: "review",
    }),
    node("repair-implementer", {
      role: "implementer",
      dependsOn: ["reviewer"],
      when: "HAS_BLOCKING_FINDINGS",
      concurrencyGroup: "write",
      invalidates: ["regression-verification", "reviewer"],
    }),
    node("fresh-reviewer", {
      role: "reviewer",
      dependsOn: ["repair-implementer"],
      when: "HAS_BLOCKING_FINDINGS",
      concurrencyGroup: "review",
    }),
    node("acceptance", {
      operation: "ACCEPTANCE",
      dependsOn: ["reviewer"],
    }),
  ],
  [
    "task-contract",
    "investigation-report",
    "implementation-plan",
    "change-manifest",
    "review-findings",
    "acceptance-ledger",
  ],
  FEATURE_STANDARD_ACCEPT,
);

export const FAST_PROFILE = profile(
  "FAST",
  ["feature", "bugfix"],
  [
    node("analyst", { role: "analyst", concurrencyGroup: "read" }),
    node("investigator", {
      role: "investigator",
      dependsOn: ["analyst"],
      concurrencyGroup: "read",
    }),
    node("implementer", {
      role: "implementer",
      dependsOn: ["investigator"],
      concurrencyGroup: "write",
    }),
    node("verification", {
      operation: "VERIFICATION",
      dependsOn: ["implementer"],
    }),
    node("reviewer", {
      role: "reviewer",
      dependsOn: ["verification"],
      concurrencyGroup: "review",
    }),
    node("repair-implementer", {
      role: "implementer",
      dependsOn: ["reviewer"],
      when: "HAS_BLOCKING_FINDINGS",
      concurrencyGroup: "write",
      invalidates: ["verification", "reviewer"],
    }),
    node("fresh-reviewer", {
      role: "reviewer",
      dependsOn: ["repair-implementer"],
      when: "HAS_BLOCKING_FINDINGS",
      concurrencyGroup: "review",
    }),
    node("acceptance", {
      operation: "ACCEPTANCE",
      dependsOn: ["reviewer"],
    }),
  ],
  ["task-contract", "change-manifest", "review-findings", "acceptance-ledger"],
  FEATURE_STANDARD_ACCEPT,
);

export const HIGH_RISK_PROFILE = profile(
  "HIGH_RISK",
  ["feature", "bugfix", "refactor"],
  [
    ...FEATURE_PROFILE.nodes.filter((item) => item.id !== "acceptance"),
    node("security-reviewer", {
      role: "security-reviewer",
      dependsOn: ["reviewer"],
      concurrencyGroup: "review",
    }),
    node("architecture-reviewer", {
      role: "architecture-reviewer",
      dependsOn: ["reviewer"],
      concurrencyGroup: "review",
    }),
    node("test-reviewer", {
      role: "test-reviewer",
      dependsOn: ["reviewer"],
      concurrencyGroup: "review",
    }),
    node("acceptance", {
      operation: "ACCEPTANCE",
      dependsOn: ["security-reviewer", "architecture-reviewer", "test-reviewer", "spec-consistency"],
    }),
  ],
  [
    "task-contract",
    "implementation-plan",
    "change-manifest",
    "review-findings",
    "acceptance-ledger",
  ],
  FEATURE_STANDARD_ACCEPT,
);

export const RESEARCH_PROFILE = profile(
  "RESEARCH",
  ["research"],
  [
    node("analyst", { role: "analyst", concurrencyGroup: "read" }),
    node("code-investigator", {
      role: "investigator",
      dependsOn: ["analyst"],
      concurrencyGroup: "read",
    }),
    node("spec-investigator", {
      role: "investigator",
      dependsOn: ["analyst"],
      concurrencyGroup: "read",
    }),
    node("history-investigator", {
      role: "investigator",
      dependsOn: ["analyst"],
      concurrencyGroup: "read",
    }),
    node("external-investigator", {
      role: "investigator",
      dependsOn: ["analyst"],
      when: "EXTERNAL_RESEARCH",
      concurrencyGroup: "read",
    }),
    node("contradiction-finder", {
      role: "conflict-resolver",
      dependsOn: ["code-investigator", "spec-investigator", "history-investigator"],
      concurrencyGroup: "review",
    }),
    node("synthesizer", {
      role: "final-synthesizer",
      dependsOn: ["contradiction-finder"],
      concurrencyGroup: "review",
    }),
    node("evidence-completeness", {
      operation: "EVIDENCE_COMPLETENESS",
      dependsOn: ["synthesizer"],
    }),
    node("acceptance", {
      operation: "ACCEPTANCE",
      dependsOn: ["evidence-completeness"],
    }),
  ],
  ["task-contract", "investigation-report", "acceptance-ledger"],
  {
    requireReviewer: false,
    requireCommandEvidence: false,
    requireFreshReviewAfterRepair: false,
    allowResearchWithoutWrite: true,
  },
);

export const SPEC_ONLY_PROFILE = profile(
  "SPEC_ONLY",
  ["spec"],
  [
    node("analyst", { role: "analyst", concurrencyGroup: "read" }),
    node("behavior-investigator", {
      role: "investigator",
      dependsOn: ["analyst"],
      concurrencyGroup: "read",
    }),
    node("constraint-investigator", {
      role: "investigator",
      dependsOn: ["analyst"],
      concurrencyGroup: "read",
    }),
    node("spec-author", {
      role: "implementer",
      dependsOn: ["behavior-investigator", "constraint-investigator"],
      concurrencyGroup: "write",
    }),
    node("spec-reviewer", {
      role: "spec-reviewer",
      dependsOn: ["spec-author"],
      concurrencyGroup: "review",
    }),
    node("consistency-gate", {
      operation: "CONSISTENCY_GATE",
      dependsOn: ["spec-reviewer"],
    }),
    node("acceptance", {
      operation: "ACCEPTANCE",
      dependsOn: ["consistency-gate"],
    }),
  ],
  ["task-contract", "change-manifest", "review-findings", "acceptance-ledger"],
  FEATURE_STANDARD_ACCEPT,
);

export const REFACTOR_PROFILE = profile(
  "REFACTOR",
  ["refactor"],
  [
    node("analyst", { role: "analyst", concurrencyGroup: "read" }),
    node("dependency-investigator", {
      role: "investigator",
      dependsOn: ["analyst"],
      concurrencyGroup: "read",
    }),
    node("characterization", {
      operation: "BASELINE_CHARACTERIZATION",
      dependsOn: ["dependency-investigator"],
    }),
    node("planner", {
      role: "planner",
      dependsOn: ["characterization"],
      concurrencyGroup: "read",
    }),
    node("implementer", {
      role: "implementer",
      dependsOn: ["planner"],
      concurrencyGroup: "write",
    }),
    node("equivalence", {
      operation: "BEHAVIORAL_EQUIVALENCE",
      dependsOn: ["implementer"],
    }),
    node("architecture-reviewer", {
      role: "architecture-reviewer",
      dependsOn: ["equivalence"],
      concurrencyGroup: "review",
    }),
    node("acceptance", {
      operation: "ACCEPTANCE",
      dependsOn: ["architecture-reviewer"],
    }),
  ],
  ["task-contract", "implementation-plan", "change-manifest", "review-findings", "acceptance-ledger"],
  FEATURE_STANDARD_ACCEPT,
);

export const WORKFLOW_PROFILES: readonly WorkflowProfile[] = [
  FAST_PROFILE,
  FEATURE_PROFILE,
  BUGFIX_PROFILE,
  HIGH_RISK_PROFILE,
  RESEARCH_PROFILE,
  SPEC_ONLY_PROFILE,
  REFACTOR_PROFILE,
];

export function workflowProfileById(id: WorkflowProfileId): WorkflowProfile {
  const found = WORKFLOW_PROFILES.find((item) => item.id === id);
  if (found === undefined) {
    throw new Error(`unknown workflow profile ${id}`);
  }
  return found;
}
