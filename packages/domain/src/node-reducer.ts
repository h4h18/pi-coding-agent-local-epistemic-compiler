import type { AgentNodeEventType, NodeStatus } from "@pi-hec/contracts";
import { DagError, type NodeRecord } from "./dag-engine.js";

const TRANSITIONS: Readonly<Record<NodeStatus, readonly AgentNodeEventType[]>> = {
  PENDING: ["NODE_SPAWNED"],
  SPAWNED: ["NODE_STEERED", "NODE_BLOCKED", "NODE_FAILED", "ARTIFACT_ACCEPTED", "NODE_RETRYING"],
  WAITING_ARTIFACT: ["ARTIFACT_ACCEPTED", "NODE_FAILED", "NODE_STEERED", "NODE_BLOCKED", "NODE_RETRYING"],
  VALIDATING: ["ARTIFACT_ACCEPTED", "NODE_FAILED", "NODE_RETRYING"],
  ACCEPTED: ["NODE_COMPLETED"],
  RETRYING: ["NODE_SPAWNED", "NODE_FAILED"],
  FAILED: ["NODE_SPAWNED"],
};

const NEXT: Readonly<Record<AgentNodeEventType, NodeStatus>> = {
  NODE_SPAWNED: "SPAWNED",
  ARTIFACT_ACCEPTED: "ACCEPTED",
  NODE_FAILED: "FAILED",
  NODE_COMPLETED: "ACCEPTED",
  NODE_RETRYING: "RETRYING",
  NODE_BLOCKED: "WAITING_ARTIFACT",
  NODE_STEERED: "WAITING_ARTIFACT",
};

export function reduceNode(
  current: NodeRecord,
  eventType: AgentNodeEventType,
  agentId?: string,
): NodeRecord {
  const allowed = TRANSITIONS[current.status];
  if (!allowed.includes(eventType)) {
    throw new DagError(`illegal node transition ${current.status} ${eventType}`);
  }
  const status = NEXT[eventType];
  if (status === undefined) {
    throw new DagError(`unhandled node event ${eventType}`);
  }
  const attempt =
    eventType === "NODE_RETRYING" || eventType === "NODE_SPAWNED"
      ? current.attempt + (eventType === "NODE_RETRYING" ? 1 : current.attempt === 0 ? 1 : 0)
      : current.attempt;
  return {
    nodeId: current.nodeId,
    status,
    attempt,
    ...(agentId === undefined && current.agentId === undefined
      ? {}
      : { agentId: agentId ?? current.agentId }),
  };
}

export function canRetry(current: NodeRecord, maxAttempts: number): boolean {
  return current.status === "FAILED" && current.attempt < maxAttempts;
}
