import {
  asObjectDigest,
  isObjectDigest,
  type AgentProjection,
  type AgentRole,
  type CompiledProfile,
  type NodeStatus,
  type ObjectDigest,
  type ProjectAdapter,
  type RunAgentsPage,
  type RuntimeAdapterId,
  type TaskContract,
  type ToolProfile,
  type WorkflowProfileId,
} from "@pi-hec/contracts";
import { ROLE_ARTIFACT_TYPES } from "@pi-hec/domain";
import {
  compileAcceptanceLedger,
  compileProfileFromContract,
  definitionOfDoneSatisfied,
  initialNodeRecords,
  lockProjectAdapter,
  parseCompiledProfile,
  parseRunComposition,
  type CriterionEvidenceInput,
} from "@pi-hec/domain";
import type { ProjectScope } from "@pi-hec/domain";
import type { StateStore } from "@pi-hec/state-store";

export const PROFILE_BINDING_NODE = "profile";
export const PREDICATES_NODE = "predicates";

const NODE_STATUS: ReadonlySet<string> = new Set([
  "PENDING",
  "SPAWNED",
  "WAITING_ARTIFACT",
  "VALIDATING",
  "ACCEPTED",
  "RETRYING",
  "FAILED",
]);

const AGENT_ROLES: ReadonlySet<string> = new Set([
  "analyst",
  "investigator",
  "planner",
  "implementer",
  "reviewer",
  "spec-reviewer",
  "security-reviewer",
  "architecture-reviewer",
  "test-reviewer",
  "performance-reviewer",
  "conflict-resolver",
  "final-synthesizer",
]);

const TOOL_PROFILES: ReadonlySet<string> = new Set(["read", "write", "review"]);

const ADAPTERS: ReadonlySet<string> = new Set([
  "control-plane-session",
  "direct-provider-loop",
  "pi-subagents",
]);

const PROFILE_IDS: ReadonlySet<string> = new Set([
  "FAST",
  "STANDARD",
  "HIGH_RISK",
  "RESEARCH",
  "SPEC_ONLY",
  "FEATURE",
  "BUGFIX",
  "REFACTOR",
]);

export function asNodeStatus(value: string): NodeStatus {
  if (!NODE_STATUS.has(value)) {
    throw new Error(`unhandled union: ${JSON.stringify(value)}`);
  }
  return value as NodeStatus;
}

export function asRole(value: string): AgentRole {
  if (!AGENT_ROLES.has(value)) {
    throw new Error(`unhandled union: ${JSON.stringify(value)}`);
  }
  return value as AgentRole;
}

export function asToolProfile(value: string): ToolProfile {
  if (!TOOL_PROFILES.has(value)) {
    throw new Error(`unhandled union: ${JSON.stringify(value)}`);
  }
  return value as ToolProfile;
}

export function asAdapter(value: string): RuntimeAdapterId {
  if (!ADAPTERS.has(value)) {
    throw new Error(`unhandled union: ${JSON.stringify(value)}`);
  }
  return value as RuntimeAdapterId;
}

export function asProfileId(value: string): WorkflowProfileId {
  if (!PROFILE_IDS.has(value)) {
    throw new Error(`unhandled union: ${JSON.stringify(value)}`);
  }
  return value as WorkflowProfileId;
}

export function isProfileId(value: string): value is WorkflowProfileId {
  return PROFILE_IDS.has(value);
}

export function loadPersistedCompiledProfile(
  store: StateStore,
  scope: ProjectScope,
  runId: string,
): CompiledProfile | undefined {
  const row = store.getCompiledProfile(scope, runId);
  if (row === undefined) {
    return undefined;
  }
  return parseCompiledProfile(JSON.parse(row.profileJson) as unknown);
}

export async function loadLockedProjectAdapter(
  store: StateStore,
  scope: ProjectScope,
  runId: string,
  loadJson?: (digest: ObjectDigest) => Promise<unknown>,
): Promise<ProjectAdapter> {
  const digest = store
    .getRun(scope, runId)
    .artifactRoles.find((entry) => entry.role === "project-lock")?.objectDigests[0];
  if (digest === undefined) {
    return lockProjectAdapter(undefined).adapter;
  }
  if (!isObjectDigest(digest)) {
    throw new Error("project-lock digest invalid");
  }
  if (loadJson === undefined) {
    throw new Error("project-lock requires CAS loader");
  }
  return lockProjectAdapter(await loadJson(asObjectDigest(digest))).adapter;
}

export function selectAndPersistProfile(
  store: StateStore,
  scope: ProjectScope,
  runId: string,
  contract: TaskContract,
  now: string,
  adapter: ProjectAdapter = lockProjectAdapter(undefined).adapter,
): {
  profileId: WorkflowProfileId;
  predicates: readonly string[];
  compiled: CompiledProfile;
  blocked: boolean;
} {
  const selected = compileProfileFromContract(contract, adapter);
  const existing = store.listAgentNodes(scope, runId);
  const byId = new Map(existing.map((node) => [node.nodeId, node]));
  store.putCompiledProfile(scope, {
    runId,
    profileJson: JSON.stringify(selected.compiled),
    compositionJson: JSON.stringify(selected.compiled.composition),
    legacyProfileId: selected.compiled.id,
    updatedAt: now,
    ...(selected.compiled.composition.blockedReason === undefined
      ? {}
      : { blockedReason: selected.compiled.composition.blockedReason }),
  });
  const related = selected.compiled.composition.splitIntoRelatedRuns ?? [];
  for (const [index, plan] of related.entries()) {
    store.putRelatedRun(scope, {
      parentRunId: runId,
      planId: `related-${String(index + 1)}`,
      relation: plan.relation,
      planJson: JSON.stringify(plan),
      deferred: plan.deferred,
      blocksParent: plan.blocksParent,
      status: "planned",
      createdAt: now,
    });
  }
  store.upsertAgentNode(scope, {
    runId,
    nodeId: PROFILE_BINDING_NODE,
    attempt: 0,
    status: "ACCEPTED",
    operation: selected.compiled.id,
    idempotencyKey: `${runId}:profile:${selected.compiled.id}`,
    updatedAt: now,
  });
  if (selected.predicates.length > 0) {
    store.upsertAgentNode(scope, {
      runId,
      nodeId: PREDICATES_NODE,
      attempt: 0,
      status: "ACCEPTED",
      operation: selected.predicates.join(","),
      idempotencyKey: `${runId}:predicates`,
      updatedAt: now,
    });
  }
  for (const record of initialNodeRecords(selected.compiled)) {
    const previous = byId.get(record.nodeId);
    if (
      previous !== undefined &&
      previous.status !== "PENDING" &&
      previous.nodeId !== PROFILE_BINDING_NODE
    ) {
      continue;
    }
    const spec = selected.compiled.nodes.find((node) => node.id === record.nodeId);
    store.upsertAgentNode(scope, {
      runId,
      nodeId: record.nodeId,
      attempt: record.attempt,
      status: record.status,
      idempotencyKey: `${runId}:${record.nodeId}:0`,
      updatedAt: now,
      ...(spec?.role === undefined ? {} : { role: spec.role }),
      ...(spec?.operation === undefined ? {} : { operation: spec.operation }),
    });
  }
  return {
    profileId: selected.compiled.id,
    predicates: selected.predicates,
    compiled: selected.compiled,
    blocked: selected.blocked,
  };
}

export function buildRunAgentsPage(
  store: StateStore,
  scope: ProjectScope,
  runId: string,
): RunAgentsPage {
  const run = store.getRun(scope, runId);
  const handles = store.listAgentHandles(scope, runId);
  const nodes = store.listAgentNodes(scope, runId);
  const byNode = new Map(nodes.map((node) => [node.nodeId, node]));
  const binding = nodes.find((node) => node.nodeId === PROFILE_BINDING_NODE);
  const agents = handles.map((handle): AgentProjection => {
    const node = byNode.get(handle.nodeId);
    const role = asRole(handle.role);
    const artifactType = ROLE_ARTIFACT_TYPES[role][0];
    const projection: AgentProjection = {
      schemaVersion: 1,
      runId: run.runId,
      nodeId: handle.nodeId,
      agentId: handle.agentId as AgentProjection["agentId"],
      role,
      status: asNodeStatus(node?.status ?? "SPAWNED"),
      toolProfile: asToolProfile(handle.toolProfile),
      sessionId: handle.sessionId,
      adapter: asAdapter(handle.adapter),
      attempt: node?.attempt ?? 0,
      spawnedAt: handle.spawnedAt,
      updatedAt: node?.updatedAt ?? handle.lastHeartbeatAt,
    };
    if (node?.artifactDigest !== undefined && artifactType !== undefined) {
      const withType: AgentProjection = {
        ...projection,
        artifactType,
        artifactObjectDigest: node.artifactDigest as NonNullable<
          AgentProjection["artifactObjectDigest"]
        >,
      };
      if (handle.leaseId !== undefined) {
        return {
          ...withType,
          leaseId: handle.leaseId as NonNullable<AgentProjection["leaseId"]>,
        };
      }
      return withType;
    }
    if (handle.leaseId !== undefined) {
      return {
        ...projection,
        leaseId: handle.leaseId as NonNullable<AgentProjection["leaseId"]>,
      };
    }
    return projection;
  });
  const page: RunAgentsPage = {
    schemaVersion: 1,
    runId: run.runId,
    state: run.state,
    agents,
  };
  const compiledRow = store.getCompiledProfile(scope, runId);
  const compiledDigest = run.artifactRoles.find(
    (entry) => entry.role === "compiled-profile" || entry.role === "workflow-profile",
  )?.objectDigests[0];
  const withComposition: RunAgentsPage = {
    ...page,
    ...(compiledRow === undefined
      ? {}
      : { composition: parseRunComposition(JSON.parse(compiledRow.compositionJson) as unknown) }),
    ...(compiledDigest !== undefined && isObjectDigest(compiledDigest)
      ? { compiledProfileDigest: asObjectDigest(compiledDigest) }
      : {}),
  };
  if (binding?.operation !== undefined && isProfileId(binding.operation)) {
    return { ...withComposition, profileId: asProfileId(binding.operation) };
  }
  return withComposition;
}

export function evaluateAcceptance(input: CriterionEvidenceInput): {
  ledger: ReturnType<typeof compileAcceptanceLedger>;
  done: boolean;
} {
  const ledger = compileAcceptanceLedger(input);
  return {
    ledger,
    done: definitionOfDoneSatisfied({
      contractValid: true,
      ledger,
      integrationCommit: input.integrationCommit,
      baselineCommit: input.integrationCommit,
      outOfScopeChanges: false,
      gatesPassed: ledger.closed,
      blockingFindings: input.blockingFindings,
      freshReviewAfterRepair: true,
      specSatisfied: input.specUpdateSatisfied,
      userTreeUntouched: true,
    }),
  };
}
