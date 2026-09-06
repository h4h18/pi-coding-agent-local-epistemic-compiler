import { type ServerOptions as HttpsServerOptions } from "node:https";
import Fastify, { type FastifyInstance } from "fastify";
import { type TypeBoxTypeProvider, TypeBoxValidatorCompiler } from "@fastify/type-provider-typebox";
import { Type } from "typebox";
import { HTTP_OPERATIONS, type HttpOperationSpec, type PrincipalScope } from "@pi-hec/contracts";
import { authorizeOperation, mapCertificateToScope } from "@pi-hec/security";
import { createProject, createWorkspace, getProject, setProjectTrust, updateProjectPolicy } from "./api/projects.js";
import {
  createProjectApprovalChallenge,
  createRunApprovalChallenge,
  commitProjectApproval,
  commitRunApproval,
} from "./api/approvals.js";
import { commitSnapshot, getBlob, missingBlobs, putBlob } from "./api/artifacts.js";
import { completeOperation, getOperation, heartbeatOperation } from "./api/operations.js";
import {
  createRunnerEnrollmentChallenge,
  enrollRunner,
  leaseRunnerJob,
  revokeRunner,
  rotateRunnerCertificate,
} from "./api/runners.js";
import {
  cancelRun,
  createRun,
  getRun,
  listRunArtifacts,
  listRunEvents,
  provideRunInput,
  requestRunRepair,
} from "./api/runs.js";
import type { ControlPlaneConfig } from "./config.js";
import { parseCaPrivateKey } from "./pki.js";
import {
  authorizedPeerCertificateDer,
  enforceMutationGuards,
  hostAdminScope,
  HttpSignal,
  sendError,
  toFastifyUrl,
  UnauthenticatedError,
  findOperation,
  verifyMutationOrThrow,
  type AppContext,
  type RegistryRoute,
} from "./orchestration/handlers.js";
import { recoverOperations } from "./orchestration/recovery.js";

declare module "fastify" {
  interface FastifyRequest {
    principalScope?: PrincipalScope;
    rawBody?: Buffer;
    operationSpec?: HttpOperationSpec;
  }
  interface FastifyInstance {
    pi: AppContext;
    registryRoutes: RegistryRoute[];
  }
  interface FastifyContextConfig {
    operationId?: string;
    registryPath?: string;
  }
}

type Handler = (
  ctx: AppContext,
  request: Parameters<typeof createProject>[1],
  reply: Parameters<typeof createProject>[2],
) => Promise<void>;

const HANDLERS: Record<string, Handler> = {
  createProject,
  getProject,
  updateProjectPolicy,
  setProjectTrust,
  createProjectApprovalChallenge,
  commitProjectApproval,
  createWorkspace,
  createRun,
  getRun,
  listRunEvents,
  listRunArtifacts,
  provideRunInput,
  requestRunRepair,
  cancelRun,
  createRunApprovalChallenge,
  commitRunApproval,
  missingBlobs,
  putBlob,
  getBlob,
  commitSnapshot,
  createRunnerEnrollmentChallenge,
  revokeRunner,
  enrollRunner,
  rotateRunnerCertificate,
  leaseRunnerJob,
  heartbeatOperation,
  completeOperation,
  getOperation,
};

function paramsSchema(path: string) {
  const names = [...path.matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1]).filter((name) => name !== undefined);
  const properties: Record<string, ReturnType<typeof Type.String>> = {};
  for (const name of names) {
    properties[name] = Type.String();
  }
  return Type.Object(properties, { additionalProperties: true });
}

export function buildApp(
  ctx: AppContext,
  mode: "mtls" | "enroll",
  https?: HttpsServerOptions,
): FastifyInstance {
  const app = Fastify({
    logger: false,
    exposeHeadRoutes: false,
    bodyLimit: ctx.blobLimit,
    trustProxy: false,
    ...(https === undefined ? {} : { https }),
  })
    .withTypeProvider<TypeBoxTypeProvider>()
    .setValidatorCompiler(TypeBoxValidatorCompiler);

  app.decorate("pi", ctx);
  const routes: RegistryRoute[] = [];
  app.decorate("registryRoutes", routes);

  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
    if (!Buffer.isBuffer(body)) {
      done(Object.assign(new Error("invalid json"), { statusCode: 400 }), undefined);
      return;
    }
    request.rawBody = body;
    try {
      done(null, JSON.parse(body.toString("utf8")));
    } catch {
      const error = Object.assign(new Error("invalid json"), { statusCode: 400 });
      done(error, undefined);
    }
  });
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer" }, (request, body, done) => {
    if (!Buffer.isBuffer(body)) {
      done(Object.assign(new Error("invalid body"), { statusCode: 400 }), undefined);
      return;
    }
    request.rawBody = body;
    done(null, body);
  });

  app.addHook("onRoute", (route) => {
    const operationId = route.config?.operationId;
    const registryPath = route.config?.registryPath;
    if (typeof operationId === "string" && typeof registryPath === "string") {
      const method = Array.isArray(route.method) ? route.method[0] : route.method;
      if (method !== undefined) {
        routes.push({ method, path: registryPath, operationId });
      }
    }
  });

  app.addHook("onRequest", async (request, reply) => {
    const operationId = (request.routeOptions.config as { operationId?: string }).operationId;
    if (typeof operationId !== "string") {
      await sendError(reply, 404, "NOT_FOUND", "not found");
      return reply;
    }
    try {
      request.operationSpec = findOperation(operationId);
    } catch {
      await sendError(reply, 404, "NOT_FOUND", "not found");
      return reply;
    }
    const der = authorizedPeerCertificateDer(request.raw.socket);
    if (der !== undefined) {
      try {
        const mapped = mapCertificateToScope(ctx.identity, { der, now: ctx.clock() });
        if (mapped.kind === "authenticated") {
          request.principalScope = mapped.scope;
        }
      } catch {
        // Fail closed: leave principalScope unset so authorizeOperation returns 401.
      }
    }
    return undefined;
  });

  app.addHook("preHandler", async (request, reply) => {
    const spec = request.operationSpec;
    if (spec === undefined) {
      await sendError(reply, 404, "NOT_FOUND", "not found");
      return reply;
    }
    const params = request.params as Record<string, string>;
    const decision = authorizeOperation({
      scope: request.principalScope,
      operation: spec,
      params,
    });
    if (decision.kind === "unauthenticated") {
      await sendError(reply, 401, "AUTHENTICATION_FAILED", "authentication failed");
      return reply;
    }
    if (decision.kind === "not_found") {
      await sendError(reply, 404, "NOT_FOUND", "not found");
      return reply;
    }
    try {
      enforceMutationGuards(spec, request, ctx.jsonLimit);
      verifyMutationOrThrow(ctx, request, spec);
    } catch (error) {
      if (error instanceof HttpSignal) {
        await sendError(reply, error.status, error.code, error.message, {
          ...(error.operationId === undefined ? {} : { operationId: error.operationId }),
        });
        return reply;
      }
      if (error instanceof UnauthenticatedError) {
        await sendError(reply, 401, "AUTHENTICATION_FAILED", "authentication failed");
        return reply;
      }
      throw error;
    }
    return undefined;
  });

  app.setErrorHandler(async (error, request, reply) => {
    const status =
      typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
        ? error.statusCode
        : 500;
    if (status === 403) {
      await sendError(reply, 404, "NOT_FOUND", "not found");
      return;
    }
    if (status === 400) {
      if (request.operationSpec?.operationId === "putBlob") {
        await sendError(reply, 422, "CONTENT_DIGEST_MISMATCH", "digest mismatch");
        return;
      }
      await sendError(reply, 400, "SCHEMA_INVALID", "schema invalid");
      return;
    }
    if (status === 413) {
      await sendError(reply, 413, "CONTENT_TOO_LARGE", "body too large");
      return;
    }
    if (status === 415) {
      await sendError(reply, 415, "MEDIA_TYPE_UNSUPPORTED", "media type unsupported");
      return;
    }
    void request;
    await sendError(reply, status >= 400 && status < 600 ? status : 500, "INTERNAL", "internal error");
  });

  for (const spec of HTTP_OPERATIONS) {
    if (mode === "enroll" && spec.operationId !== "enrollRunner") {
      continue;
    }
    if (mode === "mtls" && spec.operationId === "enrollRunner") {
      continue;
    }
    const handler = HANDLERS[spec.operationId];
    if (handler === undefined) {
      throw new Error(`missing handler ${spec.operationId}`);
    }
    app.route({
      method: spec.method,
      url: toFastifyUrl(spec.path),
      schema:
        spec.method === "GET"
          ? { params: paramsSchema(spec.path) }
          : { params: paramsSchema(spec.path), body: Type.Unknown() },
      config: { registryPath: spec.path, operationId: spec.operationId },
      handler: async (request, reply) => handler(ctx, request, reply),
    });
  }

  return app;
}

export type ListeningControlPlane = {
  mtls: FastifyInstance;
  enroll: FastifyInstance;
  mtlsServer: FastifyInstance["server"];
  enrollServer: FastifyInstance["server"];
  mtlsUrl: string;
  enrollUrl: string;
  ctx: AppContext;
  close: () => Promise<void>;
};

export async function listenControlPlane(
  ctx: AppContext,
  config: ControlPlaneConfig,
): Promise<ListeningControlPlane> {
  ctx.hostCaCertPem = config.hostCaCertPem;
  ctx.hostCaPrivateKey = parseCaPrivateKey(config.hostCaPrivateKeyPem);
  recoverOperations({
    store: ctx.store,
    adminScope: hostAdminScope(ctx),
    now: ctx.clock(),
    errorDigest: ctx.hostPolicyDigest,
  });
  const tlsShared = {
    key: config.tls.keyPem,
    cert: config.tls.certPem,
    ca: config.tls.caPem,
    minVersion: "TLSv1.3" as const,
    maxVersion: "TLSv1.3" as const,
  };
  const mtls = buildApp(ctx, "mtls", {
    ...tlsShared,
    requestCert: true,
    rejectUnauthorized: true,
  });
  const enroll = buildApp(ctx, "enroll", {
    ...tlsShared,
    requestCert: false,
    rejectUnauthorized: true,
  });
  await mtls.listen({ host: config.host, port: config.mtlsPort });
  await enroll.listen({ host: config.host, port: config.enrollPort });
  const mtlsAddress = mtls.server.address();
  const enrollAddress = enroll.server.address();
  if (mtlsAddress === null || enrollAddress === null || typeof mtlsAddress === "string" || typeof enrollAddress === "string") {
    throw new Error("failed to bind control-plane listeners");
  }
  if (!("setSecureContext" in mtls.server) || !("setSecureContext" in enroll.server)) {
    throw new Error("expected https servers");
  }
  return {
    mtls,
    enroll,
    mtlsServer: mtls.server,
    enrollServer: enroll.server,
    mtlsUrl: `https://${config.host}:${String(mtlsAddress.port)}`,
    enrollUrl: `https://${config.host}:${String(enrollAddress.port)}`,
    ctx,
    close: async () => {
      await mtls.close();
      await enroll.close();
    },
  };
}
