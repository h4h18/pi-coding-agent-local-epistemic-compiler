import { Compile } from "typebox/compile";
import type {
  ChangeClass,
  CompiledProfile,
  ControllerOperation,
  DeliveryMode,
  ExecutionBudget,
  NodeProvenance,
  PrimaryIntent,
  ProjectAdapter,
  RelatedRunPlan,
  RiskFlag,
  RiskOverlay,
  RunComposition,
  TaskContract,
  TaskKind,
  UrgencyLevel,
  VerificationPackId,
  WorkflowNode,
  WorkflowProfileId,
} from "@pi-hec/contracts";
import { CompiledProfileSchema, RunCompositionSchema } from "@pi-hec/contracts";
import { lockProjectAdapter } from "./project-adapter.js";
import {
  BUGFIX_PROFILE,
  FEATURE_PROFILE,
  FAST_PROFILE,
  HIGH_RISK_PROFILE,
  REFACTOR_PROFILE,
  RESEARCH_PROFILE,
  SPEC_ONLY_PROFILE,
  workflowNode,
} from "./profile-catalog.js";

const MAX_NODES = 96;
const COMPILED_PROFILE = Compile(CompiledProfileSchema);
const RUN_COMPOSITION = Compile(RunCompositionSchema);

const HIGH_OVERLAYS: readonly RiskOverlay[] = [
  "security-sensitive",
  "authentication",
  "public-api",
  "data-mutation",
  "migration",
  "concurrency",
  "cross-cutting",
  "production-impact",
  "destructive",
  "emergency",
  "external-contract",
  "generated-code",
];

const FLAG_OVERLAYS: Readonly<Partial<Record<RiskFlag, readonly RiskOverlay[]>>> = {
  auth: ["security-sensitive", "authentication"],
  secrets: ["security-sensitive"],
  crypto: ["security-sensitive"],
  payment: ["security-sensitive"],
  "public-api": ["public-api"],
  migration: ["migration"],
  concurrency: ["concurrency"],
  "unstable-bug": ["concurrency"],
  "multi-subsystem": ["cross-cutting"],
  "no-tests": ["no-tests"],
  destructive: ["destructive"],
  "generated-code": ["generated-code"],
  emergency: ["emergency"],
  "production-impact": ["production-impact"],
  "ui-visible": ["ui-visible"],
  "data-mutation": ["data-mutation"],
  "external-contract": ["external-contract"],
};

const WRITE_INTENTS: ReadonlySet<PrimaryIntent> = new Set([
  "feature",
  "bugfix",
  "refactor",
  "optimization",
  "dependency-upgrade",
  "migration",
  "security-remediation",
  "test-engineering",
  "documentation",
  "build-tooling",
  "incident-response",
  "deprecation-retirement",
  "requirements",
  "specification",
  "architecture-design",
]);

export type CompositionDecision = {
  composition: RunComposition;
  rewritten: boolean;
};

export type CompileProfileInput = {
  composition: RunComposition;
  adapter?: ProjectAdapter;
  signals?: {
    unstableBug?: boolean;
    externalResearch?: boolean;
    noTests?: boolean;
  };
};

export type CompiledProfileResult = {
  compiled: CompiledProfile;
  predicates: readonly string[];
  blocked: boolean;
};

type GraphState = {
  nodes: WorkflowNode[];
  provenance: Record<string, NodeProvenance>;
  deferredGates: ControllerOperation[];
  forbiddenActions: string[];
};

function cloneNode(node: WorkflowNode): WorkflowNode {
  return {
    ...node,
    dependsOn: [...node.dependsOn],
    invalidates: [...node.invalidates],
    retryPolicy: {
      maxAttempts: node.retryPolicy.maxAttempts,
      retryOn: [...node.retryPolicy.retryOn],
    },
  };
}

function cloneNodes(nodes: readonly WorkflowNode[]): WorkflowNode[] {
  return nodes.map(cloneNode);
}

export function intentFromKind(kind: TaskKind): PrimaryIntent {
  switch (kind) {
    case "feature":
      return "feature";
    case "bugfix":
      return "bugfix";
    case "research":
      return "research";
    case "spec":
      return "specification";
    case "refactor":
      return "refactor";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function kindFromIntent(intent: PrimaryIntent): TaskKind {
  switch (intent) {
    case "research":
    case "diagnosis":
      return "research";
    case "requirements":
    case "specification":
    case "architecture-design":
    case "documentation":
      return "spec";
    case "feature":
    case "optimization":
    case "test-engineering":
    case "build-tooling":
    case "dependency-upgrade":
    case "migration":
      return "feature";
    case "bugfix":
    case "security-remediation":
    case "incident-response":
      return "bugfix";
    case "refactor":
    case "deprecation-retirement":
      return "refactor";
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}

export function changeClassFor(intent: PrimaryIntent): ChangeClass {
  switch (intent) {
    case "research":
    case "diagnosis":
    case "requirements":
    case "specification":
    case "architecture-design":
      return "none";
    case "feature":
      return "additive";
    case "bugfix":
    case "incident-response":
      return "corrective";
    case "security-remediation":
      return "corrective";
    case "refactor":
    case "optimization":
    case "documentation":
    case "deprecation-retirement":
      return "perfective";
    case "test-engineering":
      return "preventive";
    case "dependency-upgrade":
    case "migration":
    case "build-tooling":
      return "adaptive";
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}

export function defaultDeliveryFor(intent: PrimaryIntent, urgency: UrgencyLevel): DeliveryMode {
  if (urgency === "incident") {
    return "mitigation-patch";
  }
  switch (intent) {
    case "research":
    case "diagnosis":
      return "analysis-only";
    case "requirements":
    case "specification":
    case "architecture-design":
    case "documentation":
      return "spec-artifact";
    case "migration":
      return "integration-branch";
    case "incident-response":
      return "mitigation-patch";
    case "deprecation-retirement":
      return "integration-branch";
    case "feature":
    case "bugfix":
    case "refactor":
    case "optimization":
    case "dependency-upgrade":
    case "security-remediation":
    case "test-engineering":
    case "build-tooling":
      return "integration-branch";
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}

export function overlaysFromFlags(flags: readonly RiskFlag[]): RiskOverlay[] {
  const selected = new Set<RiskOverlay>();
  for (const flag of flags) {
    const mapped = FLAG_OVERLAYS[flag];
    if (mapped === undefined) {
      continue;
    }
    for (const overlay of mapped) {
      selected.add(overlay);
    }
  }
  return [...selected];
}

export function contractPrimaryIntent(contract: TaskContract): PrimaryIntent {
  if (contract.schemaVersion === 2) {
    return contract.primaryIntent;
  }
  return intentFromKind(contract.kind);
}

export function contractSecondaryIntents(contract: TaskContract): readonly PrimaryIntent[] {
  if (contract.schemaVersion === 2) {
    return contract.secondaryIntents;
  }
  return [];
}

function measurableAcceptance(contract: TaskContract): boolean {
  return contract.acceptanceCriteria.some((criterion) => {
    const text = criterion.statement.toLowerCase();
    return (
      criterion.verification.includes("runtime") ||
      criterion.verification.includes("test") ||
      text.includes("ms") ||
      text.includes("baseline") ||
      text.includes("p95") ||
      text.includes("throughput") ||
      text.includes("latency")
    );
  });
}

function consumerEvidence(contract: TaskContract): boolean {
  return (
    contract.assumptions.some((item) => item.text.toLowerCase().includes("consumer")) ||
    contract.acceptanceCriteria.some((item) => item.statement.toLowerCase().includes("consumer"))
  );
}

function rollbackEvidence(contract: TaskContract): boolean {
  return (
    contract.assumptions.some((item) => item.text.toLowerCase().includes("rollback")) ||
    contract.constraints.some((item) => item.toLowerCase().includes("rollback"))
  );
}

function destructiveAuthorized(contract: TaskContract): boolean {
  return (
    contract.blockingQuestions.length === 0 &&
    (contract.assumptions.some((item) => item.text.toLowerCase().includes("authorized")) ||
      contract.constraints.some((item) => item.toLowerCase().includes("authorized")))
  );
}

export function packsForContract(
  contract: TaskContract,
  adapter: ProjectAdapter,
  overlays: readonly RiskOverlay[],
): VerificationPackId[] {
  const available = new Set(Object.keys(adapter.verification.packs ?? {}));
  const wanted = new Set<VerificationPackId>();
  const haystack = [...contract.inScope, contract.objective].join(" ").toLowerCase();
  if (haystack.includes("ui") || haystack.includes(".tsx") || haystack.includes("css")) {
    wanted.add("frontend");
    wanted.add("web-ui");
  }
  if (haystack.includes("api") || haystack.includes("server") || haystack.includes("route")) {
    wanted.add("backend-api");
  }
  if (haystack.includes("sql") || haystack.includes("schema") || haystack.includes("migration")) {
    wanted.add("database");
  }
  if (haystack.includes("cli")) {
    wanted.add("cli");
  }
  if (haystack.includes("docs") || haystack.includes("documentation")) {
    wanted.add("documentation");
  }
  if (overlays.includes("security-sensitive") || overlays.includes("authentication")) {
    wanted.add("security");
  }
  if (overlays.includes("ui-visible")) {
    wanted.add("web-ui");
    wanted.add("frontend");
  }
  if (contractPrimaryIntent(contract) === "optimization") {
    wanted.add("performance");
  }
  if (haystack.includes("lib") || haystack.includes("package")) {
    wanted.add("library");
  }
  if (haystack.includes("ci") || haystack.includes("build")) {
    wanted.add("build-system");
  }
  return [...wanted].filter((id) => available.has(id) || available.size === 0);
}

function executionBudgetFor(input: {
  primary: PrimaryIntent;
  overlays: readonly RiskOverlay[];
  localScope: boolean;
  reversible: boolean;
  behaviorChange: boolean;
}): ExecutionBudget {
  if (
    input.localScope &&
    input.reversible &&
    !input.behaviorChange &&
    input.overlays.length === 0 &&
    (input.primary === "feature" || input.primary === "bugfix")
  ) {
    return "fast";
  }
  if (input.overlays.some((overlay) => HIGH_OVERLAYS.includes(overlay))) {
    return "thorough";
  }
  return "standard";
}

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

export type ComposeSignals = {
  kind: TaskKind;
  riskFlags: readonly RiskFlag[];
  behaviorChange: boolean;
  localScope: boolean;
  reversible: boolean;
  noTests: boolean;
  unstableBug: boolean;
  multiSubsystem: boolean;
  externalResearch: boolean;
};

export function composeFromSignals(signals: ComposeSignals): RunComposition {
  const primary = intentFromKind(signals.kind);
  const overlays = overlaysFromFlags(signals.riskFlags);
  if (signals.multiSubsystem && !overlays.includes("cross-cutting")) {
    overlays.push("cross-cutting");
  }
  const urgency: UrgencyLevel = overlays.includes("emergency") ? "incident" : "normal";
  return {
    schemaVersion: 2,
    primaryIntent: primary,
    secondaryIntents: [],
    overlays,
    verificationPacks: [],
    deliveryMode: defaultDeliveryFor(primary, urgency),
    urgency,
    executionBudget: executionBudgetFor({
      primary,
      overlays,
      localScope: signals.localScope,
      reversible: signals.reversible,
      behaviorChange: signals.behaviorChange,
    }),
    changeClass: changeClassFor(primary),
  };
}

export function composeFromContract(
  contract: TaskContract,
  adapter: ProjectAdapter = lockProjectAdapter(undefined).adapter,
): CompositionDecision {
  let primary = contractPrimaryIntent(contract);
  let secondary = [...contractSecondaryIntents(contract)];
  const overlays = overlaysFromFlags(contract.riskFlags);
  if (contract.schemaVersion === 2 && contract.urgency === "incident") {
    if (!overlays.includes("emergency")) {
      overlays.push("emergency");
    }
  }
  const localScope = contract.inScope.length <= 3 && !contract.specPolicy.behaviorChanges;
  const reversible = contract.assumptions.every((item) => item.reversible);
  const behaviorChange = contract.specPolicy.behaviorChanges;
  let rewritten = false;
  const related: RelatedRunPlan[] = [];
  let blockedReason: string | undefined;

  if (primary === "refactor" && behaviorChange) {
    secondary = unique(["refactor", ...secondary.filter((item) => item !== "refactor")]);
    primary = "feature";
    rewritten = true;
  }
  if (primary === "bugfix" && (overlays.includes("emergency") || contract.riskFlags.includes("emergency"))) {
    related.push({
      schemaVersion: 1,
      relation: "permanent-fix",
      primaryIntent: "bugfix",
      overlays: overlays.filter((item) => item !== "emergency"),
      deliveryMode: "integration-branch",
      objective: contract.objective,
      deferred: false,
      blocksParent: true,
    });
    primary = "incident-response";
    rewritten = true;
  }
  if (primary === "research" && behaviorChange) {
    related.push({
      schemaVersion: 1,
      relation: "implementation",
      primaryIntent: "feature",
      overlays,
      deliveryMode: "integration-branch",
      objective: contract.objective,
      deferred: false,
      blocksParent: false,
    });
    rewritten = true;
  }
  if (primary === "documentation" && behaviorChange) {
    secondary = unique(["documentation", ...secondary.filter((item) => item !== "documentation")]);
    primary = intentFromKind(contract.kind === "spec" ? "feature" : contract.kind);
    rewritten = true;
  }
  if (primary === "feature" && overlays.includes("destructive") && overlays.includes("migration")) {
    related.push({
      schemaVersion: 1,
      relation: "migration-phase",
      primaryIntent: "migration",
      overlays,
      deliveryMode: "migration-series",
      objective: contract.objective,
      deferred: false,
      blocksParent: true,
    });
    rewritten = true;
  }
  if (primary === "optimization" && !measurableAcceptance(contract)) {
    blockedReason = "optimization requires measurable acceptance criteria";
  }
  if (primary === "deprecation-retirement" && !consumerEvidence(contract)) {
    blockedReason = "deprecation requires consumer evidence";
  }
  if (overlays.includes("emergency") && !rollbackEvidence(contract)) {
    blockedReason = "hotfix requires rollback evidence";
  }
  if (overlays.includes("destructive") && !destructiveAuthorized(contract)) {
    blockedReason = "destructive change requires explicit authorization";
  }

  const urgency: UrgencyLevel =
    contract.schemaVersion === 2 && contract.urgency !== undefined
      ? contract.urgency
      : overlays.includes("emergency")
        ? "incident"
        : "normal";
  const delivery = defaultDeliveryFor(primary, urgency);
  const composition: RunComposition = {
    schemaVersion: 2,
    primaryIntent: primary,
    secondaryIntents: secondary.filter((item) => item !== primary),
    overlays: unique(overlays),
    verificationPacks: packsForContract(contract, adapter, overlays),
    deliveryMode: delivery,
    urgency,
    executionBudget: executionBudgetFor({
      primary,
      overlays,
      localScope,
      reversible,
      behaviorChange,
    }),
    changeClass: changeClassFor(primary),
    ...(related.length === 0 ? {} : { splitIntoRelatedRuns: related }),
    ...(blockedReason === undefined ? {} : { blockedReason }),
  };
  return { composition, rewritten };
}

function emptyGraph(): GraphState {
  return {
    nodes: [],
    provenance: {},
    deferredGates: [],
    forbiddenActions: [],
  };
}

function addNode(graph: GraphState, node: WorkflowNode, provenance: NodeProvenance): void {
  const existing = graph.nodes.find((item) => item.id === node.id);
  if (existing !== undefined) {
    existing.dependsOn = unique([...existing.dependsOn, ...node.dependsOn]);
    existing.invalidates = unique([...existing.invalidates, ...node.invalidates]);
    if (existing.when === undefined && node.when !== undefined) {
      existing.when = node.when;
    }
    return;
  }
  graph.nodes.push(cloneNode(node));
  graph.provenance[node.id] = provenance;
}

function removeNode(graph: GraphState, id: string): void {
  graph.nodes = graph.nodes.filter((node) => node.id !== id);
  delete graph.provenance[id];
  for (const node of graph.nodes) {
    node.dependsOn = node.dependsOn.filter((dep) => dep !== id);
    node.invalidates = node.invalidates.filter((dep) => dep !== id);
  }
}

function nodeById(graph: GraphState, id: string): WorkflowNode | undefined {
  return graph.nodes.find((node) => node.id === id);
}

function attachBeforeAcceptance(graph: GraphState, node: WorkflowNode, provenance: NodeProvenance): void {
  const acceptance = nodeById(graph, "acceptance");
  const dependsOn =
    acceptance !== undefined && acceptance.dependsOn.length > 0
      ? acceptance.dependsOn.filter((id) => id !== node.id)
      : node.dependsOn;
  addNode(graph, { ...node, dependsOn }, provenance);
  if (acceptance !== undefined && !acceptance.dependsOn.includes(node.id)) {
    acceptance.dependsOn = unique([...acceptance.dependsOn, node.id]);
  }
}

function loadFragment(intent: PrimaryIntent): WorkflowNode[] {
  switch (intent) {
    case "feature":
      return cloneNodes(FEATURE_PROFILE.nodes.filter((node) => node.id !== "plan-critic"));
    case "bugfix":
      return cloneNodes(BUGFIX_PROFILE.nodes.filter((node) => node.id !== "second-hypothesis"));
    case "research":
      return cloneNodes(RESEARCH_PROFILE.nodes);
    case "specification":
    case "requirements":
      return cloneNodes(SPEC_ONLY_PROFILE.nodes);
    case "refactor":
      return cloneNodes(REFACTOR_PROFILE.nodes);
    case "diagnosis":
      return [
        workflowNode("analyst", { role: "analyst", concurrencyGroup: "read" }),
        workflowNode("reproduction-investigator", {
          role: "investigator",
          dependsOn: ["analyst"],
          concurrencyGroup: "read",
        }),
        workflowNode("root-cause-investigator", {
          role: "investigator",
          dependsOn: ["reproduction-investigator"],
          concurrencyGroup: "read",
        }),
        workflowNode("blast-radius-investigator", {
          role: "investigator",
          dependsOn: ["root-cause-investigator"],
          concurrencyGroup: "read",
        }),
        workflowNode("synthesizer", {
          role: "final-synthesizer",
          dependsOn: ["blast-radius-investigator"],
          concurrencyGroup: "review",
        }),
        workflowNode("evidence-completeness", {
          operation: "EVIDENCE_COMPLETENESS",
          dependsOn: ["synthesizer"],
        }),
        workflowNode("acceptance", { operation: "ACCEPTANCE", dependsOn: ["evidence-completeness"] }),
      ];
    case "optimization":
      return [
        workflowNode("analyst", { role: "analyst", concurrencyGroup: "read" }),
        workflowNode("code-investigator", {
          role: "investigator",
          dependsOn: ["analyst"],
          concurrencyGroup: "read",
        }),
        workflowNode("characterization", {
          operation: "BASELINE_CHARACTERIZATION",
          dependsOn: ["code-investigator"],
        }),
        workflowNode("planner", {
          role: "planner",
          dependsOn: ["characterization"],
          concurrencyGroup: "read",
        }),
        workflowNode("implementer", {
          role: "implementer",
          dependsOn: ["planner"],
          concurrencyGroup: "write",
        }),
        workflowNode("verification", { operation: "VERIFICATION", dependsOn: ["implementer"] }),
        workflowNode("performance-reviewer", {
          role: "performance-reviewer",
          dependsOn: ["verification"],
          concurrencyGroup: "review",
        }),
        workflowNode("acceptance", { operation: "ACCEPTANCE", dependsOn: ["performance-reviewer"] }),
      ];
    case "dependency-upgrade":
      return [
        workflowNode("analyst", { role: "analyst", concurrencyGroup: "read" }),
        workflowNode("inventory-investigator", {
          role: "investigator",
          dependsOn: ["analyst"],
          concurrencyGroup: "read",
        }),
        workflowNode("planner", {
          role: "planner",
          dependsOn: ["inventory-investigator"],
          concurrencyGroup: "read",
        }),
        workflowNode("implementer", {
          role: "implementer",
          dependsOn: ["planner"],
          concurrencyGroup: "write",
        }),
        workflowNode("verification", { operation: "VERIFICATION", dependsOn: ["implementer"] }),
        workflowNode("reviewer", {
          role: "reviewer",
          dependsOn: ["verification"],
          concurrencyGroup: "review",
        }),
        ...writeRepairTail("verification"),
        workflowNode("acceptance", { operation: "ACCEPTANCE", dependsOn: ["reviewer"] }),
      ];
    case "migration":
      return [
        workflowNode("analyst", { role: "analyst", concurrencyGroup: "read" }),
        workflowNode("phase-investigator", {
          role: "investigator",
          dependsOn: ["analyst"],
          concurrencyGroup: "read",
        }),
        workflowNode("planner", {
          role: "planner",
          dependsOn: ["phase-investigator"],
          concurrencyGroup: "read",
        }),
        workflowNode("implementer", {
          role: "implementer",
          dependsOn: ["planner"],
          concurrencyGroup: "write",
        }),
        workflowNode("migration-dry-run", {
          operation: "MIGRATION_DRY_RUN",
          dependsOn: ["implementer"],
        }),
        workflowNode("verification", { operation: "VERIFICATION", dependsOn: ["migration-dry-run"] }),
        workflowNode("reviewer", {
          role: "reviewer",
          dependsOn: ["verification"],
          concurrencyGroup: "review",
        }),
        ...writeRepairTail("verification"),
        workflowNode("acceptance", { operation: "ACCEPTANCE", dependsOn: ["reviewer"] }),
      ];
    case "security-remediation":
      return [
        workflowNode("analyst", { role: "analyst", concurrencyGroup: "read" }),
        workflowNode("confirmation-investigator", {
          role: "investigator",
          dependsOn: ["analyst"],
          concurrencyGroup: "read",
        }),
        workflowNode("similar-pattern-investigator", {
          role: "investigator",
          dependsOn: ["confirmation-investigator"],
          concurrencyGroup: "read",
        }),
        workflowNode("planner", {
          role: "planner",
          dependsOn: ["similar-pattern-investigator"],
          concurrencyGroup: "read",
        }),
        workflowNode("implementer", {
          role: "implementer",
          dependsOn: ["planner"],
          concurrencyGroup: "write",
        }),
        workflowNode("verification", { operation: "VERIFICATION", dependsOn: ["implementer"] }),
        workflowNode("security-reviewer", {
          role: "security-reviewer",
          dependsOn: ["verification"],
          concurrencyGroup: "review",
        }),
        ...writeRepairTail("verification", "security-reviewer"),
        workflowNode("acceptance", { operation: "ACCEPTANCE", dependsOn: ["security-reviewer"] }),
      ];
    case "incident-response":
      return [
        workflowNode("analyst", { role: "analyst", concurrencyGroup: "read" }),
        workflowNode("impact-investigator", {
          role: "investigator",
          dependsOn: ["analyst"],
          concurrencyGroup: "read",
        }),
        workflowNode("implementer", {
          role: "implementer",
          dependsOn: ["impact-investigator"],
          concurrencyGroup: "write",
        }),
        workflowNode("recovery-verification", {
          operation: "REGRESSION_VERIFICATION",
          dependsOn: ["implementer"],
        }),
        workflowNode("postmortem-synthesizer", {
          role: "final-synthesizer",
          dependsOn: ["recovery-verification"],
          concurrencyGroup: "review",
        }),
        workflowNode("acceptance", { operation: "ACCEPTANCE", dependsOn: ["postmortem-synthesizer"] }),
      ];
    case "deprecation-retirement":
      return [
        workflowNode("analyst", { role: "analyst", concurrencyGroup: "read" }),
        workflowNode("consumer-investigator", {
          role: "investigator",
          dependsOn: ["analyst"],
          concurrencyGroup: "read",
        }),
        workflowNode("planner", {
          role: "planner",
          dependsOn: ["consumer-investigator"],
          concurrencyGroup: "read",
        }),
        workflowNode("implementer", {
          role: "implementer",
          dependsOn: ["planner"],
          concurrencyGroup: "write",
        }),
        workflowNode("verification", { operation: "VERIFICATION", dependsOn: ["implementer"] }),
        workflowNode("architecture-reviewer", {
          role: "architecture-reviewer",
          dependsOn: ["verification"],
          concurrencyGroup: "review",
        }),
        workflowNode("acceptance", { operation: "ACCEPTANCE", dependsOn: ["architecture-reviewer"] }),
      ];
    case "test-engineering":
      return [
        workflowNode("analyst", { role: "analyst", concurrencyGroup: "read" }),
        workflowNode("characterization", {
          operation: "BASELINE_CHARACTERIZATION",
          dependsOn: ["analyst"],
        }),
        workflowNode("implementer", {
          role: "implementer",
          dependsOn: ["characterization"],
          concurrencyGroup: "write",
        }),
        workflowNode("verification", { operation: "VERIFICATION", dependsOn: ["implementer"] }),
        workflowNode("test-reviewer", {
          role: "test-reviewer",
          dependsOn: ["verification"],
          concurrencyGroup: "review",
        }),
        ...writeRepairTail("verification", "test-reviewer"),
        workflowNode("acceptance", { operation: "ACCEPTANCE", dependsOn: ["test-reviewer"] }),
      ];
    case "documentation":
      return [
        workflowNode("analyst", { role: "analyst", concurrencyGroup: "read" }),
        workflowNode("docs-investigator", {
          role: "investigator",
          dependsOn: ["analyst"],
          concurrencyGroup: "read",
        }),
        workflowNode("spec-author", {
          role: "implementer",
          dependsOn: ["docs-investigator"],
          concurrencyGroup: "write",
        }),
        workflowNode("spec-reviewer", {
          role: "spec-reviewer",
          dependsOn: ["spec-author"],
          concurrencyGroup: "review",
        }),
        workflowNode("acceptance", { operation: "ACCEPTANCE", dependsOn: ["spec-reviewer"] }),
      ];
    case "build-tooling":
      return [
        workflowNode("analyst", { role: "analyst", concurrencyGroup: "read" }),
        workflowNode("tooling-investigator", {
          role: "investigator",
          dependsOn: ["analyst"],
          concurrencyGroup: "read",
        }),
        workflowNode("implementer", {
          role: "implementer",
          dependsOn: ["tooling-investigator"],
          concurrencyGroup: "write",
        }),
        workflowNode("verification", { operation: "VERIFICATION", dependsOn: ["implementer"] }),
        workflowNode("reviewer", {
          role: "reviewer",
          dependsOn: ["verification"],
          concurrencyGroup: "review",
        }),
        ...writeRepairTail("verification"),
        workflowNode("acceptance", { operation: "ACCEPTANCE", dependsOn: ["reviewer"] }),
      ];
    case "architecture-design":
      return [
        workflowNode("analyst", { role: "analyst", concurrencyGroup: "read" }),
        workflowNode("architecture-investigator", {
          role: "investigator",
          dependsOn: ["analyst"],
          concurrencyGroup: "read",
        }),
        workflowNode("spec-author", {
          role: "implementer",
          dependsOn: ["architecture-investigator"],
          concurrencyGroup: "write",
        }),
        workflowNode("architecture-reviewer", {
          role: "architecture-reviewer",
          dependsOn: ["spec-author"],
          concurrencyGroup: "review",
        }),
        workflowNode("acceptance", { operation: "ACCEPTANCE", dependsOn: ["architecture-reviewer"] }),
      ];
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}

function writeRepairTail(verificationId: string, reviewId = "reviewer"): WorkflowNode[] {
  return [
    workflowNode("repair-implementer", {
      role: "implementer",
      dependsOn: [reviewId],
      when: "HAS_BLOCKING_FINDINGS",
      concurrencyGroup: "write",
      invalidates: [verificationId, reviewId],
    }),
    workflowNode("fresh-reviewer", {
      role: "reviewer",
      dependsOn: ["repair-implementer"],
      when: "HAS_BLOCKING_FINDINGS",
      concurrencyGroup: "review",
    }),
  ];
}

function secondaryNodes(intent: PrimaryIntent): WorkflowNode[] {
  switch (intent) {
    case "specification":
    case "requirements":
      return [
        workflowNode("spec-investigator", {
          role: "investigator",
          dependsOn: ["analyst"],
          concurrencyGroup: "read",
        }),
      ];
    case "documentation":
      return [
        workflowNode("docs-investigator", {
          role: "investigator",
          dependsOn: ["analyst"],
          concurrencyGroup: "read",
        }),
      ];
    case "test-engineering":
      return [
        workflowNode("characterization", {
          operation: "BASELINE_CHARACTERIZATION",
          dependsOn: ["analyst"],
        }),
      ];
    case "refactor":
      return [
        workflowNode("characterization", {
          operation: "BASELINE_CHARACTERIZATION",
          dependsOn: ["analyst"],
        }),
      ];
    case "security-remediation":
      return [
        workflowNode("similar-pattern-investigator", {
          role: "investigator",
          dependsOn: ["analyst"],
          concurrencyGroup: "read",
        }),
      ];
    case "research":
    case "diagnosis":
    case "architecture-design":
    case "feature":
    case "bugfix":
    case "optimization":
    case "dependency-upgrade":
    case "migration":
    case "build-tooling":
    case "incident-response":
    case "deprecation-retirement":
      return [];
    default: {
      const exhaustive: never = intent;
      return exhaustive;
    }
  }
}

function applyOverlay(graph: GraphState, overlay: RiskOverlay): void {
  switch (overlay) {
    case "security-sensitive":
      attachBeforeAcceptance(
        graph,
        workflowNode("security-reviewer", {
          role: "security-reviewer",
          dependsOn: ["reviewer"],
          concurrencyGroup: "review",
        }),
        { source: "overlay", id: overlay },
      );
      return;
    case "authentication":
      return;
    case "public-api":
      addNode(
        graph,
        workflowNode("consumer-investigator", {
          role: "investigator",
          dependsOn: ["analyst"],
          concurrencyGroup: "read",
        }),
        { source: "overlay", id: overlay },
      );
      attachBeforeAcceptance(
        graph,
        workflowNode("architecture-reviewer", {
          role: "architecture-reviewer",
          dependsOn: ["reviewer"],
          concurrencyGroup: "review",
        }),
        { source: "overlay", id: overlay },
      );
      return;
    case "data-mutation":
    case "migration":
      attachBeforeAcceptance(
        graph,
        workflowNode("migration-dry-run", {
          operation: "MIGRATION_DRY_RUN",
          dependsOn: ["implementer"],
        }),
        { source: "overlay", id: overlay },
      );
      return;
    case "concurrency":
      addNode(
        graph,
        workflowNode("second-hypothesis", {
          role: "investigator",
          dependsOn: nodeById(graph, "reproduction-investigator")
            ? ["reproduction-investigator"]
            : ["analyst"],
          concurrencyGroup: "read",
        }),
        { source: "overlay", id: overlay },
      );
      return;
    case "cross-cutting":
      attachBeforeAcceptance(
        graph,
        workflowNode("architecture-reviewer", {
          role: "architecture-reviewer",
          dependsOn: ["reviewer"],
          concurrencyGroup: "review",
        }),
        { source: "overlay", id: overlay },
      );
      return;
    case "ui-visible":
    case "external-contract":
      return;
    case "production-impact":
      attachBeforeAcceptance(
        graph,
        workflowNode("rollback-evidence", {
          operation: "ROLLBACK_EVIDENCE",
          dependsOn: ["verification"],
        }),
        { source: "overlay", id: overlay },
      );
      return;
    case "destructive":
      graph.forbiddenActions = unique([...graph.forbiddenActions, "apply-without-authorization"]);
      return;
    case "no-tests":
      addNode(
        graph,
        workflowNode("characterization", {
          operation: "BASELINE_CHARACTERIZATION",
          dependsOn: ["analyst"],
        }),
        { source: "overlay", id: overlay },
      );
      return;
    case "emergency": {
      const skip: ControllerOperation[] = ["SPEC_CONSISTENCY", "BEHAVIORAL_EQUIVALENCE"];
      for (const operation of skip) {
        const match = graph.nodes.find((node) => node.operation === operation);
        if (match !== undefined) {
          removeNode(graph, match.id);
          graph.deferredGates.push(operation);
        }
      }
      if (!graph.deferredGates.includes("SPEC_CONSISTENCY")) {
        graph.deferredGates.push("SPEC_CONSISTENCY");
      }
      return;
    }
    case "generated-code":
      addNode(
        graph,
        workflowNode("generator-investigator", {
          role: "investigator",
          dependsOn: ["analyst"],
          concurrencyGroup: "read",
        }),
        { source: "overlay", id: overlay },
      );
      return;
    default: {
      const exhaustive: never = overlay;
      throw new Error(`unhandled overlay ${String(exhaustive)}`);
    }
  }
}

function applyDelivery(graph: GraphState, mode: DeliveryMode): void {
  switch (mode) {
    case "analysis-only":
      for (const node of [...graph.nodes]) {
        if (node.role === "implementer" || node.concurrencyGroup === "write") {
          removeNode(graph, node.id);
        }
      }
      graph.forbiddenActions = unique([
        ...graph.forbiddenActions,
        "write-lease",
        "apply",
        "implementer",
      ]);
      return;
    case "spec-artifact":
      graph.forbiddenActions = unique([...graph.forbiddenActions, "apply-to-user-tree"]);
      return;
    case "integration-branch":
    case "patch":
    case "pull-request-ready":
      return;
    case "mitigation-patch":
      graph.forbiddenActions = unique([...graph.forbiddenActions, "apply-to-user-tree"]);
      if (!graph.deferredGates.includes("SPEC_CONSISTENCY")) {
        graph.deferredGates.push("SPEC_CONSISTENCY");
      }
      attachBeforeAcceptance(
        graph,
        workflowNode("rollback-evidence", {
          operation: "ROLLBACK_EVIDENCE",
          dependsOn: ["recovery-verification", "verification"].filter((id) => nodeById(graph, id)),
        }),
        { source: "delivery", id: mode },
      );
      return;
    case "migration-series":
      return;
    case "runbook":
      for (const node of [...graph.nodes]) {
        if (node.role === "implementer") {
          removeNode(graph, node.id);
        }
      }
      graph.forbiddenActions = unique([...graph.forbiddenActions, "apply", "write-lease"]);
      return;
    case "apply-to-worktree":
      return;
    default: {
      const exhaustive: never = mode;
      throw new Error(`unhandled delivery ${String(exhaustive)}`);
    }
  }
}

function applyBudget(graph: GraphState, budget: ExecutionBudget): void {
  switch (budget) {
    case "fast": {
      for (const id of [
        "planner",
        "plan-critic",
        "spec-investigator",
        "spec-consistency",
        "root-cause-investigator",
        "reproduction-investigator",
      ]) {
        if (nodeById(graph, id) !== undefined) {
          removeNode(graph, id);
        }
      }
      const source =
        nodeById(graph, "code-investigator") ??
        nodeById(graph, "investigator") ??
        graph.nodes.find((node) => node.role === "investigator");
      if (source !== undefined && source.id !== "investigator") {
        removeNode(graph, source.id);
        addNode(
          graph,
          { ...source, id: "investigator", dependsOn: ["analyst"] },
          { source: "budget", id: "fast" },
        );
      } else if (nodeById(graph, "investigator") === undefined && nodeById(graph, "analyst") !== undefined) {
        addNode(
          graph,
          workflowNode("investigator", {
            role: "investigator",
            dependsOn: ["analyst"],
            concurrencyGroup: "read",
          }),
          { source: "budget", id: "fast" },
        );
      }
      for (const extra of graph.nodes.filter(
        (node) => node.role === "investigator" && node.id !== "investigator",
      )) {
        removeNode(graph, extra.id);
      }
      const implementer = nodeById(graph, "implementer");
      if (implementer !== undefined) {
        implementer.dependsOn = ["investigator"];
      }
      return;
    }
    case "standard":
      return;
    case "thorough":
      if (nodeById(graph, "planner") !== undefined && nodeById(graph, "plan-critic") === undefined) {
        addNode(
          graph,
          workflowNode("plan-critic", {
            role: "architecture-reviewer",
            dependsOn: ["planner"],
            concurrencyGroup: "review",
          }),
          { source: "budget", id: "thorough" },
        );
      }
      return;
    default: {
      const exhaustive: never = budget;
      throw new Error(`unhandled budget ${String(exhaustive)}`);
    }
  }
}

function attachPackNodes(
  graph: GraphState,
  packs: readonly VerificationPackId[],
  adapter: ProjectAdapter,
): void {
  const resolved = packs.filter((id) => adapter.verification.packs?.[id] !== undefined);
  if (resolved.length === 0) {
    return;
  }
  if (nodeById(graph, "verification") === undefined && nodeById(graph, "implementer") !== undefined) {
    addNode(
      graph,
      workflowNode("verification", { operation: "VERIFICATION", dependsOn: ["implementer"] }),
      { source: "pack", id: resolved[0] ?? "frontend" },
    );
  }
}

function hasCycle(nodes: readonly WorkflowNode[]): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visit = (id: string): boolean => {
    if (visited.has(id)) {
      return false;
    }
    if (visiting.has(id)) {
      return true;
    }
    visiting.add(id);
    const node = byId.get(id);
    if (node !== undefined) {
      for (const dep of node.dependsOn) {
        if (visit(dep)) {
          return true;
        }
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return nodes.some((node) => visit(node.id));
}

function nodeIdsOf(profile: { nodes: readonly WorkflowNode[] }): string {
  return profile.nodes.map((node) => node.id).join(",");
}

function legacyLabel(graph: GraphState, composition: RunComposition): WorkflowProfileId {
  const ids = nodeIdsOf(graph);
  if (ids === nodeIdsOf(FAST_PROFILE)) {
    return "FAST";
  }
  if (ids === nodeIdsOf(FEATURE_PROFILE)) {
    return "FEATURE";
  }
  if (ids === nodeIdsOf(BUGFIX_PROFILE)) {
    return "BUGFIX";
  }
  if (ids === nodeIdsOf(RESEARCH_PROFILE)) {
    return "RESEARCH";
  }
  if (ids === nodeIdsOf(SPEC_ONLY_PROFILE)) {
    return "SPEC_ONLY";
  }
  if (ids === nodeIdsOf(REFACTOR_PROFILE)) {
    return "REFACTOR";
  }
  if (ids === nodeIdsOf(HIGH_RISK_PROFILE)) {
    return "HIGH_RISK";
  }
  if (composition.executionBudget === "fast") {
    return "FAST";
  }
  return kindFromIntent(composition.primaryIntent) === "bugfix"
    ? "BUGFIX"
    : kindFromIntent(composition.primaryIntent) === "research"
      ? "RESEARCH"
      : kindFromIntent(composition.primaryIntent) === "spec"
        ? "SPEC_ONLY"
        : kindFromIntent(composition.primaryIntent) === "refactor"
          ? "REFACTOR"
          : "FEATURE";
}

function requiredArtifactsFor(graph: GraphState, composition: RunComposition): CompiledProfile["requiredArtifacts"] {
  const artifacts = new Set<CompiledProfile["requiredArtifacts"][number]>(["task-contract", "acceptance-ledger"]);
  if (graph.nodes.some((node) => node.role === "investigator")) {
    artifacts.add("investigation-report");
  }
  if (graph.nodes.some((node) => node.role === "planner")) {
    artifacts.add("implementation-plan");
  }
  if (graph.nodes.some((node) => node.role === "implementer") && WRITE_INTENTS.has(composition.primaryIntent)) {
    artifacts.add("change-manifest");
  }
  if (graph.nodes.some((node) => node.role === "reviewer" || node.role === "security-reviewer")) {
    artifacts.add("review-findings");
  }
  return [...artifacts];
}

function acceptancePolicyFor(composition: RunComposition): CompiledProfile["acceptancePolicy"] {
  const analysis = composition.deliveryMode === "analysis-only";
  return {
    requireReviewer: !analysis,
    requireCommandEvidence: !analysis,
    requireFreshReviewAfterRepair: !analysis,
    allowResearchWithoutWrite: analysis,
  };
}

export function compileRunComposition(input: CompileProfileInput): CompiledProfileResult {
  const adapter = input.adapter ?? lockProjectAdapter(undefined).adapter;
  const composition = input.composition;
  const graph = emptyGraph();
  for (const node of loadFragment(composition.primaryIntent)) {
    addNode(graph, node, { source: "intent", id: composition.primaryIntent });
  }
  for (const secondary of composition.secondaryIntents) {
    for (const node of secondaryNodes(secondary)) {
      addNode(graph, node, { source: "secondary", id: secondary });
    }
  }
  for (const overlay of composition.overlays) {
    applyOverlay(graph, overlay);
  }
  attachPackNodes(graph, composition.verificationPacks, adapter);
  applyDelivery(graph, composition.deliveryMode);
  applyBudget(graph, composition.executionBudget);
  if (hasCycle(graph.nodes)) {
    throw new Error("compiled profile contains a cycle");
  }
  if (graph.nodes.length > MAX_NODES) {
    throw new Error("compiled profile exceeds node budget");
  }
  const missingDeps = graph.nodes.flatMap((node) =>
    node.dependsOn.filter((dep) => nodeById(graph, dep) === undefined),
  );
  for (const node of graph.nodes) {
    node.dependsOn = node.dependsOn.filter((dep) => nodeById(graph, dep) !== undefined);
  }
  void missingDeps;
  const compiled: CompiledProfile = {
    schemaVersion: 2,
    id: legacyLabel(graph, composition),
    appliesTo: [kindFromIntent(composition.primaryIntent)],
    nodes: graph.nodes,
    requiredArtifacts: requiredArtifactsFor(graph, composition),
    acceptancePolicy: acceptancePolicyFor(composition),
    composition,
    nodeProvenance: graph.provenance,
    deferredGates: unique(graph.deferredGates),
    forbiddenActions: unique(graph.forbiddenActions),
  };
  const predicates: string[] = [];
  if (input.signals?.unstableBug === true || composition.overlays.includes("concurrency")) {
    predicates.push("UNSTABLE_BUG");
  }
  if (input.signals?.externalResearch === true) {
    predicates.push("EXTERNAL_RESEARCH");
  }
  if (composition.executionBudget === "thorough") {
    predicates.push("HIGH_RISK");
  }
  if (composition.blockedReason !== undefined) {
    predicates.push("COMPOSITION_BLOCKED");
  }
  if (composition.blockedReason === "destructive change requires explicit authorization") {
    predicates.push("NEED_DESTRUCTIVE_AUTH");
  }
  return {
    compiled,
    predicates,
    blocked: composition.blockedReason !== undefined,
  };
}

export function compileProfileFromContract(
  contract: TaskContract,
  adapter: ProjectAdapter = lockProjectAdapter(undefined).adapter,
): CompiledProfileResult {
  const decided = composeFromContract(contract, adapter);
  return compileRunComposition({
    composition: decided.composition,
    adapter,
    signals: {
      unstableBug: contract.riskFlags.includes("unstable-bug"),
      externalResearch: false,
      noTests: contract.riskFlags.includes("no-tests"),
    },
  });
}

export function parseCompiledProfile(value: unknown): CompiledProfile {
  if (!COMPILED_PROFILE.Check(value)) {
    throw new Error("compiled profile failed schema");
  }
  return value;
}

export function parseRunComposition(value: unknown): RunComposition {
  if (!RUN_COMPOSITION.Check(value)) {
    throw new Error("run composition failed schema");
  }
  return value;
}

export function isCompiledProfile(profile: { schemaVersion: number }): profile is CompiledProfile {
  return profile.schemaVersion === 2;
}

export function resolvedVerificationPacks(
  composition: RunComposition,
  adapter: ProjectAdapter,
): { id: VerificationPackId; commands: NonNullable<ProjectAdapter["verification"]["packs"]>[string] }[] {
  const packs = adapter.verification.packs ?? {};
  const resolved: {
    id: VerificationPackId;
    commands: NonNullable<ProjectAdapter["verification"]["packs"]>[string];
  }[] = [];
  for (const id of composition.verificationPacks) {
    const pack = packs[id];
    if (pack === undefined) {
      continue;
    }
    resolved.push({ id, commands: pack });
  }
  return resolved;
}
