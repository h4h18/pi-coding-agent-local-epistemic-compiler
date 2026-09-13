import type {
  ArtifactType,
  NodeStatus,
  SpawnRequest,
  TaskContract,
  WorkflowProfile,
} from "@pi-hec/contracts";
import {
  dagComplete,
  readyNodes,
  recordOf,
  reduceNode,
  replaceNode,
  skippedDisabledNodes,
  type DagCursor,
  type NodeRecord,
} from "@pi-hec/domain";
import { ROLE_ARTIFACT_TYPES } from "@pi-hec/domain";
import { validateWorkerEnvelope } from "@pi-hec/domain";
import { consumeThenStop } from "./session-lifecycle.js";
import type { AgentRuntime } from "./types.js";

export type OrchestratorPorts = {
  now: () => string;
  modelDeploymentFor(role: SpawnRequest["role"]): string;
  persistNodes(nodes: readonly NodeRecord[]): Promise<void>;
  persistAcceptedArtifact(input: {
    nodeId: string;
    artifactType: ArtifactType;
    envelope: unknown;
  }): Promise<void>;
};

export type OrchestratorState = {
  runId: SpawnRequest["runId"];
  cursor: DagCursor;
  contract: TaskContract;
};

function outputTypeFor(role: SpawnRequest["role"]): ArtifactType {
  const types = ROLE_ARTIFACT_TYPES[role];
  const first = types[0];
  if (first === undefined) {
    throw new Error(`role ${role} has no artifact type`);
  }
  return first;
}

export async function advanceDag(
  runtime: AgentRuntime,
  state: OrchestratorState,
  ports: OrchestratorPorts,
): Promise<OrchestratorState> {
  let nodes = [...state.cursor.nodes];
  for (const skipped of skippedDisabledNodes({ ...state.cursor, nodes })) {
    const current = recordOf({ ...state.cursor, nodes }, skipped);
    nodes = replaceNode(
      { ...state.cursor, nodes },
      { ...current, status: "ACCEPTED" as NodeStatus },
    );
  }
  const cursor: DagCursor = { ...state.cursor, nodes };
  const ready = readyNodes(cursor);
  for (const spec of ready) {
    if (spec.role === undefined) {
      const current = recordOf(cursor, spec.id);
      nodes = replaceNode(cursor, {
        ...current,
        status: "ACCEPTED",
        attempt: current.attempt + 1,
      });
      continue;
    }
    const current = recordOf({ ...state.cursor, nodes }, spec.id);
    const spawned = reduceNode(current, "NODE_SPAWNED");
    nodes = replaceNode({ ...state.cursor, nodes }, spawned);
    const request: SpawnRequest = {
      schemaVersion: 1,
      runId: state.runId,
      nodeId: spec.id,
      role: spec.role,
      modelDeploymentId: ports.modelDeploymentFor(spec.role),
      toolProfile:
        spec.role === "implementer" ? "write" : spec.concurrencyGroup === "review" ? "review" : "read",
      inputArtifacts: [],
      outputSchema: outputTypeFor(spec.role),
      idempotencyKey: `${spec.id}:${String(spawned.attempt)}`,
    };
    const handle = await runtime.spawn(request);
    const result = await consumeThenStop(runtime, handle);
    if (result.outcome === "artifact") {
      const envelope = result.envelope as {
        schemaVersion: 1;
        artifactType: ArtifactType;
        runId: SpawnRequest["runId"];
        nodeId: string;
        agentId: typeof handle.agentId;
        inputs: [];
        payload: unknown;
      };
      const validated = validateWorkerEnvelope(envelope, {
        runId: handle.runId,
        nodeId: handle.nodeId,
        agentId: handle.agentId,
        artifactType: request.outputSchema,
      });
      if (!validated.ok) {
        nodes = replaceNode({ ...state.cursor, nodes }, reduceNode({ ...spawned, agentId: handle.agentId }, "NODE_RETRYING"));
        continue;
      }
      await ports.persistAcceptedArtifact({
        nodeId: spec.id,
        artifactType: request.outputSchema,
        envelope: result.envelope,
      });
      nodes = replaceNode(
        { ...state.cursor, nodes },
        reduceNode({ ...spawned, status: "VALIDATING", agentId: handle.agentId }, "ARTIFACT_ACCEPTED"),
      );
    } else if (result.outcome === "blocker") {
      nodes = replaceNode(
        { ...state.cursor, nodes },
        reduceNode({ ...spawned, agentId: handle.agentId }, "NODE_BLOCKED"),
      );
    } else {
      nodes = replaceNode(
        { ...state.cursor, nodes },
        reduceNode({ ...spawned, agentId: handle.agentId }, "NODE_FAILED"),
      );
    }
  }
  await ports.persistNodes(nodes);
  return { ...state, cursor: { ...state.cursor, nodes } };
}

export function profileReadyForAcceptance(profile: WorkflowProfile, cursor: DagCursor): boolean {
  return dagComplete(cursor) && profile.acceptancePolicy.requireReviewer
    ? cursor.nodes.some((node) => node.nodeId.includes("reviewer") && node.status === "ACCEPTED")
    : dagComplete(cursor);
}
