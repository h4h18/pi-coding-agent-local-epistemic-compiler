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
import {
  HttpSignal,
  asRunId,
  jsonBuffer,
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

function queryField(query: object, key: string): unknown {
  if (!Object.hasOwn(query, key)) {
    return undefined;
  }
  return Reflect.get(query, key);
}

function coerceUintQuery(raw: unknown): { after?: number; limit?: number } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "invalid cursor");
  }
  const afterRaw = queryField(raw, "after");
  const limitRaw = queryField(raw, "limit");
  const after =
    afterRaw === undefined ? undefined : Number.parseInt(typeof afterRaw === "string" ? afterRaw : String(afterRaw), 10);
  const limit =
    limitRaw === undefined ? undefined : Number.parseInt(typeof limitRaw === "string" ? limitRaw : String(limitRaw), 10);
  if (after !== undefined && !Number.isFinite(after)) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "invalid cursor");
  }
  if (limit !== undefined && !Number.isFinite(limit)) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "invalid cursor");
  }
  return {
    ...(after === undefined ? {} : { after }),
    ...(limit === undefined ? {} : { limit }),
  };
}

function coerceStringQuery(raw: unknown): { after?: string; limit?: number } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "invalid cursor");
  }
  const afterRaw = queryField(raw, "after");
  const limitRaw = queryField(raw, "limit");
  const after = afterRaw === undefined ? undefined : String(afterRaw);
  const limit =
    limitRaw === undefined ? undefined : Number.parseInt(typeof limitRaw === "string" ? limitRaw : String(limitRaw), 10);
  if (limit !== undefined && !Number.isFinite(limit)) {
    throw new HttpSignal(400, "SCHEMA_INVALID", "invalid cursor");
  }
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
    const projection = ctx.store.createRun(projectScope, {
      runId: asRunId(runId),
      workspaceId: request.body.workspaceId,
      taskEnvelopeDigest: taskDigest,
      createdAt: now,
    });
    return {
      status: 201,
      headers: {
        location: `/v1/projects/${projectId}/runs/${runId}`,
        etag: quotedEtag(projection.stateVersion),
      },
      body: jsonBuffer(projection),
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
    const projection = ctx.store.getRun(ctx.store.toProjectScope(scope, projectId), runId);
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
    const sliced = events.filter((event) => event.sequence > after).slice(0, limit);
    const last = sliced[sliced.length - 1];
    void reply.header("cache-control", "no-store");
    await reply.code(200).send({
      schemaVersion: 1,
      events: sliced.map((event) => ({
        schemaVersion: 1,
        eventId: event.eventId,
        eventType: event.eventType,
        projectId,
        runId: event.runId,
        sequence: event.sequence,
        previousState: "CREATED",
        nextState: "CREATED",
        actorType: event.actorType,
        actorId: event.actorId,
        inputArtifactObjectDigests: [],
        outputArtifactObjectDigests: [],
        reasonCode: "phase",
        occurredAt: event.occurredAt,
      })),
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
