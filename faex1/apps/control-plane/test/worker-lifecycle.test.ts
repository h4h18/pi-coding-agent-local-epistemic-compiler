import { expect, test } from "vitest";
import {
  consumeWithTimeout,
  runTimedAgentTurn,
  type AgentHandle,
  type AgentResult,
  type AgentRuntime,
} from "@pi-hec/agent-runtime";
import type { SpawnRequest } from "@pi-hec/contracts";

const HANDLE: AgentHandle = {
  agentId: "agent_01234567-89ab-7cde-8f01-23456789abcd",
  runId: "run_01234567-89ab-7cde-8f01-23456789abcd",
  nodeId: "analyst",
  role: "analyst",
  sessionId: "sess",
  toolProfile: "read",
  capabilityTokenId: "cap_01234567-89ab-7cde-8f01-23456789abcd",
  adapter: "control-plane-session",
  adapterVersion: "1.0.0",
  spawnedAt: "2026-09-13T00:00:00.000Z",
};

const SPAWN: SpawnRequest = {
  schemaVersion: 1,
  runId: HANDLE.runId,
  nodeId: "analyst",
  role: "analyst",
  modelDeploymentId: "cloud-analyst",
  toolProfile: "read",
  inputArtifacts: [],
  outputSchema: "task-contract",
  idempotencyKey: "analyst:1",
};

function hangingRuntime(input: {
  consume: () => Promise<AgentResult>;
  stop: () => Promise<void>;
  spawn?: () => Promise<AgentHandle>;
  stopAll?: () => Promise<void>;
}): AgentRuntime {
  return {
    async capabilities() {
      return {
        adapter: "control-plane-session",
        version: "1.0.0",
        steer: true,
        resume: true,
        stop: true,
        nestedDelegation: false,
        fallbackSubagent: "none",
      };
    },
    spawn: input.spawn ?? (async () => HANDLE),
    consume: input.consume,
    async steer() {
      return;
    },
    stop: input.stop,
    stopAll: input.stopAll ?? (async () => undefined),
    async reconcile(runId) {
      return { runId, handles: [], nodeStatuses: {} };
    },
  };
}

test("consume timeout rejects without waiting for a hung stop", async () => {
  let stopped = 0;
  const runtime = hangingRuntime({
    consume: () => new Promise(() => undefined),
    stop: async () => {
      stopped += 1;
      await new Promise(() => undefined);
    },
  });
  const started = Date.now();
  await expect(consumeWithTimeout(runtime, HANDLE, 40)).rejects.toThrow(/consume timeout/);
  expect(Date.now() - started).toBeLessThan(400);
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  expect(stopped).toBe(1);
});

test("job timeout covers a hung spawn and does not wait for stopAll", async () => {
  let stoppedAll = 0;
  const runtime = hangingRuntime({
    spawn: () => new Promise(() => undefined),
    consume: () => new Promise(() => undefined),
    stop: async () => new Promise(() => undefined),
    stopAll: async () => {
      stoppedAll += 1;
      await new Promise(() => undefined);
    },
  });
  const started = Date.now();
  await expect(runTimedAgentTurn(runtime, SPAWN, 40)).rejects.toThrow(/consume timeout/);
  expect(Date.now() - started).toBeLessThan(400);
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  expect(stoppedAll).toBe(1);
});
