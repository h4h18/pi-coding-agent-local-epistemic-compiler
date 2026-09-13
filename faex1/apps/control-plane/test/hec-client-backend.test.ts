import { afterAll, beforeAll, expect, test } from "vitest";
import { Compile } from "typebox/compile";
import { jsonBody } from "@pi-hec/client";
import type { AgentHandle, AgentRuntime } from "@pi-hec/agent-runtime";
import type {
  ApiError,
  BrokerRequest,
  BrokerResponse,
  ChangeManifest,
  InvestigationReport,
  OperationProjection,
  ReviewFindings,
  RunAgentsPage,
  RunEventPage,
  RunId,
  RunProjection,
  SpawnRequest,
  TaskContract,
  WorkerArtifactEnvelope,
} from "@pi-hec/contracts";
import {
  ApiErrorSchema,
  OperationProjectionSchema,
  RunAgentsPageSchema,
  RunProjectionSchema,
  asAgentId,
  asCapabilityTokenId,
  asRunId,
  randomPrefixedUuidV7,
  sha256Utf8,
} from "@pi-hec/contracts";
import type { BrokerPort } from "../../../../client/apps/pi-extension/src/broker-client.js";
import { FakePi } from "../../../../client/apps/pi-extension/test/harness.js";
import {
  PROJECT_ID,
  RUN_ID,
  HOST_CAPABILITY,
  WORKSPACE_ID,
  parseJson,
  startHarness,
  type Harness,
} from "./harness.js";
import { FAEX1_WORKER_RUNNER_ID, drainWorkerUntilIdle } from "../src/worker-agent.js";

const RUN = Compile(RunProjectionSchema);
const AGENTS = Compile(RunAgentsPageSchema);
const OPERATION = Compile(OperationProjectionSchema);
const ERROR = Compile(ApiErrorSchema);

const FAST_ROLES = ["analyst", "investigator", "implementer", "reviewer"] as const;

let harness: Harness | undefined;

beforeAll(async () => {
  harness = await startHarness();
});

afterAll(async () => {
  if (harness !== undefined) {
    await harness.close();
  }
});

function requireHarness(): Harness {
  if (harness === undefined) {
    throw new Error("harness not started");
  }
  return harness;
}

function taskContract(objective: string): TaskContract {
  return {
    schemaVersion: 1,
    taskId: "task-local-feature",
    kind: "feature",
    objective,
    inScope: ["src/login.ts"],
    outOfScope: ["secrets"],
    constraints: ["do not touch generated files"],
    assumptions: [{ id: "a1", text: "change is local and reversible", reversible: true, evidence: [] }],
    acceptanceCriteria: [
      {
        id: "ac1",
        statement: "login form renders",
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
        claim: "login form is missing",
        evidence: ["src/login.ts is absent"],
        severity: "medium",
      },
    ],
    contradictions: [],
    openQuestions: [],
  };
}

function changeManifest(handle: AgentHandle): ChangeManifest {
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
    changedPaths: ["src/login.ts"],
    specPaths: [],
    allowedPaths: ["src/login.ts"],
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

function envelopeFor(handle: AgentHandle, outputSchema: SpawnRequest["outputSchema"]): WorkerArtifactEnvelope {
  let payload: WorkerArtifactEnvelope["payload"];
  switch (handle.role) {
    case "analyst":
      payload = taskContract("add a local login form");
      break;
    case "investigator":
    case "conflict-resolver":
    case "final-synthesizer":
      payload = investigationReport(handle);
      break;
    case "implementer":
      payload = changeManifest(handle);
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

function createScriptedAgentRuntime(now: () => string): AgentRuntime {
  const live = new Map<string, { handle: AgentHandle; outputSchema: SpawnRequest["outputSchema"] }>();
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
    async spawn(request) {
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
        spawnedAt: now(),
        ...(request.workspaceLeaseId === undefined ? {} : { workspaceLeaseId: request.workspaceLeaseId }),
      };
      live.set(handle.agentId, { handle, outputSchema: request.outputSchema });
      return handle;
    },
    async consume(handle) {
      const stored = live.get(handle.agentId);
      if (stored === undefined) {
        return { outcome: "lost", reason: "handle missing" };
      }
      return { outcome: "artifact", envelope: envelopeFor(stored.handle, stored.outputSchema) };
    },
    async steer() {
      return;
    },
    async stop(handle) {
      live.delete(handle.agentId);
    },
    async stopAll() {
      live.clear();
    },
    async reconcile(runId) {
      const handles = [...live.values()]
        .map((item) => item.handle)
        .filter((handle) => handle.runId === runId);
      return { runId, handles, nodeStatuses: {} };
    },
  };
}

function internalError(requestId: string, message: string): BrokerResponse {
  return {
    requestId,
    outcome: "ERROR",
    error: {
      schemaVersion: 1,
      code: "INTERNAL",
      message,
      retryClass: "ambiguous",
    },
  };
}

function httpError(requestId: string, body: Buffer): BrokerResponse {
  const parsed: unknown = parseJson(body);
  if (ERROR.Check(parsed)) {
    return { requestId, outcome: "ERROR", error: parsed };
  }
  return internalError(requestId, "control-plane error");
}

class ControlPlaneBroker implements BrokerPort {
  readonly brokerInstanceId = "broker-1";
  readonly connectionId = "conn-hec-e2e";
  lastRun: RunProjection | undefined;
  lastAgents: RunAgentsPage | undefined;
  lastOperation: OperationProjection | undefined;
  lastError: ApiError | undefined;

  constructor(private readonly world: Harness) {}

  async request(body: BrokerRequest): Promise<BrokerResponse> {
    switch (body.method) {
      case "START_RUN":
        return this.startRun(body.requestId, body.params.originalRequest);
      case "GET_RUN_STATUS":
      case "RESUME_RUN":
        return this.getRun(body.requestId, body.params.runId);
      case "LIST_AGENTS":
        return this.listAgents(body.requestId, body.params.runId);
      case "POLL_RUN_EVENTS":
        return this.pollEvents(body.requestId, body.params.runId, body.params.afterSequence, body.params.limit);
      case "PROVIDE_INPUT":
        return this.provideInput(body);
      case "REQUEST_REPAIR":
        return this.mutateRun(body.requestId, "requestRunRepair", body.params.runId, body.params.expectedStateVersion, {
          schemaVersion: 1,
          verdictReportObjectDigest: body.params.verdictReportObjectDigest,
        });
      case "CANCEL_RUN":
        return this.mutateRun(body.requestId, "cancelRun", body.params.runId, body.params.expectedStateVersion, {
          schemaVersion: 1,
          reason: body.params.reason,
        });
      case "OPEN_TRUSTED_VIEW":
      case "OPEN_APPROVAL":
        return {
          requestId: body.requestId,
          outcome: "TRUSTED_UI_OPENED",
          trustedUiSessionId: "tui_hec_e2e",
          nonce: "nonce-trusted-ui",
        };
      default: {
        const exhaustive: never = body;
        return exhaustive;
      }
    }
  }

  close(): void {
    return;
  }

  private async startRun(requestId: string, originalRequest: string): Promise<BrokerResponse> {
    const runId = asRunId(randomPrefixedUuidV7("run_"));
    const createdAt = this.world.clock();
    const response = await this.world.broker.call({
      operationId: "createRun",
      pathParams: { projectId: PROJECT_ID, runId },
      body: jsonBody({
        schemaVersion: 1,
        workspaceId: WORKSPACE_ID,
        task: {
          schemaVersion: 1,
          runId,
          originalRequest,
          originalRequestDigest: sha256Utf8(originalRequest),
          userScope: {
            allowedPathGlobs: [],
            forbiddenPathGlobs: [],
            forbiddenOperations: [],
          },
          attachments: [],
          requestedVerificationCommands: [],
          createdAt,
        },
      }),
      headers: { "content-type": "application/json" },
    });
    return this.runOutcome(requestId, response.status, response.body);
  }

  private async getRun(requestId: string, runId: RunId): Promise<BrokerResponse> {
    const response = await this.world.broker.call({
      operationId: "getRun",
      pathParams: { projectId: PROJECT_ID, runId },
    });
    return this.runOutcome(requestId, response.status, response.body);
  }

  private async listAgents(requestId: string, runId: RunId): Promise<BrokerResponse> {
    const response = await this.world.broker.call({
      operationId: "listRunAgents",
      pathParams: { projectId: PROJECT_ID, runId },
    });
    if (response.status >= 400) {
      const error = httpError(requestId, response.body);
      this.lastError = error.outcome === "ERROR" ? error.error : undefined;
      return error;
    }
    const parsed: unknown = parseJson(response.body);
    if (!AGENTS.Check(parsed)) {
      return internalError(requestId, "RunAgentsPage failed schema");
    }
    this.lastAgents = parsed;
    return { requestId, outcome: "AGENTS", agents: parsed };
  }

  private async pollEvents(
    requestId: string,
    runId: RunId,
    afterSequence: number,
    limit: number,
  ): Promise<BrokerResponse> {
    const response = await this.world.broker.call({
      operationId: "listRunEvents",
      pathParams: { projectId: PROJECT_ID, runId },
      query: { after: afterSequence, limit },
    });
    if (response.status >= 400) {
      return httpError(requestId, response.body);
    }
    const parsed: unknown = parseJson(response.body);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        requestId,
        outcome: "EVENTS",
        page: { schemaVersion: 1, events: [], nextAfter: null },
      };
    }
    return { requestId, outcome: "EVENTS", page: parsed as RunEventPage };
  }

  private async provideInput(
    body: Extract<BrokerRequest, { method: "PROVIDE_INPUT" }>,
  ): Promise<BrokerResponse> {
    return this.mutateRun(body.requestId, "provideRunInput", body.params.runId, body.params.expectedStateVersion, {
      schemaVersion: 1,
      questionId: body.params.questionId,
      answer: body.params.answer,
      source: "user",
    });
  }

  private async mutateRun(
    requestId: string,
    operationId: "provideRunInput" | "requestRunRepair" | "cancelRun",
    runId: RunId,
    expectedStateVersion: number,
    payload: unknown,
  ): Promise<BrokerResponse> {
    const response = await this.world.broker.call({
      operationId,
      pathParams: { projectId: PROJECT_ID, runId },
      body: jsonBody(payload),
      headers: {
        "content-type": "application/json",
        "if-match": `"${String(expectedStateVersion)}"`,
      },
    });
    if (response.status >= 400) {
      const error = httpError(requestId, response.body);
      this.lastError = error.outcome === "ERROR" ? error.error : undefined;
      return error;
    }
    const parsed: unknown = parseJson(response.body);
    if (!OPERATION.Check(parsed)) {
      return internalError(requestId, "OperationProjection failed schema");
    }
    this.lastOperation = parsed;
    return { requestId, outcome: "OPERATION_ACCEPTED", operation: parsed };
  }

  private runOutcome(requestId: string, status: number, body: Buffer): BrokerResponse {
    if (status >= 400) {
      const error = httpError(requestId, body);
      this.lastError = error.outcome === "ERROR" ? error.error : undefined;
      return error;
    }
    const parsed: unknown = parseJson(body);
    if (!RUN.Check(parsed)) {
      return internalError(requestId, "RunProjection failed schema");
    }
    this.lastRun = parsed;
    return { requestId, outcome: "RUN", run: parsed };
  }
}

function pointerRunId(pi: FakePi): RunId {
  const entry = [...pi.entries].reverse().find((item) => item.customType === "hec-run-pointer");
  const data = entry?.data;
  if (data === null || typeof data !== "object" || !("activeRunId" in data)) {
    throw new Error(`active run missing: ${pi.notifications.join(" | ")}`);
  }
  const runId = Reflect.get(data, "activeRunId");
  if (typeof runId !== "string") {
    throw new Error("active run id missing");
  }
  return asRunId(runId);
}

test("bootstrap run lists zero agents before /hec starts a DAG", async () => {
  const world = requireHarness();
  const response = await world.broker.call({
    operationId: "listRunAgents",
    pathParams: { projectId: PROJECT_ID, runId: RUN_ID },
  });
  expect(response.status).toBe(200);
  const parsed: unknown = parseJson(response.body);
  expect(AGENTS.Check(parsed)).toBe(true);
  if (AGENTS.Check(parsed)) {
    expect(parsed.runId).toBe(RUN_ID);
    expect(parsed.agents).toEqual([]);
  }
});

test("worker lease is NO_JOB when the bootstrap run has no DAG jobs", async () => {
  const world = requireHarness();
  world.listening.ctx.agentRuntime = undefined;
  const leased = await world.worker.call({
    operationId: "leaseRunnerJob",
    body: jsonBody({
      schemaVersion: 1,
      runnerId: FAEX1_WORKER_RUNNER_ID,
      capabilitiesObjectDigest: HOST_CAPABILITY,
      maxJobs: 1,
    }),
    headers: { "content-type": "application/json" },
  });
  expect(leased.status).toBe(200);
  const parsed: unknown = parseJson(leased.body);
  expect(parsed).toMatchObject({ schemaVersion: 1, outcome: "NO_JOB" });
});

test("/hec starts a FAST multi-agent DAG through the client and control plane", async () => {
  const world = requireHarness();
  world.listening.ctx.agentRuntime = createScriptedAgentRuntime(world.clock);
  const broker = new ControlPlaneBroker(world);
  const pi = new FakePi();
  pi.install(broker, { securityMode: "compatibility" });

  try {
    await pi.runCommand("добавь локальную форму логина, не трогая secrets");
    expect(pi.notifications.some((line) => line.startsWith("HEC started run_"))).toBe(true);
    expect(broker.lastError).toBeUndefined();
    expect(broker.lastRun?.state).toBe("CREATED");
    const runId = pointerRunId(pi);

    await pi.runCommand("agents");
    expect(broker.lastAgents?.runId).toBe(runId);
    expect(broker.lastAgents?.profileId).toBe("FAST");
    expect(broker.lastAgents?.state).toBe("CREATED");
    const agents = broker.lastAgents?.agents ?? [];
    expect(agents).toHaveLength(FAST_ROLES.length);
    expect(new Set(agents.map((agent) => agent.role))).toEqual(new Set(FAST_ROLES));
    expect(agents.every((agent) => agent.status === "ACCEPTED")).toBe(true);
    expect(agents.every((agent) => agent.artifactType !== undefined)).toBe(true);
    const implementer = agents.find((agent) => agent.role === "implementer");
    expect(implementer?.leaseId).toBeDefined();
    expect(pi.notifications.some((line) => line.includes(`HEC agents ${runId}`))).toBe(true);

    await pi.runCommand("status");
    expect(pi.notifications.some((line) => line === `HEC ${runId} CREATED`)).toBe(true);

    await pi.runCommand("recover");
    expect(pi.notifications.some((line) => line === `HEC recover ${runId}`)).toBe(true);

    await pi.runCommand(`answer ${runId} use the overlay`);
    expect(broker.lastOperation?.kind).toBe("APPLY_USER_INPUT");
    expect(broker.lastOperation?.runId).toBe(runId);
    expect(broker.lastError).toBeUndefined();
  } finally {
    world.listening.ctx.agentRuntime = undefined;
  }
});

test("/hec worker path fills FAST roles without in-process AgentRuntime", async () => {
  const world = requireHarness();
  world.listening.ctx.agentRuntime = undefined;
  const broker = new ControlPlaneBroker(world);
  const pi = new FakePi();
  pi.install(broker, { securityMode: "compatibility" });

  await pi.runCommand("добавь локальную форму логина через worker");
  expect(pi.notifications.some((line) => line.startsWith("HEC started run_"))).toBe(true);
  expect(broker.lastError).toBeUndefined();
  const runId = pointerRunId(pi);

  await pi.runCommand("agents");
  expect(broker.lastAgents?.agents ?? []).toEqual([]);

  const drained = await drainWorkerUntilIdle({
    client: world.worker,
    runtime: createScriptedAgentRuntime(world.clock),
    runnerId: FAEX1_WORKER_RUNNER_ID,
    capabilitiesObjectDigest: HOST_CAPABILITY,
  });
  expect(drained).toBe(FAST_ROLES.length);

  await pi.runCommand("agents");
  expect(broker.lastAgents?.runId).toBe(runId);
  expect(broker.lastAgents?.profileId).toBe("FAST");
  const agents = broker.lastAgents?.agents ?? [];
  expect(agents).toHaveLength(FAST_ROLES.length);
  expect(new Set(agents.map((agent) => agent.role))).toEqual(new Set(FAST_ROLES));
  expect(agents.every((agent) => agent.status === "ACCEPTED")).toBe(true);
  expect(agents.every((agent) => agent.artifactType !== undefined)).toBe(true);
  expect(agents.find((agent) => agent.role === "implementer")?.leaseId).toBeDefined();
});
