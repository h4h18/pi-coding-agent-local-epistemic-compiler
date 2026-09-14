import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_AGENT_OVERLAY_ROOT,
  overlayPathFor,
  type AgentHandle,
  type AgentRuntime,
} from "@pi-hec/agent-runtime";
import type {
  ChangeManifest,
  InvestigationReport,
  ReviewFindings,
  SpawnRequest,
  TaskContract,
  WorkerArtifactEnvelope,
} from "@pi-hec/contracts";
import { asAgentId, asCapabilityTokenId, randomPrefixedUuidV7 } from "@pi-hec/contracts";

export const FAST_EVAL_ROLES = ["analyst", "investigator", "implementer", "reviewer"] as const;

function taskContract(objective: string): TaskContract {
  return {
    schemaVersion: 1,
    taskId: "task-golden-eval",
    kind: "bugfix",
    objective,
    inScope: ["src/auth/session.ts"],
    outOfScope: ["src/auth/public-api.ts"],
    constraints: ["do not change public API"],
    assumptions: [
      { id: "a1", text: "change is local and reversible", reversible: true, evidence: [] },
    ],
    acceptanceCriteria: [
      {
        id: "ac1",
        statement: "newest token is preserved",
        verification: ["test", "review"],
        requiredEvidence: ["diff", "review"],
      },
    ],
    riskFlags: [],
    specPolicy: { paths: ["specs"], behaviorChanges: false, updateRequired: false },
    blockingQuestions: [],
  };
}

function investigationReport(handle: AgentHandle): InvestigationReport {
  return {
    schemaVersion: 1,
    runId: handle.runId,
    nodeId: handle.nodeId,
    agentId: handle.agentId,
    kind: "code",
    findings: [
      {
        id: "f1",
        claim: "overlapping refresh drops the newest token",
        evidence: ["src/auth/session.ts coalesces the first in-flight promise"],
        severity: "high",
      },
    ],
    contradictions: [],
    openQuestions: [],
  };
}

function changeManifest(handle: AgentHandle, changedPaths: readonly string[]): ChangeManifest {
  const leaseId = handle.workspaceLeaseId;
  if (leaseId === undefined) {
    throw new Error("implementer lease missing");
  }
  return {
    schemaVersion: 1,
    runId: handle.runId,
    nodeId: handle.nodeId,
    agentId: handle.agentId,
    leaseId,
    baseCommit: "base",
    changedPaths: [...changedPaths],
    specPaths: [],
    allowedPaths: [...changedPaths],
  };
}

function reviewFindings(handle: AgentHandle): ReviewFindings {
  return {
    schemaVersion: 1,
    runId: handle.runId,
    nodeId: handle.nodeId,
    agentId: handle.agentId,
    findings: [],
    blocking: false,
    summary: "no blocking findings",
  };
}

function envelopeFor(
  handle: AgentHandle,
  outputSchema: SpawnRequest["outputSchema"],
  objective: string,
  changedPaths: readonly string[],
): WorkerArtifactEnvelope {
  let payload: WorkerArtifactEnvelope["payload"];
  switch (handle.role) {
    case "analyst":
      payload = taskContract(objective);
      break;
    case "investigator":
    case "conflict-resolver":
    case "final-synthesizer":
      payload = investigationReport(handle);
      break;
    case "implementer":
      payload = changeManifest(handle, changedPaths);
      break;
    case "reviewer":
    case "spec-reviewer":
    case "security-reviewer":
    case "architecture-reviewer":
    case "test-reviewer":
    case "performance-reviewer":
      payload = reviewFindings(handle);
      break;
    case "planner":
      throw new Error(`FAST path does not spawn ${handle.role}`);
    default: {
      const exhaustive: never = handle.role;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
  return {
    schemaVersion: 1,
    artifactType: outputSchema,
    runId: handle.runId,
    nodeId: handle.nodeId,
    agentId: handle.agentId,
    inputs: [],
    payload,
  };
}

function writeSolverEdits(runId: string, nodeId: string, edits: Readonly<Record<string, string>>): void {
  const overlay = overlayPathFor(
    process.env.PI_HEC_AGENT_OVERLAY_ROOT ?? DEFAULT_AGENT_OVERLAY_ROOT,
    runId,
    nodeId,
  );
  for (const [relative, content] of Object.entries(edits)) {
    const destination = path.join(overlay, ...relative.split("/"));
    mkdirSync(path.dirname(destination), { recursive: true });
    writeFileSync(destination, content.replaceAll("\r\n", "\n"), "utf8");
  }
}

export function createEvalScriptedRuntime(input: {
  now: () => string;
  objective: string;
  solverEdits?: Readonly<Record<string, string>>;
}): AgentRuntime {
  const live = new Map<string, { handle: AgentHandle; outputSchema: SpawnRequest["outputSchema"] }>();
  const edits = input.solverEdits ?? {};
  const changedPaths = Object.keys(edits).length > 0 ? Object.keys(edits) : ["src/auth/session.ts"];
  return {
    capabilities() {
      return Promise.resolve({
        adapter: "control-plane-session" as const,
        version: "1.0.0",
        steer: true,
        resume: true,
        stop: true,
        nestedDelegation: false as const,
        fallbackSubagent: "none" as const,
      });
    },
    spawn(request) {
      const handle: AgentHandle = {
        agentId: asAgentId(randomPrefixedUuidV7("agent_")),
        runId: request.runId,
        nodeId: request.nodeId,
        role: request.role,
        sessionId: `sess-${request.nodeId}`,
        toolProfile: request.toolProfile,
        capabilityTokenId: asCapabilityTokenId(randomPrefixedUuidV7("cap_")),
        adapter: "control-plane-session",
        adapterVersion: "1.0.0",
        spawnedAt: input.now(),
        ...(request.workspaceLeaseId === undefined ? {} : { workspaceLeaseId: request.workspaceLeaseId }),
      };
      live.set(handle.agentId, { handle, outputSchema: request.outputSchema });
      if (request.role === "implementer") {
        writeSolverEdits(request.runId, request.nodeId, edits);
      }
      return Promise.resolve(handle);
    },
    consume(handle) {
      const stored = live.get(handle.agentId);
      if (stored === undefined) {
        return Promise.resolve({ outcome: "lost" as const, reason: "handle missing" });
      }
      return Promise.resolve({
        outcome: "artifact" as const,
        envelope: envelopeFor(stored.handle, stored.outputSchema, input.objective, changedPaths),
      });
    },
    steer() {
      return Promise.resolve();
    },
    stop(handle) {
      live.delete(handle.agentId);
      return Promise.resolve();
    },
    stopAll() {
      live.clear();
      return Promise.resolve();
    },
    reconcile(runId) {
      const handles = [...live.values()]
        .map((item) => item.handle)
        .filter((handle) => handle.runId === runId);
      return Promise.resolve({ runId, handles, nodeStatuses: {} });
    },
  };
}
