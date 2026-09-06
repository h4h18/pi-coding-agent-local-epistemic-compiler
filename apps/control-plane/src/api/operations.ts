import { Compile } from "typebox/compile";
import { OperationHeartbeatRequestSchema, OperationResultRequestSchema } from "@pi-hec/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  HttpSignal,
  asObjectDigest,
  mapStoreError,
  parseJsonBody,
  quotedEtag,
  requireScope,
  type AppContext,
} from "../orchestration/handlers.js";

const HEARTBEAT = Compile(OperationHeartbeatRequestSchema);
const RESULT = Compile(OperationResultRequestSchema);

function requireOwningRunner(request: FastifyRequest, leaseOwner: string | undefined): void {
  const scope = requireScope(request);
  if (scope.identityKind !== "runner") {
    return;
  }
  if (leaseOwner === undefined || leaseOwner !== scope.principalId) {
    throw new HttpSignal(404, "NOT_FOUND", "not found");
  }
}

export async function getOperation(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const operationId = (request.params as { operationId: string }).operationId;
    const record = ctx.store.getOperation(ctx.store.toProjectScope(scope, projectId), operationId);
    requireOwningRunner(request, record.leaseOwner);
    const etag = quotedEtag(record.leaseGeneration);
    void reply.header("etag", etag).header("cache-control", "no-store");
    if (request.headers["if-none-match"] === etag) {
      await reply.code(304).send();
      return;
    }
    await reply.code(200).send({
      schemaVersion: 1,
      projectId,
      operationId: record.operationId,
      runId: record.runId,
      kind: record.operationKind,
      state: record.state,
      leaseGeneration: record.leaseGeneration,
      ...(record.resultDigest === undefined ? {} : { resultObjectDigest: record.resultDigest }),
      ...(record.errorDigest === undefined ? {} : { errorObjectDigest: record.errorDigest }),
      updatedAt: record.updatedAt,
    });
  } catch (error) {
    await mapStoreError(reply, error);
  }
}

export async function heartbeatOperation(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    const body = parseJsonBody(request);
    if (!HEARTBEAT.Check(body)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
    }
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const operationId = (request.params as { operationId: string }).operationId;
    const projectScope = ctx.store.toProjectScope(scope, projectId);
    const record = ctx.store.getOperation(projectScope, operationId);
    requireOwningRunner(request, record.leaseOwner);
    const now = ctx.clock();
    const leaseUntil = new Date(Date.parse(now) + 30_000).toISOString();
    ctx.store.heartbeatOperation(projectScope, {
      operationId,
      token: body.leaseToken,
      owner: scope.principalId,
      leaseUntil,
      now,
      leaseGeneration: body.leaseGeneration,
      observedInputDigest: body.observedInputObjectDigest,
    });
    const runner = ctx.store.getRunnerByPrincipalId(scope.principalId);
    const cancellationRequested = runner === undefined || runner.revokedAt !== undefined;
    void reply.header("cache-control", "no-store");
    await reply
      .code(200)
      .send({ schemaVersion: 1, leaseExpiresAt: leaseUntil, cancellationRequested });
  } catch (error) {
    await mapStoreError(reply, error);
  }
}

export async function completeOperation(
  ctx: AppContext,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  try {
    const body = parseJsonBody(request);
    if (!RESULT.Check(body)) {
      throw new HttpSignal(400, "SCHEMA_INVALID", "schema invalid");
    }
    const scope = requireScope(request);
    const projectId = (request.params as { projectId: string }).projectId;
    const operationId = (request.params as { operationId: string }).operationId;
    const projectScope = ctx.store.toProjectScope(scope, projectId);
    const current = ctx.store.getOperation(projectScope, operationId);
    requireOwningRunner(request, current.leaseOwner);
    const now = ctx.clock();
    let record;
    switch (body.outcome) {
      case "SUCCEEDED":
        record = ctx.store.completeOperation(projectScope, {
          operationId,
          token: body.leaseToken,
          owner: scope.principalId,
          resultDigest: asObjectDigest(body.resultObjectDigest),
          now,
          updatedAt: now,
          leaseGeneration: body.leaseGeneration,
        });
        break;
      case "FAILED":
        record = ctx.store.failOperation(projectScope, {
          operationId,
          token: body.leaseToken,
          owner: scope.principalId,
          errorDigest: asObjectDigest(body.errorObjectDigest),
          now,
          updatedAt: now,
          leaseGeneration: body.leaseGeneration,
        });
        break;
      case "UNKNOWN":
        ctx.store.heartbeatOperation(projectScope, {
          operationId,
          token: body.leaseToken,
          owner: scope.principalId,
          leaseUntil: new Date(Date.parse(now) + 30_000).toISOString(),
          now,
          leaseGeneration: body.leaseGeneration,
          observedInputDigest: current.inputDigest,
        });
        record = ctx.store.markOperationUnknown(projectScope, {
          operationId,
          errorDigest: asObjectDigest(body.errorObjectDigest),
          updatedAt: now,
        });
        break;
      default: {
        const exhaustive: never = body;
        throw new HttpSignal(
          400,
          "SCHEMA_INVALID",
          `unhandled union: ${JSON.stringify(exhaustive)}`,
        );
      }
    }
    void reply
      .header("etag", quotedEtag(record.leaseGeneration))
      .header("cache-control", "no-store");
    await reply.code(200).send({
      schemaVersion: 1,
      projectId,
      operationId: record.operationId,
      runId: record.runId,
      kind: record.operationKind,
      state: record.state,
      leaseGeneration: record.leaseGeneration,
      ...(record.resultDigest === undefined ? {} : { resultObjectDigest: record.resultDigest }),
      ...(record.errorDigest === undefined ? {} : { errorObjectDigest: record.errorDigest }),
      updatedAt: record.updatedAt,
    });
  } catch (error) {
    await mapStoreError(reply, error);
  }
}
