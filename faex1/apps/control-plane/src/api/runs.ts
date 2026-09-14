import { Compile } from "typebox/compile";
import {
  CancelRunRequestSchema,
  CreateRunRequestSchema,
  HttpArtifactsQuerySchema,
  HttpEventsQuerySchema,
  ProvideInputRequestSchema,
  RequestRepairRequestSchema,
} from "@pi-hec/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { filterArtifactsForProject } from "./artifacts.js";
import { driveMultiAgentRun, enqueueReadyAgentWork } from "../services/agent-jobs.js";
import {
  advanceRunCompiler,
  mapStoredRunEvents,
  requestSnapshotCapture,
} from "../orchestration/compiler.js";
import {
  HttpSignal,
  asRunId,
  jsonBuffer,
  loadCasJson,
  mapStoreError,
  newOperationId,
  persistCasArtifact,
  quotedEtag,
  requireMatchingStateVersion,
  requireScope,
  withIdempotency,
  type AppContext,
} from "../orchestration/handlers.js";

const CREATE_RUN = Compile(CreateRunRequestSchema);
const EVENTS_QUERY = Compile(HttpEventsQuerySchema);
const ARTIFACTS_QUERY = Compile(HttpArtifactsQuerySchema);
const PROVIDE = Compile(ProvideInputRequestSchema);
const REPAIR = Compile(RequestRepairRequestSchema);
const CANCEL = Compile(CancelRunRequestSchema);

function queryScalar(query: object, key: string): string | undefined {
  if (!Object.hasOwn(query, key)) {
    return undefined;
  }
  const value: unknown = Reflect.get(query, key);
  if (typeof value !== "string") {
    throw new HttpSignal(400, "SCHEMA_INVALID", "invalid cursor");
  }
  return value;
}

function queryUint(query: object, key: string): number | undefined {
  const raw = queryScalar(query, key);
  if (raw === undefined) {
    return undefined;
  }
  if (!/^\d{1,15}$/u.test(raw)) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "invalid cursor");
  }
  return Number.parseInt(raw, 10);
}

function requireQueryObject(raw: unknown): object {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "invalid cursor");
  }
  return raw;
}

function coerceUintQuery(raw: unknown): { after?: number; limit?: number } {
  const query = requireQueryObject(raw);
  const after = queryUint(query, "after");
  const limit = queryUint(query, "limit");
  return {
    ...(after === undefined ? {} : { after }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function coerceStringQuery(raw: unknown): { after?: string; limit?: number } {
  const query = requireQueryObject(raw);
  const after = queryScalar(query, "after");
  const limit = queryUint(query, "limit");
  return {
    ...(after === undefined ? {} : { after }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export async function createRun(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await withIdempotency(ctx, request, reply, request.operationSpec, async () => {
    if (!CREATE_RUN.Check(request.body)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
    }
    const runId = (request.params as { runId: string }).runId;
    if (request.body.task.runId !== runId) {
      throw new HttpSignal(422, "DOMAIN_INVARIANT_FAILED", "runId mismatch");
    }
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const projectScope = ctx.store.toProjectScope(scope, projectId);
    const now = ctx.clock();
    const taskBytes = jsonBuffer(request.body.task);
    const taskDigest = await persistCasArtifact(
      ctx,
      scope,
      projectId,
      taskBytes,
      "application/json",
      "internal",
      "TaskEnvelope",
    );
    ctx.store.createRun(projectScope, {
      runId: asRunId(runId),
      workspaceId: request.body.workspaceId,
      taskEnvelopeDigest: taskDigest,
      createdAt: now,
    });
    await requestSnapshotCapture(ctx, scope, projectId, runId);
    ctx.store.upsertAgentNode(projectScope, {
      runId,
      nodeId: "analyst",
      attempt: 0,
      status: "PENDING",
      role: "analyst",
      idempotencyKey: `${runId}:analyst:0`,
      updatedAt: now,
    });
    if (ctx.agentRuntime !== undefined) {
      await driveMultiAgentRun({
        store: ctx.store,
        scope: projectScope,
        runId,
        now,
        runtime: ctx.agentRuntime,
        persistArtifact: async (bytes, schemaName) =>
          persistCasArtifact(ctx, scope, projectId, bytes, "application/json", "internal", schemaName),
        loadArtifactJson: async (digest) => loadCasJson(ctx, projectId, digest),
      });
    } else {
      await enqueueReadyAgentWork({
        store: ctx.store,
        scope: projectScope,
        runId,
        now,
        persistArtifact: async (bytes, schemaName) =>
          persistCasArtifact(ctx, scope, projectId, bytes, "application/json", "internal", schemaName),
        newOperationId,
      });
      ctx.scheduler.notifyWork();
    }
    const latest = ctx.store.getRun(projectScope, runId);
    return {
      status: 201,
      headers: {
        location: `/v1/projects/${projectId}/runs/${runId}`,
        etag: quotedEtag(latest.stateVersion),
      },
      body: jsonBuffer(latest),
    };
  });
}

export async function getRun(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const runId = (request.params as { runId: string }).runId;
    let projection = ctx.store.getRun(ctx.store.toProjectScope(scope, projectId), runId);
    if (projection.state === "ACCEPTANCE_CHECK") {
      projection = await advanceRunCompiler(ctx, scope, projectId, runId);
    }
    const etag = quotedEtag(projection.stateVersion);
    void reply.header("etag", etag).header("cache-control", "no-store");
    if (request.headers["if-none-match"] === etag) {
      await reply.code(304).send();
      return;
    }
    await reply.code(200).send(projection);
  } catch (error) {
    await mapStoreError(reply, error);
  }
}

export async function listRunEvents(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    const query = coerceUintQuery(request.query);
    if (!EVENTS_QUERY.Check(query)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "invalid cursor");
    }
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const runId = (request.params as { runId: string }).runId;
    const after = query.after ?? 0;
    const limit = query.limit ?? 50;
    const events = ctx.store.listRunEvents(ctx.store.toProjectScope(scope, projectId), runId);
    const mapped = mapStoredRunEvents(projectId, events);
    const sliced = mapped.filter((event) => event.sequence > after).slice(0, limit);
    const last = sliced[sliced.length - 1];
    void reply.header("cache-control", "no-store");
    await reply.code(200).send({
      schemaVersion: 1,
      events: sliced,
      nextAfter: last === undefined ? null : last.sequence,
    });
  } catch (error) {
    await mapStoreError(reply, error);
  }
}

export async function listRunArtifacts(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    const query = coerceStringQuery(request.query);
    if (!ARTIFACTS_QUERY.Check(query)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "invalid cursor");
    }
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const runId = (request.params as { runId: string }).runId;
    const projectScope = ctx.store.toProjectScope(scope, projectId);
    const project = ctx.store.getProject(scope, projectId);
    const artifacts = filterArtifactsForProject(
      ctx.store.listRunArtifacts(projectScope, runId),
      project.classification,
    );
    void reply.header("cache-control", "no-store");
    await reply.code(200).send({
      schemaVersion: 1,
      artifacts,
      nextCursor: null,
    });
  } catch (error) {
    await mapStoreError(reply, error);
  }
}

async function enqueueMutRun(
  ctx: AppContext,
  request: FastifyRequest,
  kind: "APPLY_USER_INPUT" | "REQUEST_REPAIR" | "REQUEST_CANCELLATION",
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
  const ifMatch = request.headers["if-match"];
  const scope = requireScope(request);
  const projectId = (request.params as { projectId: string }).projectId;
  const runId = (request.params as { runId: string }).runId;
  const projectScope = ctx.store.toProjectScope(scope, projectId);
  const run = ctx.store.getRun(projectScope, runId);
  requireMatchingStateVersion(ifMatch, run.stateVersion);
  const now = ctx.clock();
  const inputBytes = jsonBuffer(request.body);
  const inputDigest = await persistCasArtifact(
    ctx,
    scope,
    projectId,
    inputBytes,
    "application/json",
    "internal",
    null,
  );
  const operationIdHeader = request.headers["operation-id"];
  const operationId =
    typeof operationIdHeader === "string" && operationIdHeader.startsWith("op_")
      ? operationIdHeader
      : newOperationId();
  const record = ctx.store.enqueueOperation(projectScope, {
    operationId,
    runId,
    operationKind: kind,
    dedupeKey: `${kind}:${runId}`,
    inputDigest,
    createdAt: now,
  });
  ctx.scheduler.notifyWork();
  const projection = {
    schemaVersion: 1 as const,
    projectId,
    operationId: record.operationId,
    runId: record.runId,
    kind: record.operationKind,
    state: record.state,
    leaseGeneration: record.leaseGeneration,
    updatedAt: record.updatedAt,
  };
  return {
    status: 202,
    headers: {
      location: `/v1/projects/${projectId}/operations/${record.operationId}`,
      etag: quotedEtag(run.stateVersion),
    },
    body: jsonBuffer(projection),
  };
}

export async function provideRunInput(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await withIdempotency(ctx, request, reply, request.operationSpec, async () => {
    if (!PROVIDE.Check(request.body)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
    }
    return enqueueMutRun(ctx, request, "APPLY_USER_INPUT");
  });
}

export async function requestRunRepair(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await withIdempotency(ctx, request, reply, request.operationSpec, async () => {
    if (!REPAIR.Check(request.body)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
    }
    return enqueueMutRun(ctx, request, "REQUEST_REPAIR");
  });
}

export async function cancelRun(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  await withIdempotency(ctx, request, reply, request.operationSpec, async () => {
    if (!CANCEL.Check(request.body)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
    }
    return enqueueMutRun(ctx, request, "REQUEST_CANCELLATION");
  });
}
