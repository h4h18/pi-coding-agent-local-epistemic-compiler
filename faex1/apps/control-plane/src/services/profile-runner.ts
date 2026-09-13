import type {
  AgentProjection,
  AgentRole,
  NodeStatus,
  RunAgentsPage,
  RuntimeAdapterId,
  TaskContract,
  ToolProfile,
  WorkflowProfileId,
} from "@pi-hec/contracts";
import { ROLE_ARTIFACT_TYPES } from "@pi-hec/domain";
import {
  compileAcceptanceLedger,
  definitionOfDoneSatisfied,
  initialNodeRecords,
  selectWorkflowProfile,
  signalsFromContract,
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

export function selectAndPersistProfile(
  store: StateStore,
  scope: ProjectScope,
  runId: string,
  contract: TaskContract,
  now: string,
): { profileId: WorkflowProfileId; predicates: readonly string[] } {
  const selected = selectWorkflowProfile(signalsFromContract(contract));
  const existing = store.listAgentNodes(scope, runId);
  const byId = new Map(existing.map((node) => [node.nodeId, node]));
  store.upsertAgentNode(scope, {
    runId,
    nodeId: PROFILE_BINDING_NODE,
    attempt: 0,
    status: "ACCEPTED",
    operation: selected.profileId,
    idempotencyKey: `${runId}:profile:${selected.profileId}`,
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
  for (const record of initialNodeRecords(selected.profile)) {
    const previous = byId.get(record.nodeId);
    if (
      previous !== undefined &&
      previous.status !== "PENDING" &&
      previous.nodeId !== PROFILE_BINDING_NODE
    ) {
      continue;
    }
    const spec = selected.profile.nodes.find((node) => node.id === record.nodeId);
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
  return { profileId: selected.profileId, predicates: selected.predicates };
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
  if (binding?.operation !== undefined && isProfileId(binding.operation)) {
    return { ...page, profileId: asProfileId(binding.operation) };
  }
  return page;
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
