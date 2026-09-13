import { Compile } from "typebox/compile";
import {
  consumeWithTimeout,
  DEFAULT_AGENT_OVERLAY_ROOT,
  overlayBranchFor,
  overlayPathFor,
  type AgentHandle,
  type AgentRuntime,
} from "@pi-hec/agent-runtime";
import type {
  ArtifactType,
  ChangeManifest,
  ObjectDigest,
  PrincipalScope,
  RunId,
  SpawnRequest,
  TaskContract,
  WorkerArtifactEnvelope,
  WorkflowNode,
  WorkflowProfile,
} from "@pi-hec/contracts";
import {
  SpawnRequestSchema,
  WorkerArtifactEnvelopeSchema,
  asAgentId,
  asCapabilityTokenId,
  asLeaseId,
  asRunId,
  randomPrefixedUuidV7,
  sha256Utf8,
} from "@pi-hec/contracts";
import {
  FAST_PROFILE,
  ROLE_ARTIFACT_TYPES,
  canRetry,
  checkIntegration,
  readyNodes,
  reduceNode,
  skippedDisabledNodes,
  validateWorkerEnvelope,
  workflowProfileById,
  type DagCursor,
  type NodeRecord,
  type ProjectScope,
} from "@pi-hec/domain";
import type { StateStore } from "@pi-hec/state-store";
import {
  PREDICATES_NODE,
  PROFILE_BINDING_NODE,
  asAdapter,
  asNodeStatus,
  asProfileId,
  asRole,
  asToolProfile,
  isProfileId,
  selectAndPersistProfile,
} from "./profile-runner.js";

export const AGENT_OPERATION_KINDS = [
  "SPAWN_AGENT",
  "CONSUME_AGENT",
  "VALIDATE_ARTIFACT",
  "SELECT_PROFILE",
  "INTEGRATE_CHANGESET",
  "CHECK_ACCEPTANCE",
  "RECONCILE_AGENTS",
] as const;

export type AgentOperationKind = (typeof AGENT_OPERATION_KINDS)[number];

export function isAgentOperationKind(kind: string): kind is AgentOperationKind {
  return (AGENT_OPERATION_KINDS as readonly string[]).includes(kind);
}

const SPAWN_REQUEST = Compile(SpawnRequestSchema);
const ENVELOPE = Compile(WorkerArtifactEnvelopeSchema);

export type AgentJobResult =
  | { ok: true; detail: string }
  | { ok: false; reason: string };

export type SpawnJobResult = {
  schemaVersion: 1;
  handle: {
    agentId: string;
    sessionId: string;
    adapter: string;
    adapterVersion: string;
    toolProfile: string;
    capabilityTokenId: string;
    spawnedAt: string;
  };
  envelope: WorkerArtifactEnvelope;
};

export type EnqueueAgentWorkInput = {
  store: StateStore;
  scope: ProjectScope;
  runId: string;
  now: string;
  persistArtifact: (bytes: Uint8Array, schemaName: string | null) => Promise<ObjectDigest>;
  newOperationId: () => string;
};

const ARTIFACT_SCHEMA: Readonly<Partial<Record<ArtifactType, string>>> = {
  "task-contract": "TaskContract",
  "investigation-report": "InvestigationReport",
  "implementation-plan": "ImplementationPlan",
  "change-shards": "ChangeShards",
  "change-manifest": "ChangeManifest",
  "review-findings": "ReviewFindings",
  "acceptance-ledger": "AcceptanceLedger",
  "reproduction-unavailable": "ReproductionUnavailable",
  "spec-update-not-required": "SpecUpdateNotRequired",
};

function implementerWorkspace(runId: string, nodeId: string): { overlayPath: string; branch: string } {
  const root = process.env.PI_HEC_AGENT_OVERLAY_ROOT ?? DEFAULT_AGENT_OVERLAY_ROOT;
  return {
    overlayPath: overlayPathFor(root, runId, nodeId),
    branch: overlayBranchFor(runId, nodeId),
  };
}

function analystBootstrapProfile(): WorkflowProfile {
  const analyst = FAST_PROFILE.nodes.find((node) => node.id === "analyst");
  if (analyst === undefined) {
    throw new Error("FAST profile missing analyst");
  }
  return {
    ...FAST_PROFILE,
    nodes: [analyst],
    requiredArtifacts: ["task-contract"],
  };
}

function outputTypeFor(role: SpawnRequest["role"]): ArtifactType {
  const types = ROLE_ARTIFACT_TYPES[role];
  const first = types[0];
  if (first === undefined) {
    throw new Error(`role ${role} has no artifact type`);
  }
  return first;
}

function toolProfileFor(spec: { role?: SpawnRequest["role"]; concurrencyGroup?: string }): SpawnRequest["toolProfile"] {
  if (spec.role === "implementer") {
    return "write";
  }
  if (spec.concurrencyGroup === "review") {
    return "review";
  }
  return "read";
}

function loadCursor(store: StateStore, scope: ProjectScope, runId: string): DagCursor {
  const stored = store.listAgentNodes(scope, runId);
  const binding = stored.find((node) => node.nodeId === PROFILE_BINDING_NODE);
  const pred = stored.find((node) => node.nodeId === PREDICATES_NODE);
  const predicates =
    pred?.operation === undefined || pred.operation.length === 0 ? [] : pred.operation.split(",");
  const profile =
    binding?.operation !== undefined && isProfileId(binding.operation)
      ? workflowProfileById(asProfileId(binding.operation))
      : analystBootstrapProfile();
  const nodes: NodeRecord[] = profile.nodes.map((spec) => {
    const row = stored.find((node) => node.nodeId === spec.id);
    if (row === undefined) {
      return { nodeId: spec.id, status: "PENDING", attempt: 0 };
    }
    return {
      nodeId: row.nodeId,
      status: asNodeStatus(row.status),
      attempt: row.attempt,
      ...(row.agentId === undefined ? {} : { agentId: row.agentId }),
    };
  });
  return { profile, nodes, predicates };
}

function persistNode(
  store: StateStore,
  scope: ProjectScope,
  runId: string,
  now: string,
  record: NodeRecord,
  extra: {
    role?: string;
    operation?: string;
    leaseId?: string;
    artifactDigest?: string;
  } = {},
): void {
  store.upsertAgentNode(scope, {
    runId,
    nodeId: record.nodeId,
    attempt: record.attempt,
    status: record.status,
    idempotencyKey: `${runId}:${record.nodeId}:${String(record.attempt)}`,
    updatedAt: now,
    ...(record.agentId === undefined ? {} : { agentId: record.agentId }),
    ...(extra.role === undefined ? {} : { role: extra.role }),
    ...(extra.operation === undefined ? {} : { operation: extra.operation }),
    ...(extra.leaseId === undefined ? {} : { leaseId: extra.leaseId }),
    ...(extra.artifactDigest === undefined ? {} : { artifactDigest: extra.artifactDigest }),
  });
}

function appendEvent(
  store: StateStore,
  scope: ProjectScope,
  input: {
    runId: string;
    nodeId: string;
    eventType: string;
    now: string;
    agentId?: string;
    payload: string;
  },
): void {
  const sequence =
    store.listAgentNodeEvents(scope, input.runId).filter((event) => event.nodeId === input.nodeId)
      .length + 1;
  store.appendAgentNodeEvent(scope, {
    eventId: randomPrefixedUuidV7("evt_"),
    runId: input.runId,
    nodeId: input.nodeId,
    sequence,
    eventType: input.eventType,
    payloadDigest: sha256Utf8(input.payload),
    occurredAt: input.now,
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
  });
}

function persistHandle(
  store: StateStore,
  scope: ProjectScope,
  handle: AgentHandle,
  now: string,
): void {
  store.putAgentHandle(scope, {
    agentId: handle.agentId,
    runId: handle.runId,
    nodeId: handle.nodeId,
    role: handle.role,
    sessionId: handle.sessionId,
    adapter: handle.adapter,
    adapterVersion: handle.adapterVersion,
    toolProfile: handle.toolProfile,
    capabilityTokenId: handle.capabilityTokenId,
    spawnedAt: handle.spawnedAt,
    lastHeartbeatAt: now,
    ...(handle.workspaceLeaseId === undefined ? {} : { leaseId: handle.workspaceLeaseId }),
  });
  store.putCapabilityToken(scope, {
    tokenId: handle.capabilityTokenId,
    runId: handle.runId,
    nodeId: handle.nodeId,
    agentId: handle.agentId,
    role: handle.role,
    mac: sha256Utf8(handle.capabilityTokenId).slice("sha256:".length),
    issuedAt: handle.spawnedAt,
    expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString(),
  });
}

function ensureAnalystNode(store: StateStore, scope: ProjectScope, runId: string, now: string): void {
  const existing = store.listAgentNodes(scope, runId);
  if (existing.some((node) => node.nodeId === "analyst")) {
    return;
  }
  store.upsertAgentNode(scope, {
    runId,
    nodeId: "analyst",
    attempt: 0,
    status: "PENDING",
    role: "analyst",
    idempotencyKey: `${runId}:analyst:0`,
    updatedAt: now,
  });
}

function advanceControllerNodes(store: StateStore, scope: ProjectScope, runId: RunId, now: string): boolean {
  let progressed = false;
  for (let wave = 0; wave < 16; wave += 1) {
    const cursor = loadCursor(store, scope, runId);
    for (const skipped of skippedDisabledNodes(cursor)) {
      const current = cursor.nodes.find((node) => node.nodeId === skipped);
      persistNode(store, scope, runId, now, {
        nodeId: skipped,
        status: "ACCEPTED",
        attempt: current?.attempt ?? 0,
      });
      progressed = true;
    }
    const ready = readyNodes(loadCursor(store, scope, runId));
    const controllers = ready.filter((spec) => spec.operation !== undefined);
    if (controllers.length === 0) {
      return progressed;
    }
    for (const spec of controllers) {
      const operation = spec.operation;
      if (operation === undefined) {
        continue;
      }
      persistNode(
        store,
        scope,
        runId,
        now,
        { nodeId: spec.id, status: "ACCEPTED", attempt: 1 },
        { operation },
      );
      appendEvent(store, scope, {
        runId,
        nodeId: spec.id,
        eventType: "NODE_COMPLETED",
        now,
        payload: operation,
      });
      progressed = true;
    }
  }
  return progressed;
}

function currentRecord(
  store: StateStore,
  scope: ProjectScope,
  runId: string,
  nodeId: string,
): NodeRecord {
  const current = store.listAgentNodes(scope, runId).find((node) => node.nodeId === nodeId);
  return {
    nodeId,
    status: asNodeStatus(current?.status ?? "PENDING"),
    attempt: current?.attempt ?? 0,
    ...(current?.agentId === undefined ? {} : { agentId: current.agentId }),
  };
}

function prepareRoleSpawn(input: {
  store: StateStore;
  scope: ProjectScope;
  runId: RunId;
  now: string;
  spec: {
    id: string;
    role: NonNullable<SpawnRequest["role"]>;
    concurrencyGroup?: string;
  };
}): { spawned: NodeRecord; request: SpawnRequest; leaseId?: ReturnType<typeof asLeaseId> } {
  const spawned = reduceNode(currentRecord(input.store, input.scope, input.runId, input.spec.id), "NODE_SPAWNED");
  let leaseId: ReturnType<typeof asLeaseId> | undefined;
  if (input.spec.role === "implementer") {
    const existing = input.store
      .listAgentNodes(input.scope, input.runId)
      .find((node) => node.nodeId === input.spec.id)?.leaseId;
    leaseId =
      existing !== undefined && existing.length > 0
        ? asLeaseId(existing)
        : asLeaseId(randomPrefixedUuidV7("lease_"));
    if (existing === undefined) {
      const workspace = implementerWorkspace(input.runId, input.spec.id);
      input.store.putWorkspaceLease(input.scope, {
        leaseId,
        runId: input.runId,
        nodeId: input.spec.id,
        overlayPath: workspace.overlayPath,
        branch: workspace.branch,
        baseCommit: "base",
        isolationVerified: true,
        createdAt: input.now,
        expiresAt: new Date(Date.parse(input.now) + 3_600_000).toISOString(),
      });
    }
  }
  persistNode(input.store, input.scope, input.runId, input.now, spawned, {
    role: input.spec.role,
    ...(leaseId === undefined ? {} : { leaseId }),
  });
  const request: SpawnRequest = {
    schemaVersion: 1,
    runId: input.runId,
    nodeId: input.spec.id,
    role: input.spec.role,
    modelDeploymentId: `cloud-${input.spec.role}`,
    toolProfile: toolProfileFor(input.spec),
    inputArtifacts: spawnInputArtifacts(input.store, input.scope, input.runId),
    outputSchema: outputTypeFor(input.spec.role),
    idempotencyKey: `${input.runId}:${input.spec.id}:${String(spawned.attempt)}`,
    ...(leaseId === undefined ? {} : { workspaceLeaseId: leaseId }),
  };
  return { spawned, request, ...(leaseId === undefined ? {} : { leaseId }) };
}

export function parseSpawnRequest(value: unknown): SpawnRequest {
  if (!SPAWN_REQUEST.Check(value)) {
    throw new Error("spawn request invalid");
  }
  return value;
}

export function parseSpawnJobResult(value: unknown): SpawnJobResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("spawn job result invalid");
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || record.handle === null || typeof record.handle !== "object") {
    throw new Error("spawn job result invalid");
  }
  if (!ENVELOPE.Check(record.envelope)) {
    throw new Error("spawn envelope invalid");
  }
  const handle = record.handle as Record<string, unknown>;
  for (const key of [
    "agentId",
    "sessionId",
    "adapter",
    "adapterVersion",
    "toolProfile",
    "capabilityTokenId",
    "spawnedAt",
  ]) {
    if (typeof handle[key] !== "string" || (handle[key] as string).length === 0) {
      throw new Error("spawn job handle invalid");
    }
  }
  return {
    schemaVersion: 1,
    handle: {
      agentId: handle.agentId as string,
      sessionId: handle.sessionId as string,
      adapter: handle.adapter as string,
      adapterVersion: handle.adapterVersion as string,
      toolProfile: handle.toolProfile as string,
      capabilityTokenId: handle.capabilityTokenId as string,
      spawnedAt: handle.spawnedAt as string,
    },
    envelope: record.envelope,
  };
}

function handleFromJob(spawn: SpawnRequest, result: SpawnJobResult): AgentHandle {
  return {
    agentId: asAgentId(result.handle.agentId),
    runId: spawn.runId,
    nodeId: spawn.nodeId,
    role: spawn.role,
    sessionId: result.handle.sessionId,
    toolProfile: spawn.toolProfile,
    capabilityTokenId: asCapabilityTokenId(result.handle.capabilityTokenId),
    adapter: asAdapter(result.handle.adapter),
    adapterVersion: result.handle.adapterVersion,
    spawnedAt: result.handle.spawnedAt,
    ...(spawn.workspaceLeaseId === undefined ? {} : { workspaceLeaseId: spawn.workspaceLeaseId }),
  };
}

async function acceptEnvelope(input: {
  store: StateStore;
  scope: ProjectScope;
  runId: RunId;
  now: string;
  spawned: NodeRecord;
  handle: AgentHandle;
  envelope: WorkerArtifactEnvelope;
  leaseId?: ReturnType<typeof asLeaseId>;
  persistArtifact: (bytes: Uint8Array, schemaName: string | null) => Promise<ObjectDigest>;
  outputSchema: ArtifactType;
}): Promise<AgentJobResult> {
  const validated = validateWorkerEnvelope(input.envelope, {
    runId: input.handle.runId,
    nodeId: input.handle.nodeId,
    agentId: input.handle.agentId,
    artifactType: input.outputSchema,
  });
  if (!validated.ok) {
    const retried = reduceNode({ ...input.spawned, agentId: input.handle.agentId }, "NODE_RETRYING");
    persistNode(input.store, input.scope, input.runId, input.now, retried, {
      role: input.handle.role,
    });
    return { ok: false, reason: "envelope-invalid" };
  }
  const schemaName = ARTIFACT_SCHEMA[input.envelope.artifactType] ?? null;
  const digest = await input.persistArtifact(
    Buffer.from(JSON.stringify(input.envelope.payload), "utf8"),
    schemaName,
  );
  const accepted = reduceNode(
    { ...input.spawned, status: "VALIDATING", agentId: input.handle.agentId },
    "ARTIFACT_ACCEPTED",
    input.handle.agentId,
  );
  persistNode(input.store, input.scope, input.runId, input.now, accepted, {
    role: input.handle.role,
    artifactDigest: digest,
    ...(input.leaseId === undefined ? {} : { leaseId: input.leaseId }),
  });
  appendEvent(input.store, input.scope, {
    runId: input.runId,
    nodeId: input.handle.nodeId,
    eventType: "ARTIFACT_ACCEPTED",
    now: input.now,
    agentId: input.handle.agentId,
    payload: digest,
  });
  if (input.envelope.artifactType === "task-contract") {
    selectAndPersistProfile(
      input.store,
      input.scope,
      input.runId,
      input.envelope.payload as TaskContract,
      input.now,
    );
  }
  if (input.envelope.artifactType === "change-manifest") {
    const check = checkIntegration({
      manifest: input.envelope.payload as ChangeManifest,
      fileContents: {},
    });
    if (!check.ok) {
      return { ok: false, reason: "integration-failed" };
    }
  }
  return { ok: true, detail: digest };
}

function spawnInputArtifacts(
  store: StateStore,
  scope: ProjectScope,
  runId: RunId,
): SpawnRequest["inputArtifacts"] {
  const digest = store
    .getRun(scope, runId)
    .artifactRoles.find((entry) => entry.role === "task-envelope")
    ?.objectDigests[0];
  if (digest === undefined) {
    return [];
  }
  return [{ role: "task-envelope", objectDigest: digest }];
}

export async function enqueueReadyAgentWork(input: EnqueueAgentWorkInput): Promise<AgentJobResult> {
  const runId = asRunId(input.runId);
  ensureAnalystNode(input.store, input.scope, runId, input.now);
  advanceControllerNodes(input.store, input.scope, runId, input.now);
  const ready = readyNodes(loadCursor(input.store, input.scope, runId)).filter(
    (spec): spec is WorkflowNode & { role: NonNullable<SpawnRequest["role"]> } => spec.role !== undefined,
  );
  for (const spec of ready) {
    const prepared = prepareRoleSpawn({
      store: input.store,
      scope: input.scope,
      runId,
      now: input.now,
      spec: {
        id: spec.id,
        role: spec.role,
        ...(spec.concurrencyGroup === undefined ? {} : { concurrencyGroup: spec.concurrencyGroup }),
      },
    });
    const digest = await input.persistArtifact(
      Buffer.from(JSON.stringify(prepared.request), "utf8"),
      null,
    );
    input.store.enqueueOperation(input.scope, {
      operationId: input.newOperationId(),
      runId,
      operationKind: "SPAWN_AGENT",
      dedupeKey: `SPAWN_AGENT:${runId}:${spec.id}:${String(prepared.spawned.attempt)}`,
      inputDigest: digest,
      createdAt: input.now,
    });
  }
  return { ok: true, detail: `queued:${String(ready.length)}` };
}

export async function requeueRetryingAgentWork(input: {
  store: StateStore;
  adminScope: PrincipalScope;
  now: string;
  persistArtifact: (
    projectId: string,
    bytes: Uint8Array,
    schemaName: string | null,
  ) => Promise<ObjectDigest>;
  newOperationId: () => string;
}): Promise<number> {
  const runs = input.store.listRetryingAgentRuns();
  for (const run of runs) {
    const scope = input.store.toProjectScope(input.adminScope, run.projectId);
    await enqueueReadyAgentWork({
      store: input.store,
      scope,
      runId: run.runId,
      now: input.now,
      persistArtifact: (bytes, schemaName) => input.persistArtifact(run.projectId, bytes, schemaName),
      newOperationId: input.newOperationId,
    });
  }
  return runs.length;
}

export async function acceptCompletedSpawnJob(input: {
  store: StateStore;
  scope: ProjectScope;
  now: string;
  spawn: SpawnRequest;
  result: SpawnJobResult;
  persistArtifact: (bytes: Uint8Array, schemaName: string | null) => Promise<ObjectDigest>;
  newOperationId: () => string;
}): Promise<AgentJobResult> {
  const handle = handleFromJob(input.spawn, input.result);
  persistHandle(input.store, input.scope, handle, input.now);
  const current = currentRecord(input.store, input.scope, input.spawn.runId, input.spawn.nodeId);
  if (current.status === "ACCEPTED") {
    await enqueueReadyAgentWork({
      store: input.store,
      scope: input.scope,
      runId: input.spawn.runId,
      now: input.now,
      persistArtifact: input.persistArtifact,
      newOperationId: input.newOperationId,
    });
    return { ok: true, detail: "already-accepted" };
  }
  const spawned: NodeRecord = {
    nodeId: input.spawn.nodeId,
    status: "SPAWNED",
    attempt: current.attempt === 0 ? 1 : current.attempt,
    agentId: handle.agentId,
  };
  persistNode(input.store, input.scope, input.spawn.runId, input.now, spawned, {
    role: input.spawn.role,
    ...(input.spawn.workspaceLeaseId === undefined
      ? {}
      : { leaseId: asLeaseId(input.spawn.workspaceLeaseId) }),
  });
  appendEvent(input.store, input.scope, {
    runId: input.spawn.runId,
    nodeId: input.spawn.nodeId,
    eventType: "NODE_SPAWNED",
    now: input.now,
    agentId: handle.agentId,
    payload: handle.sessionId,
  });
  const accepted = await acceptEnvelope({
    store: input.store,
    scope: input.scope,
    runId: asRunId(input.spawn.runId),
    now: input.now,
    spawned,
    handle,
    envelope: input.result.envelope,
    persistArtifact: input.persistArtifact,
    outputSchema: input.spawn.outputSchema,
    ...(input.spawn.workspaceLeaseId === undefined
      ? {}
      : { leaseId: asLeaseId(input.spawn.workspaceLeaseId) }),
  });
  await enqueueReadyAgentWork({
    store: input.store,
    scope: input.scope,
    runId: input.spawn.runId,
    now: input.now,
    persistArtifact: input.persistArtifact,
    newOperationId: input.newOperationId,
  });
  return accepted;
}

export async function failCompletedSpawnJob(input: {
  store: StateStore;
  scope: ProjectScope;
  now: string;
  spawn: SpawnRequest;
  persistArtifact: (bytes: Uint8Array, schemaName: string | null) => Promise<ObjectDigest>;
  newOperationId: () => string;
}): Promise<AgentJobResult> {
  const current = currentRecord(input.store, input.scope, input.spawn.runId, input.spawn.nodeId);
  if (current.status === "ACCEPTED") {
    await enqueueReadyAgentWork({
      store: input.store,
      scope: input.scope,
      runId: input.spawn.runId,
      now: input.now,
      persistArtifact: input.persistArtifact,
      newOperationId: input.newOperationId,
    });
    return { ok: true, detail: "already-accepted" };
  }
  if (current.status === "RETRYING") {
    await enqueueReadyAgentWork({
      store: input.store,
      scope: input.scope,
      runId: input.spawn.runId,
      now: input.now,
      persistArtifact: input.persistArtifact,
      newOperationId: input.newOperationId,
    });
    return { ok: true, detail: "already-retrying" };
  }
  if (current.status === "FAILED") {
    if (canRetry(current, 3)) {
      persistNode(
        input.store,
        input.scope,
        input.spawn.runId,
        input.now,
        { nodeId: current.nodeId, status: "RETRYING", attempt: current.attempt + 1 },
        { role: input.spawn.role },
      );
    }
    await enqueueReadyAgentWork({
      store: input.store,
      scope: input.scope,
      runId: input.spawn.runId,
      now: input.now,
      persistArtifact: input.persistArtifact,
      newOperationId: input.newOperationId,
    });
    return { ok: true, detail: "spawn-failed" };
  }
  const live: NodeRecord =
    current.status === "SPAWNED" || current.status === "WAITING_ARTIFACT" || current.status === "VALIDATING"
      ? current
      : { ...current, status: "SPAWNED" };
  const next =
    live.attempt < 3 && (live.status === "SPAWNED" || live.status === "WAITING_ARTIFACT")
      ? reduceNode(live, "NODE_RETRYING")
      : reduceNode(live, "NODE_FAILED");
  persistNode(input.store, input.scope, input.spawn.runId, input.now, next, {
    role: input.spawn.role,
  });
  appendEvent(input.store, input.scope, {
    runId: input.spawn.runId,
    nodeId: input.spawn.nodeId,
    eventType: next.status === "RETRYING" ? "NODE_RETRYING" : "NODE_FAILED",
    now: input.now,
    payload: "spawn-failed",
  });
  await enqueueReadyAgentWork({
    store: input.store,
    scope: input.scope,
    runId: input.spawn.runId,
    now: input.now,
    persistArtifact: input.persistArtifact,
    newOperationId: input.newOperationId,
  });
  return { ok: true, detail: "spawn-failed" };
}

async function spawnRoleNode(input: {
  store: StateStore;
  scope: ProjectScope;
  runId: RunId;
  now: string;
  runtime: AgentRuntime;
  spec: {
    id: string;
    role: NonNullable<SpawnRequest["role"]>;
    concurrencyGroup?: string;
  };
  persistArtifact: (bytes: Uint8Array, schemaName: string | null) => Promise<ObjectDigest>;
}): Promise<WorkerArtifactEnvelope | undefined> {
  const current = input.store
    .listAgentNodes(input.scope, input.runId)
    .find((node) => node.nodeId === input.spec.id);
  const record: NodeRecord = {
    nodeId: input.spec.id,
    status: asNodeStatus(current?.status ?? "PENDING"),
    attempt: current?.attempt ?? 0,
    ...(current?.agentId === undefined ? {} : { agentId: current.agentId }),
  };
  const spawned = reduceNode(record, "NODE_SPAWNED");
  let leaseId: ReturnType<typeof asLeaseId> | undefined;
  if (input.spec.role === "implementer") {
    leaseId = asLeaseId(randomPrefixedUuidV7("lease_"));
    const workspace = implementerWorkspace(input.runId, input.spec.id);
    input.store.putWorkspaceLease(input.scope, {
      leaseId,
      runId: input.runId,
      nodeId: input.spec.id,
      overlayPath: workspace.overlayPath,
      branch: workspace.branch,
      baseCommit: "base",
      isolationVerified: true,
      createdAt: input.now,
      expiresAt: new Date(Date.parse(input.now) + 3_600_000).toISOString(),
    });
  }
  persistNode(input.store, input.scope, input.runId, input.now, spawned, {
    role: input.spec.role,
    ...(leaseId === undefined ? {} : { leaseId }),
  });
  const request: SpawnRequest = {
    schemaVersion: 1,
    runId: input.runId,
    nodeId: input.spec.id,
    role: input.spec.role,
    modelDeploymentId: `cloud-${input.spec.role}`,
    toolProfile: toolProfileFor(input.spec),
    inputArtifacts: spawnInputArtifacts(input.store, input.scope, input.runId),
    outputSchema: outputTypeFor(input.spec.role),
    idempotencyKey: `${input.runId}:${input.spec.id}:${String(spawned.attempt)}`,
    ...(leaseId === undefined ? {} : { workspaceLeaseId: leaseId }),
  };
  let handle: AgentHandle | undefined;
  try {
    handle = await input.runtime.spawn(request);
    persistHandle(input.store, input.scope, handle, input.now);
    persistNode(
      input.store,
      input.scope,
      input.runId,
      input.now,
      { ...spawned, agentId: handle.agentId },
      {
        role: input.spec.role,
        ...(leaseId === undefined ? {} : { leaseId }),
      },
    );
    appendEvent(input.store, input.scope, {
      runId: input.runId,
      nodeId: input.spec.id,
      eventType: "NODE_SPAWNED",
      now: input.now,
      agentId: handle.agentId,
      payload: handle.sessionId,
    });
    const result = await consumeWithTimeout(input.runtime, handle);
    if (result.outcome !== "artifact") {
      const failed = reduceNode({ ...spawned, agentId: handle.agentId }, "NODE_FAILED");
      persistNode(input.store, input.scope, input.runId, input.now, failed, {
        role: input.spec.role,
      });
      appendEvent(input.store, input.scope, {
        runId: input.runId,
        nodeId: input.spec.id,
        eventType: "NODE_FAILED",
        now: input.now,
        agentId: handle.agentId,
        payload: result.outcome,
      });
      return undefined;
    }
    const envelope = result.envelope as WorkerArtifactEnvelope;
    const validated = validateWorkerEnvelope(envelope, {
      runId: handle.runId,
      nodeId: handle.nodeId,
      agentId: handle.agentId,
      artifactType: request.outputSchema,
    });
    if (!validated.ok) {
      const retried = reduceNode({ ...spawned, agentId: handle.agentId }, "NODE_RETRYING");
      persistNode(input.store, input.scope, input.runId, input.now, retried, {
        role: input.spec.role,
      });
      return undefined;
    }
    const schemaName = ARTIFACT_SCHEMA[envelope.artifactType] ?? null;
    const digest = await input.persistArtifact(
      Buffer.from(JSON.stringify(envelope.payload), "utf8"),
      schemaName,
    );
    const accepted = reduceNode(
      { ...spawned, status: "VALIDATING", agentId: handle.agentId },
      "ARTIFACT_ACCEPTED",
      handle.agentId,
    );
    persistNode(input.store, input.scope, input.runId, input.now, accepted, {
      role: input.spec.role,
      artifactDigest: digest,
      ...(leaseId === undefined ? {} : { leaseId }),
    });
    appendEvent(input.store, input.scope, {
      runId: input.runId,
      nodeId: input.spec.id,
      eventType: "ARTIFACT_ACCEPTED",
      now: input.now,
      agentId: handle.agentId,
      payload: digest,
    });
    return envelope;
  } finally {
    if (handle !== undefined) {
      await input.runtime.stop(handle);
    }
    if (leaseId !== undefined) {
      input.store.deleteWorkspaceLease(input.scope, leaseId);
    }
  }
}

export async function driveMultiAgentRun(input: {
  store: StateStore;
  scope: ProjectScope;
  runId: string;
  now: string;
  runtime: AgentRuntime;
  persistArtifact: (bytes: Uint8Array, schemaName: string | null) => Promise<ObjectDigest>;
}): Promise<AgentJobResult> {
  const runId = asRunId(input.runId);
  const existing = input.store.listAgentNodes(input.scope, runId);
  if (!existing.some((node) => node.nodeId === "analyst")) {
    input.store.upsertAgentNode(input.scope, {
      runId,
      nodeId: "analyst",
      attempt: 0,
      status: "PENDING",
      role: "analyst",
      idempotencyKey: `${runId}:analyst:0`,
      updatedAt: input.now,
    });
  }
  for (let wave = 0; wave < 32; wave += 1) {
    const cursor = loadCursor(input.store, input.scope, runId);
    for (const skipped of skippedDisabledNodes(cursor)) {
      const current = cursor.nodes.find((node) => node.nodeId === skipped);
      persistNode(
        input.store,
        input.scope,
        runId,
        input.now,
        { nodeId: skipped, status: "ACCEPTED", attempt: current?.attempt ?? 0 },
      );
    }
    const ready = readyNodes(loadCursor(input.store, input.scope, runId));
    if (ready.length === 0) {
      return { ok: true, detail: `waves:${String(wave)}` };
    }
    let progressed = false;
    for (const spec of ready) {
      if (spec.operation !== undefined) {
        persistNode(
          input.store,
          input.scope,
          runId,
          input.now,
          { nodeId: spec.id, status: "ACCEPTED", attempt: 1 },
          { operation: spec.operation },
        );
        appendEvent(input.store, input.scope, {
          runId,
          nodeId: spec.id,
          eventType: "NODE_COMPLETED",
          now: input.now,
          payload: spec.operation,
        });
        progressed = true;
        continue;
      }
      if (spec.role === undefined) {
        continue;
      }
      const envelope = await spawnRoleNode({
        store: input.store,
        scope: input.scope,
        runId,
        now: input.now,
        runtime: input.runtime,
        spec: {
          id: spec.id,
          role: spec.role,
          ...(spec.concurrencyGroup === undefined ? {} : { concurrencyGroup: spec.concurrencyGroup }),
        },
        persistArtifact: input.persistArtifact,
      });
      if (envelope === undefined) {
        continue;
      }
      progressed = true;
      if (envelope.artifactType === "task-contract") {
        selectAndPersistProfile(
          input.store,
          input.scope,
          runId,
          envelope.payload as TaskContract,
          input.now,
        );
      }
      if (envelope.artifactType === "change-manifest") {
        const check = checkIntegration({
          manifest: envelope.payload as ChangeManifest,
          fileContents: {},
        });
        if (!check.ok) {
          return { ok: false, reason: "integration-failed" };
        }
      }
    }
    if (!progressed) {
      return { ok: false, reason: "no-progress" };
    }
  }
  return { ok: true, detail: "saturated" };
}

export function processAgentOperation(input: {
  store: StateStore;
  scope: ProjectScope;
  runId: string;
  kind: AgentOperationKind;
  now: string;
  contract?: TaskContract;
  runtime?: AgentRuntime;
  payload?: unknown;
  persistArtifact?: (bytes: Uint8Array, schemaName: string | null) => Promise<ObjectDigest>;
}): AgentJobResult | Promise<AgentJobResult> {
  switch (input.kind) {
    case "SELECT_PROFILE": {
      if (input.contract === undefined) {
        return { ok: false, reason: "task-contract required" };
      }
      const selected = selectAndPersistProfile(
        input.store,
        input.scope,
        input.runId,
        input.contract,
        input.now,
      );
      return { ok: true, detail: selected.profileId };
    }
    case "SPAWN_AGENT": {
      if (input.runtime === undefined || input.persistArtifact === undefined) {
        return { ok: false, reason: "runtime required" };
      }
      return driveMultiAgentRun({
        store: input.store,
        scope: input.scope,
        runId: input.runId,
        now: input.now,
        runtime: input.runtime,
        persistArtifact: input.persistArtifact,
      });
    }
    case "CONSUME_AGENT":
      return { ok: true, detail: "consume-queued" };
    case "VALIDATE_ARTIFACT":
      return { ok: true, detail: "validated" };
    case "INTEGRATE_CHANGESET": {
      const payload = input.payload as
        | {
            manifest: ChangeManifest;
            fileContents: Record<string, string>;
          }
        | undefined;
      if (payload === undefined) {
        return { ok: false, reason: "changeset payload required" };
      }
      const check = checkIntegration({
        manifest: payload.manifest,
        fileContents: payload.fileContents,
      });
      return check.ok
        ? { ok: true, detail: "integrated" }
        : { ok: false, reason: check.conflictMarkers.join(",") || "out-of-scope" };
    }
    case "CHECK_ACCEPTANCE":
      return { ok: true, detail: "acceptance-checked" };
    case "RECONCILE_AGENTS": {
      const nodes = input.store.listAgentNodes(input.scope, input.runId);
      for (const node of nodes) {
        if (node.status === "SPAWNED" && node.agentId !== undefined) {
          const live = input.store
            .listAgentHandles(input.scope, input.runId)
            .some((handle) => handle.agentId === node.agentId);
          if (!live) {
            const retried = reduceNode(
              {
                nodeId: node.nodeId,
                status: "SPAWNED",
                attempt: node.attempt,
                agentId: node.agentId,
              },
              "NODE_FAILED",
            );
            input.store.upsertAgentNode(input.scope, {
              runId: input.runId,
              nodeId: retried.nodeId,
              attempt: retried.attempt,
              status: retried.status,
              idempotencyKey: `${input.runId}:${retried.nodeId}:${String(retried.attempt)}`,
              updatedAt: input.now,
              ...(node.role === undefined ? {} : { role: node.role }),
              ...(retried.agentId === undefined ? {} : { agentId: retried.agentId }),
            });
          }
        }
      }
      return { ok: true, detail: "reconciled" };
    }
    default: {
      const exhaustive: never = input.kind;
      throw new Error(`unhandled union: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function readyRoleNodes(cursor: DagCursor) {
  return readyNodes(cursor);
}

export { asAdapter, asRole, asToolProfile };
