import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import {
  assembleWorkerContext,
  createControlPlaneSessionAdapter,
  createPiSdkSessionFactory,
  type AgentHandle,
  type AgentResult,
  type AgentRuntime,
} from "@pi-hec/agent-runtime";
import { ControlPlaneClient, jsonBody, type ClientResponse } from "@pi-hec/client";
import {
  objectDigestFromBytes,
  type ObjectDigest,
  type SpawnRequest,
  type WorkerArtifactEnvelope,
} from "@pi-hec/contracts";
import { contentDigestSha256 } from "@pi-hec/security";
import { parseSpawnRequest, type SpawnJobResult } from "./services/agent-jobs.js";

export const FAEX1_WORKER_RUNNER_ID = "faex1-worker";

type WorkerJobContext = {
  client: ControlPlaneClient;
  projectId: string;
};

const workerJobContext = new AsyncLocalStorage<WorkerJobContext>();

export type WorkerLease = {
  projectId: string;
  operationId: string;
  leaseToken: string;
  leaseGeneration: number;
  inputObjectDigest: ObjectDigest;
};

export type WorkerLeaseOutcome =
  | { outcome: "NO_JOB"; retryAfterMs: number }
  | { outcome: "LEASED"; job: WorkerLease };

export type ExecuteAgentJobResult = {
  kind: string;
  completed: boolean;
};

type SpawnJobHandle = SpawnJobResult["handle"];

function parseJson(body: Buffer): unknown {
  return JSON.parse(body.toString("utf8")) as unknown;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} missing`);
  }
  return value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} missing`);
  }
  return value;
}

function assertOk(response: ClientResponse, label: string): void {
  if (response.status >= 400) {
    throw new Error(`${label} failed: ${String(response.status)} ${response.body.toString("utf8")}`);
  }
}

function handleFields(handle: AgentHandle): SpawnJobHandle {
  return {
    agentId: handle.agentId,
    sessionId: handle.sessionId,
    adapter: handle.adapter,
    adapterVersion: handle.adapterVersion,
    toolProfile: handle.toolProfile,
    capabilityTokenId: handle.capabilityTokenId,
    spawnedAt: handle.spawnedAt,
  };
}

function failureReason(result: AgentResult): string {
  switch (result.outcome) {
    case "artifact":
      return "artifact";
    case "blocker":
      return `blocker:${result.questionId}`;
    case "failed":
      return result.reason;
    case "lost":
      return result.reason;
    default: {
      const exhaustive: never = result;
      return `unhandled union: ${JSON.stringify(exhaustive)}`;
    }
  }
}

export function createFaex1AgentRuntime(now: () => string): AgentRuntime {
  const sessionFactory = createPiSdkSessionFactory();
  return createControlPlaneSessionAdapter({
    sessionFactory,
    now,
    assemble: async (request) => {
      const job = workerJobContext.getStore();
      const sources: { path: string; text: string }[] = [];
      if (job !== undefined) {
        for (const artifact of request.inputArtifacts) {
          const response = await job.client.call({
            operationId: "getBlob",
            pathParams: { projectId: job.projectId, objectDigest: artifact.objectDigest },
          });
          assertOk(response, "getBlob");
          sources.push({ path: artifact.role, text: response.body.toString("utf8") });
        }
      }
      return assembleWorkerContext({
        role: request.role,
        outputSchema: request.outputSchema,
        priorArtifacts: request.inputArtifacts,
        sources,
      });
    },
    bridge: {
      requestContext: async () => ({ text: "", untrusted: true }),
      submitArtifact: async () => ({ accepted: true, issues: [] }),
      reportProgress: async () => {
        return;
      },
      reportBlocker: async () => {
        return;
      },
    },
    leaseFor: (request) => {
      if (request.workspaceLeaseId === undefined) {
        return undefined;
      }
      const createdAt = now();
      const overlayPath = `/var/lib/pi-hec/agents/${request.runId}/${request.nodeId}`;
      mkdirSync(overlayPath, { recursive: true });
      return {
        schemaVersion: 1,
        leaseId: request.workspaceLeaseId,
        runId: request.runId,
        nodeId: request.nodeId,
        overlayPath,
        branch: "hec/run",
        baseCommit: "base",
        allowedPaths: [],
        isolationVerified: true,
        createdAt,
        expiresAt: new Date(Date.parse(createdAt) + 3_600_000).toISOString(),
      };
    },
  });
}

export async function leaseWorkerJob(input: {
  client: ControlPlaneClient;
  runnerId: string;
  capabilitiesObjectDigest: string;
}): Promise<WorkerLeaseOutcome> {
  const response = await input.client.call({
    operationId: "leaseRunnerJob",
    body: jsonBody({
      schemaVersion: 1,
      runnerId: input.runnerId,
      capabilitiesObjectDigest: input.capabilitiesObjectDigest,
      maxJobs: 1,
    }),
    headers: { "content-type": "application/json" },
  });
  assertOk(response, "leaseRunnerJob");
  const record = asRecord(parseJson(response.body), "lease");
  const outcome = requireString(record, "outcome");
  if (outcome === "NO_JOB") {
    const retryAfterMs = record.retryAfterMs;
    return {
      outcome: "NO_JOB",
      retryAfterMs: typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? retryAfterMs : 2000,
    };
  }
  if (outcome !== "LEASED") {
    throw new Error(`unhandled lease outcome ${outcome}`);
  }
  const digest = requireString(record, "inputObjectDigest");
  if (!digest.startsWith("sha256:")) {
    throw new Error("lease input digest missing");
  }
  return {
    outcome: "LEASED",
    job: {
      projectId: requireString(record, "projectId"),
      operationId: requireString(record, "operationId"),
      leaseToken: requireString(record, "leaseToken"),
      leaseGeneration: requireNumber(record, "leaseGeneration"),
      inputObjectDigest: digest as ObjectDigest,
    },
  };
}

async function putJsonBlob(
  client: ControlPlaneClient,
  projectId: string,
  value: unknown,
): Promise<ObjectDigest> {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  const objectDigest = objectDigestFromBytes(bytes);
  const stored = await client.call({
    operationId: "putBlob",
    pathParams: { projectId, objectDigest },
    body: bytes,
    headers: {
      "content-type": "application/octet-stream",
      "content-digest": contentDigestSha256(bytes),
    },
  });
  if (stored.status !== 201 && stored.status !== 204) {
    throw new Error(`putBlob failed: ${String(stored.status)} ${stored.body.toString("utf8")}`);
  }
  return objectDigest;
}

async function readSpawnRequest(
  client: ControlPlaneClient,
  job: WorkerLease,
): Promise<SpawnRequest> {
  const response = await client.call({
    operationId: "getBlob",
    pathParams: { projectId: job.projectId, objectDigest: job.inputObjectDigest },
  });
  assertOk(response, "getBlob");
  return parseSpawnRequest(parseJson(response.body));
}

async function heartbeatJob(client: ControlPlaneClient, job: WorkerLease): Promise<void> {
  const response = await client.call({
    operationId: "heartbeatOperation",
    pathParams: { projectId: job.projectId, operationId: job.operationId },
    body: jsonBody({
      schemaVersion: 1,
      leaseToken: job.leaseToken,
      leaseGeneration: job.leaseGeneration,
      observedInputObjectDigest: job.inputObjectDigest,
    }),
    headers: { "content-type": "application/json" },
  });
  assertOk(response, "heartbeatOperation");
}

async function completeSucceeded(
  client: ControlPlaneClient,
  job: WorkerLease,
  resultObjectDigest: ObjectDigest,
): Promise<void> {
  const response = await client.call({
    operationId: "completeOperation",
    pathParams: { projectId: job.projectId, operationId: job.operationId },
    body: jsonBody({
      schemaVersion: 1,
      leaseToken: job.leaseToken,
      leaseGeneration: job.leaseGeneration,
      outcome: "SUCCEEDED",
      resultObjectDigest,
    }),
    headers: { "content-type": "application/json" },
  });
  assertOk(response, "completeOperation");
}

async function completeFailed(
  client: ControlPlaneClient,
  job: WorkerLease,
  reason: string,
): Promise<void> {
  const errorObjectDigest = await putJsonBlob(client, job.projectId, {
    schemaVersion: 1,
    reason,
  });
  const response = await client.call({
    operationId: "completeOperation",
    pathParams: { projectId: job.projectId, operationId: job.operationId },
    body: jsonBody({
      schemaVersion: 1,
      leaseToken: job.leaseToken,
      leaseGeneration: job.leaseGeneration,
      outcome: "FAILED",
      errorObjectDigest,
    }),
    headers: { "content-type": "application/json" },
  });
  assertOk(response, "completeOperation");
}

async function consumeWithTimeout(runtime: AgentRuntime, handle: AgentHandle): Promise<AgentResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void runtime.stop(handle).finally(() => {
        reject(new Error("consume timeout"));
      });
    }, 15 * 60 * 1000);
  });
  try {
    return await Promise.race([runtime.consume(handle), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function runSpawnJob(
  client: ControlPlaneClient,
  job: WorkerLease,
  runtime: AgentRuntime,
  spawn: SpawnRequest,
): Promise<void> {
  let handle: AgentHandle;
  let result: AgentResult;
  try {
    handle = await runtime.spawn(spawn);
    result = await consumeWithTimeout(runtime, handle);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    process.stdout.write(
      `${JSON.stringify({ ok: false, operationId: job.operationId, outcome: "failed", reason })}\n`,
    );
    await completeFailed(client, job, reason);
    return;
  }
  if (result.outcome !== "artifact") {
    const reason = failureReason(result);
    process.stdout.write(
      `${JSON.stringify({ ok: false, operationId: job.operationId, outcome: result.outcome, reason })}\n`,
    );
    await completeFailed(client, job, reason);
    return;
  }
  const payload: SpawnJobResult = {
    schemaVersion: 1,
    handle: handleFields(handle),
    envelope: result.envelope as WorkerArtifactEnvelope,
  };
  const resultObjectDigest = await putJsonBlob(client, job.projectId, payload);
  await completeSucceeded(client, job, resultObjectDigest);
  process.stdout.write(
    `${JSON.stringify({ ok: true, operationId: job.operationId, outcome: "artifact", resultObjectDigest })}\n`,
  );
}

async function keepLeaseAlive(
  client: ControlPlaneClient,
  job: WorkerLease,
  work: () => Promise<void>,
): Promise<void> {
  await heartbeatJob(client, job);
  const timer = setInterval(() => {
    void heartbeatJob(client, job).catch((error: unknown) => {
      process.stderr.write(`${JSON.stringify({ ok: false, error: String(error), during: "heartbeat" })}\n`);
    });
  }, 10_000);
  try {
    await work();
  } finally {
    clearInterval(timer);
  }
}

export async function executeLeasedAgentJob(input: {
  client: ControlPlaneClient;
  job: WorkerLease;
  runtime: AgentRuntime;
}): Promise<ExecuteAgentJobResult> {
  const got = await input.client.call({
    operationId: "getOperation",
    pathParams: { projectId: input.job.projectId, operationId: input.job.operationId },
  });
  assertOk(got, "getOperation");
  const operation = asRecord(parseJson(got.body), "operation");
  const kind = requireString(operation, "kind");
  if (kind !== "SPAWN_AGENT") {
    return { kind, completed: false };
  }
  const spawn = await readSpawnRequest(input.client, input.job);
  await workerJobContext.run({ client: input.client, projectId: input.job.projectId }, async () => {
    await keepLeaseAlive(input.client, input.job, async () => {
      await runSpawnJob(input.client, input.job, input.runtime, spawn);
    });
  });
  return { kind, completed: true };
}

export async function drainWorkerUntilIdle(input: {
  client: ControlPlaneClient;
  runtime: AgentRuntime;
  runnerId: string;
  capabilitiesObjectDigest: string;
  maxJobs?: number;
}): Promise<number> {
  const limit = input.maxJobs ?? 32;
  let executed = 0;
  for (let wave = 0; wave < limit; wave += 1) {
    const leased = await leaseWorkerJob({
      client: input.client,
      runnerId: input.runnerId,
      capabilitiesObjectDigest: input.capabilitiesObjectDigest,
    });
    if (leased.outcome === "NO_JOB") {
      return executed;
    }
    const executedJob = await executeLeasedAgentJob({
      client: input.client,
      job: leased.job,
      runtime: input.runtime,
    });
    if (!executedJob.completed) {
      throw new Error(`unexpected worker kind ${executedJob.kind}`);
    }
    executed += 1;
  }
  throw new Error("worker drain saturated");
}
