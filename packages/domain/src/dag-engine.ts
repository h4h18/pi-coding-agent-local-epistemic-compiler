import type { NodeStatus, WorkflowNode, WorkflowProfile } from "@pi-hec/contracts";
import { nodeEnabled } from "./adaptive-router.js";

export type NodeRecord = {
  nodeId: string;
  status: NodeStatus;
  attempt: number;
  agentId?: string;
};

export type DagCursor = {
  profile: WorkflowProfile;
  nodes: readonly NodeRecord[];
  predicates: readonly string[];
};

export class DagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DagError";
  }
}

export function initialNodeRecords(profile: WorkflowProfile): NodeRecord[] {
  return profile.nodes.map((node) => ({
    nodeId: node.id,
    status: "PENDING" as const,
    attempt: 0,
  }));
}

export function recordOf(cursor: DagCursor, nodeId: string): NodeRecord {
  const found = cursor.nodes.find((node) => node.nodeId === nodeId);
  if (found === undefined) {
    throw new DagError(`unknown node ${nodeId}`);
  }
  return found;
}

export function workflowNodeOf(profile: WorkflowProfile, nodeId: string): WorkflowNode {
  const found = profile.nodes.find((node) => node.id === nodeId);
  if (found === undefined) {
    throw new DagError(`unknown workflow node ${nodeId}`);
  }
  return found;
}

function accepted(cursor: DagCursor, nodeId: string): boolean {
  return recordOf(cursor, nodeId).status === "ACCEPTED";
}

export function readyNodes(cursor: DagCursor): WorkflowNode[] {
  const ready: WorkflowNode[] = [];
  const writers = cursor.nodes.filter((node) => {
    if (node.status === "PENDING" || node.status === "FAILED" || node.status === "ACCEPTED") {
      return false;
    }
    const spec = workflowNodeOf(cursor.profile, node.nodeId);
    return spec.concurrencyGroup === "write" || spec.role === "implementer";
  });
  for (const spec of cursor.profile.nodes) {
    const current = recordOf(cursor, spec.id);
    if (current.status !== "PENDING" && current.status !== "RETRYING") {
      continue;
    }
    if (!nodeEnabled(spec.when, cursor.predicates)) {
      continue;
    }
    if (!spec.dependsOn.every((dep) => accepted(cursor, dep))) {
      continue;
    }
    if (
      (spec.concurrencyGroup === "write" || spec.role === "implementer") &&
      writers.length > 0
    ) {
      continue;
    }
    ready.push(spec);
  }
  return ready;
}

export function skippedDisabledNodes(cursor: DagCursor): string[] {
  return cursor.profile.nodes
    .filter((spec) => {
      const current = recordOf(cursor, spec.id);
      return current.status === "PENDING" && !nodeEnabled(spec.when, cursor.predicates);
    })
    .map((spec) => spec.id);
}

export function invalidateNodes(cursor: DagCursor, fromNodeId: string): NodeRecord[] {
  const spec = workflowNodeOf(cursor.profile, fromNodeId);
  const invalidated = new Set(spec.invalidates);
  return cursor.nodes.map((node) => {
    if (!invalidated.has(node.nodeId)) {
      return node;
    }
    return { nodeId: node.nodeId, status: "PENDING", attempt: node.attempt };
  });
}

export function dagComplete(cursor: DagCursor): boolean {
  return cursor.profile.nodes.every((spec) => {
    if (!nodeEnabled(spec.when, cursor.predicates)) {
      return true;
    }
    return recordOf(cursor, spec.id).status === "ACCEPTED";
  });
}

export function activeWriterCount(cursor: DagCursor): number {
  return cursor.nodes.filter((node) => {
    if (node.status === "PENDING" || node.status === "ACCEPTED" || node.status === "FAILED") {
      return false;
    }
    const spec = workflowNodeOf(cursor.profile, node.nodeId);
    return spec.concurrencyGroup === "write" || spec.role === "implementer";
  }).length;
}

export function assertSingleWriter(cursor: DagCursor): void {
  if (activeWriterCount(cursor) > 1) {
    throw new DagError("writer concurrency exceeds 1");
  }
}

export function replaceNode(cursor: DagCursor, next: NodeRecord): NodeRecord[] {
  return cursor.nodes.map((node) => (node.nodeId === next.nodeId ? next : node));
}
